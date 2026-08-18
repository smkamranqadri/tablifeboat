import type { RecoverySet } from "./recovery-model.js";

// No startup-missing record predates the tab identity replacement fix honestly,
// so the whole cohort is cleared once. Window Closure records stay: those are
// the Recovery Data a person deliberately expects to get back.
export function removeStartupMissingBacklog(set: RecoverySet): number {
  let removedCount = 0;

  for (const grouping of set.windows) {
    const kept = grouping.tabs.filter(
      (tab) =>
        tab.browserTabId !== undefined || tab.missingReason !== "startup",
    );
    removedCount += grouping.tabs.length - kept.length;
    grouping.tabs = kept;
  }

  set.windows = set.windows.filter((grouping) => grouping.tabs.length > 0);
  return removedCount;
}
