import {
  createDurableId,
  type RecoverySet,
  type TrackedTab,
} from "./recovery-model.js";
import type { RecoveryStore } from "./recovery-store.js";

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
  chrome.tabs.onCreated.addListener((tab) => {
    void updateTrackedTab(store, tab, true);
  });

  chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
    void updateTrackedTab(store, tab);
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (removeInfo.isWindowClosing) {
      return;
    }

    void removeIndividuallyClosedTab(store, tabId, removeInfo.windowId);
  });
}

async function updateTrackedTab(
  store: RecoveryStore,
  tab: chrome.tabs.Tab,
  reindexWindow = false,
): Promise<void> {
  const windowTabs = await getNormalWindowTabs(tab.windowId);

  await store.update((set) => {
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
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned,
      };
      if (reindexWindow) {
        reindexWindowGrouping(set, tab.windowId, windowTabs);
      }
      return;
    }

    let grouping = set.windows.find((window) => window.windowId === tab.windowId);
    if (!grouping) {
      grouping = {
        groupingId: createDurableId(),
        windowId: tab.windowId,
        tabs: [],
      };
      set.windows.push(grouping);
    }

    const trackedTab: TrackedTab = {
      recordId: createDurableId(),
      browserTabId: tab.id,
      title: tab.title ?? tab.url,
      url: tab.url,
      placement: {
        windowId: tab.windowId,
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

async function removeIndividuallyClosedTab(
  store: RecoveryStore,
  browserTabId: number,
  windowId: number,
): Promise<void> {
  const windowTabs = await getNormalWindowTabs(windowId);

  await store.update((set) => {
    removeTrackedTab(set, browserTabId);

    if (!windowTabs) {
      return;
    }

    reindexWindowGrouping(set, windowId, windowTabs);
  });
}

async function getNormalWindowTabs(windowId: number): Promise<chrome.tabs.Tab[] | undefined> {
  try {
    const browserWindow = await chrome.windows.get(windowId, { populate: true });
    return browserWindow.type === "normal" ? browserWindow.tabs ?? [] : undefined;
  } catch {
    return undefined;
  }
}

function reindexWindowGrouping(
  set: RecoverySet,
  windowId: number,
  windowTabs: chrome.tabs.Tab[],
): void {
  const grouping = set.windows.find((window) => window.windowId === windowId);
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

function removeTrackedTab(set: RecoverySet, browserTabId: number): void {
  for (const grouping of set.windows) {
    grouping.tabs = grouping.tabs.filter((tab) => tab.browserTabId !== browserTabId);
  }
  set.windows = set.windows.filter((grouping) => grouping.tabs.length > 0);
}
