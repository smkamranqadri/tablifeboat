import {
  createDurableId,
  type RecoverySet,
  type TrackedTab,
} from "./recovery-model.js";
import {
  restoreAllMissingTabs,
  restoreWindowGrouping,
} from "./manual-recovery.js";
import { RecoveryStore } from "./recovery-store.js";
import {
  reconcileOpenTabsAfterStartup,
  scheduleStartupReconciliation,
} from "./reconciliation.js";
import {
  getRecoveryStatus,
  hasStartupMissingTabs,
  notifyMissingTabsAfterStartup,
  synchronizeRecoveryBadge,
  synchronizeRecoveryBadgeWithLogging,
} from "./recovery-status.js";
import { isWebTab, startTabTracking } from "./tab-tracking.js";

const store = new RecoveryStore();
let installationCapture = Promise.resolve<RecoverySet | undefined>(undefined);
const isAutomatedTestBuild =
  chrome.runtime.getManifest().version_name === "automated-test";
let failNextTabCreationRecordId: string | undefined;

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

async function restoreOneWindowGrouping(groupingId: string) {
  await installationCapture;
  const result = await restoreWindowGrouping(store, groupingId);
  await synchronizeRecoveryBadge(await store.read());
  return result;
}

async function restoreAllWindowGroupings() {
  await installationCapture;
  const result = await restoreAllMissingTabs(store, {
    beforeCreateTab: isAutomatedTestBuild
      ? (recordId) => {
          if (recordId !== failNextTabCreationRecordId) {
            return;
          }
          failNextTabCreationRecordId = undefined;
          throw new Error(`Injected tab creation failure for ${recordId}`);
        }
      : undefined,
  });
  await synchronizeRecoveryBadge(await store.read());
  return result;
}

startTabTracking(store);

const startupReconciliation = scheduleStartupReconciliation(
  async ({ claimStartupNotification }) => {
    await installationCapture;
    const set = await reconcileOpenTabsAfterStartup(store);
    await synchronizeRecoveryBadge(set);
    if (
      hasStartupMissingTabs(set) &&
      (await claimStartupNotification())
    ) {
      await notifyMissingTabsAfterStartup(set);
    }
    return set;
  },
  () => store.read(),
);

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
    !("type" in message)
  ) {
    return undefined;
  }

  if (message.type === "getRecoverySummary") {
    void getCurrentRecoveryStatus().then(sendResponse);
    return true;
  }

  if (message.type === "restoreAll") {
    void restoreAllWindowGroupings().then(sendResponse);
    return true;
  }

  if (
    message.type === "failNextTabCreationForAutomatedTest" &&
    isAutomatedTestBuild &&
    "recordId" in message &&
    typeof message.recordId === "string"
  ) {
    failNextTabCreationRecordId = message.recordId;
    sendResponse({ enabled: true });
    return false;
  }

  if (
    message.type === "restoreWindowGrouping" &&
    "groupingId" in message &&
    typeof message.groupingId === "string"
  ) {
    void restoreOneWindowGrouping(message.groupingId).then(sendResponse);
    return true;
  }

  if (message.type === "reconcileAfterStartupSettlingForTest") {
    void startupReconciliation
      .reconcileAfterStartupSettlingForTest()
      .then(sendResponse);
    return true;
  }

  if (message.type === "simulateStartupForTest") {
    void startupReconciliation.simulateStartupForTest().then(sendResponse);
    return true;
  }

  return undefined;
});
