import {
  createDurableId,
  type RecoverySet,
  type TrackedTab,
} from "./recovery-model.js";
import {
  restoreAllMissingTabs,
  restoreMissingTab,
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
import { startTabTracking } from "./tab-tracking.js";
import { isWebTab } from "./web-tab.js";

const store = new RecoveryStore();

// This read must stay the first operation on the store queue so it captures
// the pre-startup Recovery Data before any tab-tracking event can mutate it.
const recoveryDataAtWorkerStart = store.read();

// The native-restoration dedup baseline must be the Recovery Data as it was
// when the browser session began — a worker restarted mid-startup would
// otherwise re-read a set already polluted with duplicate records and keep them.
const STARTUP_BASELINE_KEY = "recoveryDataAtBrowserStart";

// Every Recovery Popup request waits on this, so it resolves rather than
// rejects; losing the baseline only costs native-restoration deduplication.
async function resolveBrowserStartBaseline(): Promise<RecoverySet> {
  try {
    return await captureBrowserStartBaseline();
  } catch (error: unknown) {
    console.error("Failed to capture the browser-start Recovery Data", error);
    return recoveryDataAtWorkerStart;
  }
}

async function captureBrowserStartBaseline(): Promise<RecoverySet> {
  const stored = (await chrome.storage.session.get(STARTUP_BASELINE_KEY)) as {
    recoveryDataAtBrowserStart?: RecoverySet;
  };
  if (stored.recoveryDataAtBrowserStart) {
    return stored.recoveryDataAtBrowserStart;
  }
  const set = await recoveryDataAtWorkerStart;
  await chrome.storage.session.set({ [STARTUP_BASELINE_KEY]: set });

  // Chromium does not reliably deliver runtime.onStartup (observed on macOS
  // relaunches). If the first worker life of this browser session finds
  // Recovery Data that cannot belong to the session, arm startup
  // reconciliation without waiting for the event.
  const predates = await recoveryDataPredatesThisSession(set).catch(
    (error: unknown) => {
      console.error("Failed to inspect Recovery Data for session start", error);
      return false;
    },
  );
  if (predates) {
    startupReconciliation.armForBrowserSessionStart();
  }
  return set;
}

async function recoveryDataPredatesThisSession(
  set: RecoverySet,
): Promise<boolean> {
  const tabs = set.windows.flatMap((grouping) => grouping.tabs);
  if (tabs.length === 0) {
    return false;
  }
  if (tabs.some((tab) => tab.browserTabId === undefined)) {
    return true;
  }
  const openTabIds = new Set(
    (await chrome.tabs.query({})).flatMap((tab) =>
      tab.id === undefined ? [] : [tab.id],
    ),
  );
  return tabs.some(
    (tab) => tab.browserTabId !== undefined && !openTabIds.has(tab.browserTabId),
  );
}

const recoveryDataAtBrowserStart = resolveBrowserStartBaseline();
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

async function awaitStartupReadiness(): Promise<void> {
  await installationCapture;
  // Arming happens inside this promise. Answering before it settles would report
  // the pre-startup Recovery Set, whose stale associations all look open.
  await recoveryDataAtBrowserStart;
  await startupReconciliation.ensureReconciledBeforeManualRecovery();
}

async function getCurrentRecoveryStatus() {
  await awaitStartupReadiness();
  const recoverySet = await store.read();
  return getRecoveryStatus(recoverySet);
}

async function restoreOneWindowGrouping(groupingId: string) {
  await awaitStartupReadiness();
  const result = await restoreWindowGrouping(store, groupingId, {
    beforeCreateTab: automatedTabCreationFailureHook(),
  });
  await synchronizeRecoveryBadge(await store.read());
  return result;
}

function automatedTabCreationFailureHook() {
  return isAutomatedTestBuild
    ? (recordId: string) => {
        if (recordId !== failNextTabCreationRecordId) {
          return;
        }
        failNextTabCreationRecordId = undefined;
        throw new Error(`Injected tab creation failure for ${recordId}`);
      }
    : undefined;
}

async function restoreOneMissingTab(recordId: string) {
  await awaitStartupReadiness();
  let activeWindow: chrome.windows.Window | undefined;
  try {
    activeWindow = await chrome.windows.getLastFocused({
      windowTypes: ["normal"],
    });
  } catch (error: unknown) {
    console.error(`Could not resolve an active window for ${recordId}`, error);
  }
  const result = await restoreMissingTab(store, recordId, activeWindow, {
    beforeCreateTab: automatedTabCreationFailureHook(),
  });
  await synchronizeRecoveryBadge(await store.read());
  return result;
}

async function restoreAllWindowGroupings() {
  await awaitStartupReadiness();
  const result = await restoreAllMissingTabs(store, {
    beforeCreateTab: automatedTabCreationFailureHook(),
  });
  await synchronizeRecoveryBadge(await store.read());
  return result;
}

async function forgetMissingTab(recordId: string) {
  await awaitStartupReadiness();
  const result = await store.forgetTab(recordId);
  await synchronizeRecoveryBadge(await store.read());
  return result;
}

async function forgetMissingWindowGrouping(groupingId: string) {
  await awaitStartupReadiness();
  const result = await store.forgetWindowGrouping(groupingId);
  await synchronizeRecoveryBadge(await store.read());
  return result;
}

startTabTracking(store);

const startupReconciliation = scheduleStartupReconciliation(
  async ({ claimStartupNotification }) => {
    await installationCapture;
    const set = await reconcileOpenTabsAfterStartup(
      store,
      await recoveryDataAtBrowserStart,
    );
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
  isAutomatedTestBuild,
);

chrome.tabs.onCreated.addListener(() => {
  startupReconciliation.scheduleAfterTabActivity();
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.url !== undefined || changeInfo.status === "complete") {
    startupReconciliation.scheduleAfterTabActivity();
  }
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

  installationCapture = recoveryDataAtWorkerStart.then((existing) =>
    existing.windows.length === 0 ? captureEligibleWebTabs() : existing,
  );
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
    message.type === "restoreTab" &&
    "recordId" in message &&
    typeof message.recordId === "string"
  ) {
    void restoreOneMissingTab(message.recordId).then(sendResponse);
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

  if (
    message.type === "forgetTab" &&
    "recordId" in message &&
    typeof message.recordId === "string"
  ) {
    void forgetMissingTab(message.recordId).then(sendResponse);
    return true;
  }

  if (
    message.type === "forgetWindowGrouping" &&
    "groupingId" in message &&
    typeof message.groupingId === "string"
  ) {
    void forgetMissingWindowGrouping(message.groupingId).then(sendResponse);
    return true;
  }

  if (
    message.type === "reconcileAfterStartupSettlingForTest" &&
    isAutomatedTestBuild
  ) {
    void startupReconciliation
      .reconcileAfterStartupSettlingForTest()
      .then(sendResponse);
    return true;
  }

  if (message.type === "simulateStartupForTest" && isAutomatedTestBuild) {
    void startupReconciliation.simulateStartupForTest().then(sendResponse);
    return true;
  }

  if (message.type === "simulateStartupForTest") {
    sendResponse(false);
    return false;
  }

  return undefined;
});
