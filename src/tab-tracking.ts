import {
  createDurableId,
  type RecoverySet,
  type TrackedTab,
  type WindowGrouping,
} from "./recovery-model.js";
import type { RecoveryStore } from "./recovery-store.js";

// Chromium may report the last tab's removal before reporting its window's removal.
// Hold ambiguous removals briefly so the authoritative Window Closure event can win.
export const WINDOW_CLOSURE_SETTLING_MS = 100;

interface PendingTabRemoval {
  timer: ReturnType<typeof setTimeout>;
}

type PendingWindowRemovals = Map<number, Map<number, PendingTabRemoval>>;

export function isWebTab(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & {
  id: number;
  url: string;
} {
  if (tab.incognito || tab.id === undefined || tab.url === undefined) {
    return false;
  }

  try {
    const protocol = new URL(tab.url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function startTabTracking(store: RecoveryStore): void {
  const pendingWindowRemovals: PendingWindowRemovals = new Map();

  chrome.tabs.onCreated.addListener((tab) => {
    handleListenerOperation("tab creation", updateTrackedTab(store, tab, true));
  });

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    handleListenerOperation(
      "tab update",
      updateTrackedTab(store, tab, changeInfo.pinned !== undefined),
    );
  });

  chrome.tabs.onMoved.addListener((_tabId, moveInfo) => {
    handleListenerOperation(
      "Tab Placement reorder",
      reindexTrackedWindow(store, moveInfo.windowId),
    );
  });

  chrome.tabs.onDetached.addListener((_tabId, detachInfo) => {
    handleListenerOperation(
      "Tab Placement detachment",
      reindexTrackedWindow(store, detachInfo.oldWindowId),
    );
  });

  chrome.tabs.onAttached.addListener((tabId) => {
    handleListenerOperation(
      "Tab Placement attachment",
      attachTrackedTab(store, tabId),
    );
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (removeInfo.isWindowClosing) {
      handleWindowClosure(store, pendingWindowRemovals, removeInfo.windowId);
      return;
    }

    scheduleIndividualTabClosure(
      store,
      pendingWindowRemovals,
      tabId,
      removeInfo.windowId,
    );
  });

  chrome.windows.onRemoved.addListener((windowId) => {
    handleWindowClosure(store, pendingWindowRemovals, windowId);
  });
}

function updateTrackedTab(
  store: RecoveryStore,
  tab: chrome.tabs.Tab,
  reindexWindow = false,
): Promise<RecoverySet> {
  return store.update(async (set) => {
    const windowTabs = await getNormalWindowTabs(tab.windowId);
    if (!windowTabs || !isWebTab(tab)) {
      if (tab.id !== undefined) {
        removeTrackedTab(set, tab.id);
      }
      if (windowTabs && reindexWindow) {
        reindexWindowGrouping(set, tab.windowId, windowTabs);
      }
      return;
    }

    const existing = set.windows
      .flatMap((window) => window.tabs)
      .find((trackedTab) => trackedTab.browserTabId === tab.id);

    if (existing) {
      existing.title = tab.title ?? tab.url;
      existing.url = tab.url;
      existing.placement = {
        index: tab.index,
        pinned: tab.pinned,
      };
      if (reindexWindow) {
        reindexWindowGrouping(set, tab.windowId, windowTabs);
      }
      return;
    }

    const grouping = getOrCreateWindowGrouping(set, tab.windowId);

    const trackedTab: TrackedTab = {
      recordId: createDurableId(),
      browserTabId: tab.id,
      title: tab.title ?? tab.url,
      url: tab.url,
      placement: {
        index: tab.index,
        pinned: tab.pinned,
      },
    };
    grouping.tabs.push(trackedTab);
    grouping.tabs.sort((left, right) => left.placement.index - right.placement.index);

    if (reindexWindow) {
      reindexWindowGrouping(set, tab.windowId, windowTabs);
    }
  });
}

function scheduleIndividualTabClosure(
  store: RecoveryStore,
  pendingWindowRemovals: PendingWindowRemovals,
  browserTabId: number,
  windowId: number,
): void {
  const pendingTabs = pendingWindowRemovals.get(windowId) ?? new Map();
  const existing = pendingTabs.get(browserTabId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  const timer = setTimeout(() => {
    pendingTabs.delete(browserTabId);
    if (pendingTabs.size === 0) {
      pendingWindowRemovals.delete(windowId);
    }

    handleListenerOperation(
      "Individual Tab Closure",
      removeIndividuallyClosedTab(store, browserTabId, windowId),
    );
  }, WINDOW_CLOSURE_SETTLING_MS);

  pendingTabs.set(browserTabId, { timer });
  pendingWindowRemovals.set(windowId, pendingTabs);
}

function handleWindowClosure(
  store: RecoveryStore,
  pendingWindowRemovals: PendingWindowRemovals,
  browserWindowId: number,
): void {
  const pendingTabs = pendingWindowRemovals.get(browserWindowId);
  if (pendingTabs) {
    for (const pending of pendingTabs.values()) {
      clearTimeout(pending.timer);
    }
    pendingWindowRemovals.delete(browserWindowId);
  }

  handleListenerOperation(
    "Window Closure",
    preserveClosedWindowGrouping(store, browserWindowId),
  );
}

function removeIndividuallyClosedTab(
  store: RecoveryStore,
  browserTabId: number,
  windowId: number,
): Promise<RecoverySet> {
  return store.update(async (set) => {
    removeTrackedTab(set, browserTabId);
    try {
      const windowTabs = await getNormalWindowTabs(windowId);
      if (windowTabs) {
        reindexWindowGrouping(set, windowId, windowTabs);
      }
    } catch (error: unknown) {
      console.error(
        "Failed to reindex Window Grouping after Individual Tab Closure",
        error,
      );
    }
  });
}

function preserveClosedWindowGrouping(
  store: RecoveryStore,
  browserWindowId: number,
): Promise<RecoverySet> {
  return store.update((set) => preserveWindowGrouping(set, browserWindowId));
}

function preserveWindowGrouping(set: RecoverySet, browserWindowId: number): void {
  const grouping = set.windows.find(
    (candidate) => candidate.browserWindowId === browserWindowId,
  );
  if (!grouping) {
    return;
  }

  delete grouping.browserWindowId;
  for (const tab of grouping.tabs) {
    delete tab.browserTabId;
  }
}

async function getNormalWindowTabs(windowId: number): Promise<chrome.tabs.Tab[] | undefined> {
  const browserWindow = await chrome.windows.get(windowId);
  return browserWindow.type === "normal"
    ? chrome.tabs.query({ windowId })
    : undefined;
}

function handleListenerOperation(context: string, operation: Promise<unknown>): void {
  operation.catch((error: unknown) => {
    console.error(`Failed to track ${context}`, error);
  });
}

function reindexWindowGrouping(
  set: RecoverySet,
  windowId: number,
  windowTabs: chrome.tabs.Tab[],
): void {
  const grouping = set.windows.find(
    (window) => window.browserWindowId === windowId,
  );
  if (!grouping) {
    return;
  }

  const currentTabs = new Map(
    windowTabs.flatMap((tab) => (tab.id === undefined ? [] : [[tab.id, tab] as const])),
  );

  for (const trackedTab of grouping.tabs) {
    const currentTab =
      trackedTab.browserTabId === undefined
        ? undefined
        : currentTabs.get(trackedTab.browserTabId);
    if (currentTab) {
      trackedTab.placement.index = currentTab.index;
    }
  }

  grouping.tabs.sort((left, right) => left.placement.index - right.placement.index);
}

function reindexTrackedWindow(
  store: RecoveryStore,
  browserWindowId: number,
): Promise<RecoverySet> {
  return store.update(async (set) => {
    const windowTabs = await getNormalWindowTabs(browserWindowId);
    if (windowTabs) {
      reindexWindowGrouping(set, browserWindowId, windowTabs);
    }
  });
}

function attachTrackedTab(
  store: RecoveryStore,
  browserTabId: number,
): Promise<RecoverySet> {
  return store.update(async (set) => {
    let browserTab: chrome.tabs.Tab;
    try {
      browserTab = await chrome.tabs.get(browserTabId);
    } catch {
      return;
    }

    const windowTabs = await getNormalWindowTabs(browserTab.windowId);

    const sourceGrouping = set.windows.find((grouping) =>
      grouping.tabs.some((tab) => tab.browserTabId === browserTabId),
    );
    const trackedTab = sourceGrouping?.tabs.find(
      (tab) => tab.browserTabId === browserTabId,
    );

    if (!windowTabs || !isWebTab(browserTab)) {
      if (trackedTab) {
        removeTrackedTab(set, browserTabId);
      }
      return;
    }
    if (!sourceGrouping || !trackedTab) {
      return;
    }

    sourceGrouping.tabs = sourceGrouping.tabs.filter(
      (tab) => tab.browserTabId !== browserTabId,
    );

    const destinationGrouping = getOrCreateWindowGrouping(set, browserTab.windowId);

    trackedTab.title = browserTab.title ?? browserTab.url;
    trackedTab.url = browserTab.url;
    trackedTab.placement = {
      index: browserTab.index,
      pinned: browserTab.pinned,
    };
    destinationGrouping.tabs.push(trackedTab);
    set.windows = set.windows.filter((grouping) => grouping.tabs.length > 0);
    reindexWindowGrouping(set, browserTab.windowId, windowTabs);
  });
}

function getOrCreateWindowGrouping(
  set: RecoverySet,
  browserWindowId: number,
): WindowGrouping {
  const existing = set.windows.find(
    (grouping) => grouping.browserWindowId === browserWindowId,
  );
  if (existing) {
    return existing;
  }

  const grouping: WindowGrouping = {
    groupingId: createDurableId(),
    browserWindowId,
    tabs: [],
  };
  set.windows.push(grouping);
  return grouping;
}

function removeTrackedTab(set: RecoverySet, browserTabId: number): void {
  for (const grouping of set.windows) {
    grouping.tabs = grouping.tabs.filter((tab) => tab.browserTabId !== browserTabId);
  }
  set.windows = set.windows.filter((grouping) => grouping.tabs.length > 0);
}
