interface TabPlacement {
  windowId: number;
  index: number;
  pinned: boolean;
}

interface TrackedTab {
  browserTabId: number;
  title: string;
  url: string;
  placement: TabPlacement;
}

interface RecoveryWindow {
  windowId: number;
  tabs: TrackedTab[];
}

interface RecoverySet {
  version: 1;
  windows: RecoveryWindow[];
}

const EMPTY_RECOVERY_SET: RecoverySet = {
  version: 1,
  windows: [],
};

let installationCapture = Promise.resolve();

function isWebTab(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & {
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

async function captureEligibleWebTabs(): Promise<void> {
  const tabs = await chrome.tabs.query({ windowType: "normal" });
  const windows = new Map<number, TrackedTab[]>();

  for (const tab of tabs) {
    if (!isWebTab(tab)) {
      continue;
    }

    const trackedTab: TrackedTab = {
      browserTabId: tab.id,
      title: tab.title ?? tab.url,
      url: tab.url,
      placement: {
        windowId: tab.windowId,
        index: tab.index,
        pinned: tab.pinned,
      },
    };
    const windowTabs = windows.get(tab.windowId) ?? [];
    windowTabs.push(trackedTab);
    windows.set(tab.windowId, windowTabs);
  }

  const recoverySet: RecoverySet = {
    version: 1,
    windows: Array.from(windows, ([windowId, windowTabs]) => ({
      windowId,
      tabs: windowTabs.sort((left, right) => left.placement.index - right.placement.index),
    })),
  };

  await chrome.storage.local.set({ recoverySet });
}

async function getProtectedTabCount(): Promise<number> {
  await installationCapture;
  const { recoverySet = EMPTY_RECOVERY_SET } = (await chrome.storage.local.get(
    "recoverySet",
  )) as { recoverySet?: RecoverySet };

  return recoverySet.windows.reduce((count, window) => count + window.tabs.length, 0);
}

chrome.runtime.onInstalled.addListener(() => {
  installationCapture = captureEligibleWebTabs();
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "getRecoverySummary"
  ) {
    return undefined;
  }

  void getProtectedTabCount().then((protectedTabCount) => {
    sendResponse({ protectedTabCount });
  });

  return true;
});
