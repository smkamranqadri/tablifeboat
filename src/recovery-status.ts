import type { RecoverySet, WindowGrouping } from "./recovery-model.js";

export interface RecoveryStatus {
  protectedTabCount: number;
  missingTabCount: number;
  missingWindowGroupings: Array<
    WindowGrouping & { entirelyMissing: boolean }
  >;
}

export function getRecoveryStatus(set: RecoverySet): RecoveryStatus {
  const missingWindowGroupings = set.windows.flatMap((grouping) => {
    const missingTabs = grouping.tabs.filter((tab) => tab.browserTabId === undefined);
    return missingTabs.length === 0
      ? []
      : [
          {
            groupingId: grouping.groupingId,
            tabs: missingTabs,
            entirelyMissing: missingTabs.length === grouping.tabs.length,
          },
        ];
  });

  return {
    protectedTabCount: set.windows.reduce(
      (count, grouping) =>
        count + grouping.tabs.filter((tab) => tab.browserTabId !== undefined).length,
      0,
    ),
    missingTabCount: missingWindowGroupings.reduce(
      (count, grouping) => count + grouping.tabs.length,
      0,
    ),
    missingWindowGroupings,
  };
}

export async function synchronizeRecoveryBadge(set: RecoverySet): Promise<void> {
  const { missingTabCount } = getRecoveryStatus(set);
  await chrome.action.setBadgeText({
    text: missingTabCount === 0 ? "" : String(missingTabCount),
  });
}

export async function notifyMissingTabsAfterStartup(
  set: RecoverySet,
): Promise<void> {
  const { missingTabCount } = getRecoveryStatus(set);
  if (!hasStartupMissingTabs(set)) {
    return;
  }

  const noun = missingTabCount === 1 ? "Missing Tab is" : "Missing Tabs are";
  await chrome.notifications.create("tab-recovery-startup", {
    type: "basic",
    iconUrl: "icons/icon-128.png",
    title: "Tab Recovery",
    message: `${missingTabCount} ${noun} available for Manual Recovery.`,
  });
}

export function hasStartupMissingTabs(set: RecoverySet): boolean {
  return set.windows.some((grouping) =>
    grouping.tabs.some(
      (tab) =>
        tab.browserTabId === undefined && tab.missingReason === "startup",
    ),
  );
}

export function synchronizeRecoveryBadgeWithLogging(
  set: RecoverySet,
  context: string,
): void {
  void synchronizeRecoveryBadge(set).catch((error: unknown) => {
    console.error(`Failed to synchronize Recovery badge ${context}`, error);
  });
}
