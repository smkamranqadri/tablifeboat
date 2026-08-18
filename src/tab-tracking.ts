import {
  createDurableId,
  type RecoverySet,
  type TrackedTab,
  type WindowGrouping,
} from "./recovery-model.js";
import type { RecoveryStore } from "./recovery-store.js";
import { comparableAddress, isWebTab } from "./web-tab.js";

// Chromium may report the last tab's removal before reporting its window's removal.
// Hold ambiguous removals briefly so the authoritative Window Closure event can win.
export const WINDOW_CLOSURE_SETTLING_MS = 100;

interface PendingTabRemoval {
  timer: ReturnType<typeof setTimeout>;
}

type PendingWindowRemovals = Map<number, Map<number, PendingTabRemoval>>;

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

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    handleListenerOperation(
      "Tab identity replacement",
      adoptReplacedTabId(store, addedTabId, removedTabId),
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
    const lookup = await getNormalWindowTabs(tab.windowId);
    if (lookup.kind === "gone") {
      return;
    }

    const windowTabs = lookup.kind === "normal" ? lookup.tabs : undefined;
    const existing = set.windows
      .flatMap((window) => window.tabs)
      .find((trackedTab) => trackedTab.browserTabId === tab.id);
    if (!windowTabs || !isWebTab(tab)) {
      const isPendingManualRecovery =
        existing !== undefined && tab.pendingUrl === existing.url;
      if (tab.id !== undefined && !isPendingManualRecovery) {
        removeTrackedTab(set, tab.id);
      }
      if (windowTabs && reindexWindow) {
        reindexWindowGrouping(set, tab.windowId, windowTabs);
      }
      return;
    }

    if (existing) {
      delete existing.missingReason;
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
    const adopted = findAdoptableTrackedTab(grouping, tab, windowTabs);

    if (adopted) {
      adopted.browserTabId = tab.id;
      delete adopted.missingReason;
      adopted.title = tab.title ?? tab.url;
      adopted.url = tab.url;
      adopted.placement = {
        index: tab.index,
        pinned: tab.pinned,
      };
    } else {
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
    }
    grouping.tabs.sort((left, right) => left.placement.index - right.placement.index);

    if (reindexWindow) {
      reindexWindowGrouping(set, tab.windowId, windowTabs);
    }
  });
}

// Chromium re-identifies a tab in place when it discards or prerender-swaps it,
// and the browser tab id it announces afterwards is one this Window Grouping has
// never seen. Without adoption every such swap mints a duplicate record and
// strands the original as a Missing Tab that no open tab can ever reclaim.
export function findAdoptableTrackedTab(
  grouping: WindowGrouping,
  tab: chrome.tabs.Tab & { id: number; url: string },
  windowTabs: chrome.tabs.Tab[],
): TrackedTab | undefined {
  const liveTabIds = new Set(
    windowTabs.flatMap((windowTab) =>
      windowTab.id === undefined ? [] : [windowTab.id],
    ),
  );

  const address = comparableAddress(tab.url);
  return grouping.tabs.find(
    (candidate) =>
      comparableAddress(candidate.url) === address &&
      candidate.missingReason !== "window-closure" &&
      (candidate.browserTabId === undefined ||
        !liveTabIds.has(candidate.browserTabId)),
  );
}

