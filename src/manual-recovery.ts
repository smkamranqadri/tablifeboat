import type { TabPlacement } from "./recovery-model.js";
import type { RecoveryStore } from "./recovery-store.js";

export interface RestoreWindowGroupingResult {
  restoredRecordIds: string[];
  failedRecordIds: string[];
}

interface MissingTabSnapshot {
  recordId: string;
  url: string;
  placement: TabPlacement;
}

interface RestoredBrowserTab {
  browserTabId: number;
  browserWindowId: number;
}

export async function restoreWindowGrouping(
  store: RecoveryStore,
  groupingId: string,
): Promise<RestoreWindowGroupingResult> {
  const recoverySet = await store.read();
  const grouping = recoverySet.windows.find(
    (candidate) => candidate.groupingId === groupingId,
  );
  if (!grouping) {
    return { restoredRecordIds: [], failedRecordIds: [] };
  }

  const missingTabs: MissingTabSnapshot[] = grouping.tabs
    .filter((tab) => tab.browserTabId === undefined)
    .map((tab) => ({
      recordId: tab.recordId,
      url: tab.url,
      placement: { ...tab.placement },
    }))
    .sort((left, right) => left.placement.index - right.placement.index);
  const restoredRecordIds: string[] = [];
  const failedRecordIds: string[] = [];
  let browserWindowId = grouping.browserWindowId;

  for (const missingTab of missingTabs) {
    try {
      const restoredTab = browserWindowId === undefined
        ? await restoreFirstTabInNewWindow(store, groupingId, missingTab)
        : await restoreTabInExistingWindow(
            store,
            groupingId,
            browserWindowId,
            missingTab,
          );
      browserWindowId = restoredTab.browserWindowId;
      restoredRecordIds.push(missingTab.recordId);
      try {
        await applySavedPlacement(restoredTab.browserTabId, missingTab.placement);
      } catch (error: unknown) {
        console.error(
          `Could not fully restore Tab Placement for ${missingTab.recordId}`,
          error,
        );
      }
    } catch (error: unknown) {
      failedRecordIds.push(missingTab.recordId);
      console.error(`Failed to restore Missing Tab ${missingTab.recordId}`, error);
    }
  }

  return { restoredRecordIds, failedRecordIds };
}

async function restoreFirstTabInNewWindow(
  store: RecoveryStore,
  groupingId: string,
  missingTab: MissingTabSnapshot,
): Promise<RestoredBrowserTab> {
  let restoredTab: RestoredBrowserTab | undefined;
  await store.update(async (set) => {
    const grouping = set.windows.find(
      (candidate) => candidate.groupingId === groupingId,
    );
    const trackedTab = grouping?.tabs.find(
      (candidate) => candidate.recordId === missingTab.recordId,
    );
    if (!grouping || !trackedTab || trackedTab.browserTabId !== undefined) {
      throw new Error("Missing Tab is no longer available for Manual Recovery");
    }

    const browserWindow = await chrome.windows.create({
      type: "normal",
      url: missingTab.url,
    });
    const browserTab = browserWindow?.tabs?.[0];
    if (!browserWindow || browserWindow.id === undefined || browserTab?.id === undefined) {
      throw new Error("Chromium did not return the restored window and tab IDs");
    }

    grouping.browserWindowId = browserWindow.id;
    trackedTab.browserTabId = browserTab.id;
    delete trackedTab.missingReason;
    restoredTab = {
      browserTabId: browserTab.id,
      browserWindowId: browserWindow.id,
    };
  });

  if (!restoredTab) {
    throw new Error("Missing Tab restoration did not complete");
  }
  return restoredTab;
}

async function restoreTabInExistingWindow(
  store: RecoveryStore,
  groupingId: string,
  browserWindowId: number,
  missingTab: MissingTabSnapshot,
): Promise<RestoredBrowserTab> {
  let browserTabId: number | undefined;
  await store.update(async (set) => {
    const grouping = set.windows.find(
      (candidate) => candidate.groupingId === groupingId,
    );
    const trackedTab = grouping?.tabs.find(
      (candidate) => candidate.recordId === missingTab.recordId,
    );
    if (!grouping || !trackedTab || trackedTab.browserTabId !== undefined) {
      throw new Error("Missing Tab is no longer available for Manual Recovery");
    }

    const browserTab = await chrome.tabs.create({
      windowId: browserWindowId,
      url: missingTab.url,
      active: false,
    });
    if (browserTab.id === undefined) {
      throw new Error("Chromium did not return the restored tab ID");
    }

    grouping.browserWindowId = browserWindowId;
    trackedTab.browserTabId = browserTab.id;
    delete trackedTab.missingReason;
    browserTabId = browserTab.id;
  });

  if (browserTabId === undefined) {
    throw new Error("Missing Tab restoration did not complete");
  }
  return { browserTabId, browserWindowId };
}

async function applySavedPlacement(
  browserTabId: number,
  placement: TabPlacement,
): Promise<void> {
  await chrome.tabs.update(browserTabId, { pinned: placement.pinned });
  await chrome.tabs.move(browserTabId, { index: placement.index });
}
