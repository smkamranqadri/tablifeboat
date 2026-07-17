import type {
  RecoverySet,
  TrackedTab,
  WindowGrouping,
} from "./recovery-model.js";
import type { RecoveryStore } from "./recovery-store.js";
import { isWebTab } from "./tab-tracking.js";

// Native restoration is asynchronous. Give Chromium a fixed opportunity to
// finish rebuilding windows before deciding which Recovery Data is missing.
export const STARTUP_SETTLING_MS = 5_000;

interface OpenWindowGrouping {
  browserWindowId: number;
  tabs: Array<chrome.tabs.Tab & { id: number; url: string }>;
}

interface GroupingCandidate {
  expectedIndex: number;
  openIndex: number;
  overlapCount: number;
  expectedMissingCount: number;
  openExtraCount: number;
  browserWindowId: number;
}

export interface StartupReconciliation {
  reconcileAfterStartupSettlingForTest(): Promise<RecoverySet>;
}

export async function reconcileRecoverySet(
  store: RecoveryStore,
  openTabs: chrome.tabs.Tab[],
): Promise<RecoverySet> {
  return store.update((set) => {
    clearLiveBrowserAssociations(set);

    const openWindowGroupings = groupOpenWebTabs(openTabs);
    const unmatchedExpected = new Set(set.windows.map((_grouping, index) => index));
    const unmatchedOpen = new Set(
      openWindowGroupings.map((_grouping, index) => index),
    );

    while (true) {
      const candidate = findBestGroupingCandidate(
        set.windows,
        openWindowGroupings,
        unmatchedExpected,
        unmatchedOpen,
      );
      if (!candidate) {
        break;
      }

      associateWindowGrouping(
        set.windows[candidate.expectedIndex]!,
        openWindowGroupings[candidate.openIndex]!,
      );
      unmatchedExpected.delete(candidate.expectedIndex);
      unmatchedOpen.delete(candidate.openIndex);
    }
  });
}

export async function reconcileOpenTabsAfterStartup(
  store: RecoveryStore,
): Promise<RecoverySet> {
  const openTabs = await chrome.tabs.query({ windowType: "normal" });
  return reconcileRecoverySet(store, openTabs);
}

export function scheduleStartupReconciliation(
  operation: () => Promise<RecoverySet>,
): StartupReconciliation {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Promise<RecoverySet> | undefined;

  const reconcileOnce = (): Promise<RecoverySet> => {
    result ??= operation();
    return result;
  };

  chrome.runtime.onStartup.addListener(() => {
    if (timer !== undefined || result !== undefined) {
      return;
    }

    timer = setTimeout(() => {
      timer = undefined;
      void reconcileOnce().catch((error: unknown) => {
        console.error("Failed to reconcile Recovery Data after startup", error);
      });
    }, STARTUP_SETTLING_MS);
  });

  return {
    reconcileAfterStartupSettlingForTest: () => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      return reconcileOnce();
    },
  };
}

function clearLiveBrowserAssociations(set: RecoverySet): void {
  for (const grouping of set.windows) {
    delete grouping.browserWindowId;
    for (const tab of grouping.tabs) {
      delete tab.browserTabId;
    }
  }
}

function groupOpenWebTabs(openTabs: chrome.tabs.Tab[]): OpenWindowGrouping[] {
  const windows = new Map<
    number,
    Array<chrome.tabs.Tab & { id: number; url: string }>
  >();

  for (const tab of openTabs) {
    if (!isWebTab(tab)) {
      continue;
    }
    const tabs = windows.get(tab.windowId) ?? [];
    tabs.push(tab);
    windows.set(tab.windowId, tabs);
  }

  return Array.from(windows, ([browserWindowId, tabs]) => ({
    browserWindowId,
    tabs: tabs.sort((left, right) => left.index - right.index),
  })).sort((left, right) => left.browserWindowId - right.browserWindowId);
}

function findBestGroupingCandidate(
  expectedGroupings: WindowGrouping[],
  openGroupings: OpenWindowGrouping[],
  unmatchedExpected: Set<number>,
  unmatchedOpen: Set<number>,
): GroupingCandidate | undefined {
  let best: GroupingCandidate | undefined;

  for (const expectedIndex of unmatchedExpected) {
    for (const openIndex of unmatchedOpen) {
      const expected = expectedGroupings[expectedIndex]!;
      const open = openGroupings[openIndex]!;
      const overlapCount = countAddressOccurrenceOverlap(expected.tabs, open.tabs);
      if (overlapCount === 0) {
        continue;
      }

      const candidate: GroupingCandidate = {
        expectedIndex,
        openIndex,
        overlapCount,
        expectedMissingCount: expected.tabs.length - overlapCount,
        openExtraCount: open.tabs.length - overlapCount,
        browserWindowId: open.browserWindowId,
      };
      if (!best || compareCandidates(candidate, best) < 0) {
        best = candidate;
      }
    }
  }

  return best;
}

function compareCandidates(
  left: GroupingCandidate,
  right: GroupingCandidate,
): number {
  return (
    right.overlapCount - left.overlapCount ||
    left.expectedMissingCount - right.expectedMissingCount ||
    left.openExtraCount - right.openExtraCount ||
    left.expectedIndex - right.expectedIndex ||
    left.browserWindowId - right.browserWindowId
  );
}

function countAddressOccurrenceOverlap(
  expectedTabs: TrackedTab[],
  openTabs: Array<chrome.tabs.Tab & { id: number; url: string }>,
): number {
  const openCounts = new Map<string, number>();
  for (const tab of openTabs) {
    openCounts.set(tab.url, (openCounts.get(tab.url) ?? 0) + 1);
  }

  let overlapCount = 0;
  for (const tab of expectedTabs) {
    const remaining = openCounts.get(tab.url) ?? 0;
    if (remaining === 0) {
      continue;
    }
    overlapCount += 1;
    openCounts.set(tab.url, remaining - 1);
  }
  return overlapCount;
}

function associateWindowGrouping(
  expected: WindowGrouping,
  open: OpenWindowGrouping,
): void {
  const tabsByAddress = new Map<
    string,
    Array<chrome.tabs.Tab & { id: number; url: string }>
  >();
  for (const tab of open.tabs) {
    const occurrences = tabsByAddress.get(tab.url) ?? [];
    occurrences.push(tab);
    tabsByAddress.set(tab.url, occurrences);
  }

  let matchedAny = false;
  for (const trackedTab of expected.tabs) {
    const browserTab = tabsByAddress.get(trackedTab.url)?.shift();
    if (!browserTab) {
      continue;
    }

    matchedAny = true;
    trackedTab.browserTabId = browserTab.id;
    trackedTab.title = browserTab.title ?? browserTab.url;
    trackedTab.placement = {
      index: browserTab.index,
      pinned: browserTab.pinned,
    };
  }

  if (matchedAny) {
    expected.browserWindowId = open.browserWindowId;
  }
}