function adoptReplacedTabId(
  store: RecoveryStore,
  addedTabId: number,
  removedTabId: number,
): Promise<RecoverySet> {
  return store.update(async (set) => {
    const trackedTab = set.windows
      .flatMap((grouping) => grouping.tabs)
      .find((candidate) => candidate.browserTabId === removedTabId);
    if (!trackedTab) {
      return;
    }

    let browserTab: chrome.tabs.Tab | undefined;
    try {
      browserTab = await chrome.tabs.get(addedTabId);
    } catch {
      browserTab = undefined;
    }
    if (browserTab === undefined || !isWebTab(browserTab)) {
      removeTrackedTab(set, removedTabId);
      return;
    }

    trackedTab.browserTabId = addedTabId;
    delete trackedTab.missingReason;
    trackedTab.title = browserTab.title ?? browserTab.url;
    trackedTab.url = browserTab.url;
    trackedTab.placement = {
      index: browserTab.index,
      pinned: browserTab.pinned,
    };
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

  // A reconciliation landing inside the settling delay strips the association
  // this removal steers by, so the durable record id is resolved while the
  // Tracked Tab still points at the tab the browser just closed.
  const closedRecordId = readClosedRecordId(store, browserTabId);

  const timer = setTimeout(() => {
    pendingTabs.delete(browserTabId);
    if (pendingTabs.size === 0) {
      pendingWindowRemovals.delete(windowId);
    }

    handleListenerOperation(
      "Individual Tab Closure",
      removeIndividuallyClosedTab(store, closedRecordId, browserTabId, windowId),
    );
  }, WINDOW_CLOSURE_SETTLING_MS);

  pendingTabs.set(browserTabId, { timer });
  pendingWindowRemovals.set(windowId, pendingTabs);
}

function readClosedRecordId(
  store: RecoveryStore,
  browserTabId: number,
): Promise<string | undefined> {
  return store
    .read()
    .then(
      (set) =>
        set.windows
          .flatMap((grouping) => grouping.tabs)
          .find((tab) => tab.browserTabId === browserTabId)?.recordId,
    )
    .catch(() => undefined);
}

// The captured record id stands in for the closed tab only while it stands for
// no other one: a reconciliation inside the settling delay can rebind it to a
// live tab, and removing it then would strand that tab untracked.
function recordIdStillClosed(
  set: RecoverySet,
  recordId: string | undefined,
  browserTabId: number,
): string | undefined {
  const reboundToLiveTab = set.windows
    .flatMap((grouping) => grouping.tabs)
    .some(
      (tab) =>
        tab.recordId === recordId &&
        tab.browserTabId !== undefined &&
        tab.browserTabId !== browserTabId,
    );
  if (reboundToLiveTab) {
    return undefined;
  }
  return recordId;
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
  closedRecordId: Promise<string | undefined>,
  browserTabId: number,
  windowId: number,
): Promise<RecoverySet> {
  return store.update(async (set) => {
    const resolvedRecordId = await closedRecordId.catch(() => undefined);
    removeTrackedTab(
      set,
      browserTabId,
      recordIdStillClosed(set, resolvedRecordId, browserTabId),
    );
    try {
      const lookup = await getNormalWindowTabs(windowId);
      if (lookup.kind === "normal") {
        reindexWindowGrouping(set, windowId, lookup.tabs);
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
    tab.missingReason = "window-closure";
  }
}

// A window that has already gone is not the same as a window this extension
// never tracks: Window Closure owns the first case and must be left to preserve
// the Window Grouping that tab events arriving too late would otherwise delete.
type WindowTabsLookup =
  | { kind: "normal"; tabs: chrome.tabs.Tab[] }
  | { kind: "other-type" }
  | { kind: "gone" };

async function getNormalWindowTabs(windowId: number): Promise<WindowTabsLookup> {
  let browserWindow: chrome.windows.Window;
  try {
    browserWindow = await chrome.windows.get(windowId);
  } catch {
    return { kind: "gone" };
  }

  if (browserWindow.type !== "normal") {
    return { kind: "other-type" };
  }
  return { kind: "normal", tabs: await chrome.tabs.query({ windowId }) };
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
    const lookup = await getNormalWindowTabs(browserWindowId);
    if (lookup.kind === "normal") {
      reindexWindowGrouping(set, browserWindowId, lookup.tabs);
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

    const lookup = await getNormalWindowTabs(browserTab.windowId);
    if (lookup.kind === "gone") {
      return;
    }
    const windowTabs = lookup.kind === "normal" ? lookup.tabs : undefined;

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
    delete trackedTab.missingReason;
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

function removeTrackedTab(
  set: RecoverySet,
  browserTabId: number,
  recordId?: string,
): void {
  for (const grouping of set.windows) {
    grouping.tabs = grouping.tabs.filter(
      (tab) => tab.browserTabId !== browserTabId && tab.recordId !== recordId,
    );
  }
  set.windows = set.windows.filter((grouping) => grouping.tabs.length > 0);
}
