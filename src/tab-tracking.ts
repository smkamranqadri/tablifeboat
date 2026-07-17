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
    void updateTrackedTab(store, tab);
  });

  chrome.tabs.onUpdated.addListener((_tabId, _changeInfo, tab) => {
    void updateTrackedTab(store, tab);
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (removeInfo.isWindowClosing) {
      return;
    }

    void store.update((set) => removeTrackedTab(set, tabId));
  });
}

async function updateTrackedTab(store: RecoveryStore, tab: chrome.tabs.Tab): Promise<void> {
  await store.update((set) => {
    if (!isWebTab(tab)) {
      if (tab.id !== undefined) {
        removeTrackedTab(set, tab.id);
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
  });
}

function removeTrackedTab(set: RecoverySet, browserTabId: number): void {
  for (const grouping of set.windows) {
    grouping.tabs = grouping.tabs.filter((tab) => tab.browserTabId !== browserTabId);
  }
  set.windows = set.windows.filter((grouping) => grouping.tabs.length > 0);
}
