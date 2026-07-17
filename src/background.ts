import {
  createDurableId,
  type RecoverySet,
  type TrackedTab,
} from "./recovery-model.js";
import { RecoveryStore } from "./recovery-store.js";
import {
  getRecoveryStatus,
  synchronizeRecoveryBadgeWithLogging,
} from "./recovery-status.js";
import { isWebTab, startTabTracking } from "./tab-tracking.js";

const store = new RecoveryStore();
let installationCapture = Promise.resolve<RecoverySet | undefined>(undefined);

async function captureEligibleWebTabs(): Promise<RecoverySet> {
  const tabs = await chrome.tabs.query({ windowType: "normal" });

  return store.update((set) => {
    const windows = new Map<number, TrackedTab[]>();
    const existingTabs = new Map(
      set.windows.flatMap((window) =>
        window.tabs.map((tab) => [tab.browserTabId, tab] as const),
      ),
    );
    const existingGroupings = new Map(
      set.windows.flatMap((window) =>
        window.browserWindowId === undefined
          ? []
          : [[window.browserWindowId, window] as const],
      ),
    );

    for (const tab of tabs) {
      if (!isWebTab(tab)) {
        continue;
      }

      const trackedTab: TrackedTab = {
        recordId: existingTabs.get(tab.id)?.recordId ?? createDurableId(),
        browserTabId: tab.id,
        title: tab.title ?? tab.url,
        url: tab.url,
        placement: {
          index: tab.index,
          pinned: tab.pinned,
        },
      };
      const windowTabs = windows.get(tab.windowId) ?? [];
      windowTabs.push(trackedTab);
      windows.set(tab.windowId, windowTabs);
    }

    set.windows = Array.from(windows, ([windowId, windowTabs]) => ({
      groupingId: existingGroupings.get(windowId)?.groupingId ?? createDurableId(),
      browserWindowId: windowId,
      tabs: windowTabs.sort((left, right) => left.placement.index - right.placement.index),
    }));
  });
}

async function getCurrentRecoveryStatus() {
  await installationCapture;
  const recoverySet = await store.read();
  return getRecoveryStatus(recoverySet);
}

startTabTracking(store);
void store
  .read()
  .then((set) => synchronizeRecoveryBadgeWithLogging(set, "at startup"))
  .catch((error: unknown) => {
    console.error("Failed to read Recovery Data for badge synchronization at startup", error);
  });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.recoverySet?.newValue) {
    return;
  }
  synchronizeRecoveryBadgeWithLogging(
    changes.recoverySet.newValue as RecoverySet,
    "after Recovery Data changed",
  );
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") {
    return;
  }

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

  void getCurrentRecoveryStatus().then(sendResponse);

  return true;
});
