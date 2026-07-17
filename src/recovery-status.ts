import type { RecoverySet, WindowGrouping } from "./recovery-model.js";

export interface RecoveryStatus {
  protectedTabCount: number;
  missingTabCount: number;
  missingWindowGroupings: WindowGrouping[];
}

export function getRecoveryStatus(set: RecoverySet): RecoveryStatus {
  const missingWindowGroupings = set.windows.flatMap((grouping) => {
    const missingTabs = grouping.tabs.filter((tab) => tab.browserTabId === undefined);
    return missingTabs.length === 0
      ? []
      : [{ groupingId: grouping.groupingId, tabs: missingTabs }];
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
