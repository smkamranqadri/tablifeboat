import { createDurableId, type TabPlacement } from "./recovery-model.js";
import type { RecoveryStore } from "./recovery-store.js";

export interface RestoreWindowGroupingResult {
  restoredRecordIds: string[];
  failedRecordIds: string[];
}

export type RestoreAllResult = RestoreWindowGroupingResult;

export interface ManualRecoveryOptions {
  beforeCreateTab?: (recordId: string) => void;
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

export async function restoreMissingTab(
  store: RecoveryStore,
  recordId: string,
  activeWindow: chrome.windows.Window | undefined,
  options: ManualRecoveryOptions = {},
): Promise<RestoreWindowGroupingResult> {
  const recoverySet = await store.read();
  const existingRecord = recoverySet.windows
    .flatMap((grouping) => grouping.tabs)
    .find((tab) => tab.recordId === recordId);
  if (!existingRecord || existingRecord.browserTabId !== undefined) {
    return { restoredRecordIds: [], failedRecordIds: [] };
  }

  if (
    !activeWindow ||
    activeWindow.id === undefined ||
    activeWindow.incognito ||
    activeWindow.type !== "normal"
  ) {
    return { restoredRecordIds: [], failedRecordIds: [recordId] };
  }

  let createdBrowserTabId: number | undefined;
  const missingTabUnavailable = new Error(
    "Missing Tab is no longer available for Manual Recovery",
  );
  try {
    await store.update(async (set) => {
      const sourceGrouping = set.windows.find((grouping) =>
        grouping.tabs.some((tab) => tab.recordId === recordId),
      );
      const trackedTab = sourceGrouping?.tabs.find(
        (tab) => tab.recordId === recordId,
      );
      if (!sourceGrouping || !trackedTab || trackedTab.browserTabId !== undefined) {
        throw missingTabUnavailable;
      }

      options.beforeCreateTab?.(recordId);
      const browserTab = await chrome.tabs.create({
        windowId: activeWindow.id,
        url: trackedTab.url,
        active: true,
      });
      if (browserTab.id === undefined) {
        throw new Error("Chromium did not return the restored tab ID");
      }
      createdBrowserTabId = browserTab.id;

      const sourceTabIndex = sourceGrouping.tabs.indexOf(trackedTab);
      sourceGrouping.tabs.splice(sourceTabIndex, 1);
      trackedTab.browserTabId = browserTab.id;
      trackedTab.title = browserTab.pendingUrl
        ? trackedTab.title
        : (browserTab.title ?? trackedTab.title);
      trackedTab.url = browserTab.pendingUrl ?? browserTab.url ?? trackedTab.url;
      trackedTab.placement = {
        index: browserTab.index,
        pinned: browserTab.pinned,
      };
      delete trackedTab.missingReason;

      let targetGrouping = set.windows.find(
        (grouping) => grouping.browserWindowId === activeWindow.id,
      );
      if (!targetGrouping) {
        targetGrouping = {
          groupingId: createDurableId(),
          browserWindowId: activeWindow.id,
          tabs: [],
        };
        set.windows.push(targetGrouping);
      }
      targetGrouping.tabs.push(trackedTab);
      targetGrouping.tabs.sort(
        (left, right) => left.placement.index - right.placement.index,
      );
      set.windows = set.windows.filter((grouping) => grouping.tabs.length > 0);
    });

    return { restoredRecordIds: [recordId], failedRecordIds: [] };
  } catch (error: unknown) {
    if (error === missingTabUnavailable) {
      return { restoredRecordIds: [], failedRecordIds: [] };
    }
    if (createdBrowserTabId !== undefined) {
      try {
        await chrome.tabs.remove(createdBrowserTabId);
      } catch (rollbackError: unknown) {
        console.error(
          `Could not roll back restored browser tab ${createdBrowserTabId}`,
          rollbackError,
        );
      }
    }
    console.error(`Failed to restore Missing Tab ${recordId}`, error);
    return { restoredRecordIds: [], failedRecordIds: [recordId] };
  }
}

export async function restoreWindowGrouping(
  store: RecoveryStore,
  groupingId: string,
  options: ManualRecoveryOptions = {},
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
            options,
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

export async function restoreAllMissingTabs(
  store: RecoveryStore,
  options: ManualRecoveryOptions = {},
): Promise<RestoreAllResult> {
  const recoverySet = await store.read();
  const groupingIds = recoverySet.windows
    .filter((grouping) =>
      grouping.tabs.some((tab) => tab.browserTabId === undefined),
    )
    .map((grouping) => grouping.groupingId);
  const result: RestoreAllResult = {
    restoredRecordIds: [],
    failedRecordIds: [],
  };

  for (const groupingId of groupingIds) {
    const groupingResult = await restoreWindowGrouping(store, groupingId, options);
    result.restoredRecordIds.push(...groupingResult.restoredRecordIds);
    result.failedRecordIds.push(...groupingResult.failedRecordIds);
  }

  return result;
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
  options: ManualRecoveryOptions,
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

    options.beforeCreateTab?.(missingTab.recordId);
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
