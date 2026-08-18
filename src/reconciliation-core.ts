import type {
  RecoverySet,
  TrackedTab,
  WindowGrouping,
} from "./recovery-model.js";
import { webTabAddress } from "./web-tab.js";

interface OpenWindowGrouping {
  browserWindowId: number;
  tabs: OpenWebTab[];
}

type OpenWebTab = chrome.tabs.Tab & { id: number; url: string };

export function reconcileWindows(
  set: RecoverySet,
  openTabs: chrome.tabs.Tab[],
  recoverySetAtBrowserStart?: RecoverySet,
): void {
  if (recoverySetAtBrowserStart) {
    removeNativeRestorationDuplicates(set, recoverySetAtBrowserStart, openTabs);
  }
  const previouslyLiveRecordIds = new Set(
    set.windows.flatMap((grouping) =>
      grouping.tabs.flatMap((tab) =>
        tab.browserTabId === undefined ? [] : [tab.recordId],
      ),
    ),
  );
  clearLiveBrowserAssociations(set);

  const openWindowGroupings = groupOpenWebTabs(openTabs);
  const assignment = findGloballyOptimalAssignment(
    set.windows,
    openWindowGroupings,
  );
  for (const [expectedIndex, openIndex] of assignment) {
    if (
      countAddressOccurrenceOverlap(
        set.windows[expectedIndex]!.tabs,
        openWindowGroupings[openIndex]!.tabs,
      ) === 0
    ) {
      continue;
    }
    associateWindowGrouping(
      set.windows[expectedIndex]!,
      openWindowGroupings[openIndex]!,
    );
  }

  for (const grouping of set.windows) {
    for (const tab of grouping.tabs) {
      if (tab.browserTabId !== undefined) {
        delete tab.missingReason;
      } else if (
        tab.missingReason !== "window-closure" &&
        (previouslyLiveRecordIds.has(tab.recordId) ||
          tab.missingReason === "startup")
      ) {
        tab.missingReason = "startup";
      }
    }
  }
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
    const address = webTabAddress(tab);
    if (address === undefined || tab.id === undefined) {
      continue;
    }
    const tabs = windows.get(tab.windowId) ?? [];
    tabs.push({ ...tab, id: tab.id, url: address });
    windows.set(tab.windowId, tabs);
  }
  return Array.from(windows, ([browserWindowId, tabs]) => ({
    browserWindowId,
    tabs: tabs.sort((left, right) => left.index - right.index),
  })).sort((left, right) => left.browserWindowId - right.browserWindowId);
}

export function removeNativeRestorationDuplicates(
  current: RecoverySet,
  recoverySetAtBrowserStart: RecoverySet,
  openTabs: chrome.tabs.Tab[],
): void {
  const currentTabsByRecordId = new Map(
    current.windows.flatMap((grouping) =>
      grouping.tabs.map((tab) => [tab.recordId, tab] as const),
    ),
  );
  const openTabIds = new Set(
    openTabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
  );
  // Only a record the browser has not restored yet can have been duplicated by
  // native restoration. Once its own tab is live again, a second tab at the same
  // address is a distinct Tracked Tab and must survive every later pass.
  const awaitsRestoration = (recordId: string): boolean => {
    const tab = currentTabsByRecordId.get(recordId);
    if (!tab) {
      return false;
    }
    return tab.browserTabId === undefined || !openTabIds.has(tab.browserTabId);
  };

  const originalRecordIds = new Set(
    recoverySetAtBrowserStart.windows.flatMap((grouping) =>
      grouping.tabs.map((tab) => tab.recordId),
    ),
  );
  const originalWindowGroupings = recoverySetAtBrowserStart.windows.flatMap(
    (grouping) => {
      const tabs = grouping.tabs.filter((tab) => awaitsRestoration(tab.recordId));
      return tabs.length === 0 ? [] : [{ ...grouping, tabs }];
    },
  );
  const openWindowGroupings = groupOpenWebTabs(openTabs);
  const assignment = findGloballyOptimalAssignment(
    originalWindowGroupings,
    openWindowGroupings,
  );
  const restoredBrowserTabIds = new Set<number>();

  for (const [expectedIndex, openIndex] of assignment) {
    const expected = originalWindowGroupings[expectedIndex]!;
    const open = openWindowGroupings[openIndex]!;
    for (const [, restoredTab] of matchTrackedTabsToOpenTabs(
      expected.tabs,
      open.tabs,
    )) {
      restoredBrowserTabIds.add(restoredTab.id);
    }
  }

  for (const grouping of current.windows) {
    grouping.tabs = grouping.tabs.filter(
      (tab) =>
        originalRecordIds.has(tab.recordId) ||
        tab.browserTabId === undefined ||
        !restoredBrowserTabIds.has(tab.browserTabId),
    );
  }
  current.windows = current.windows.filter((grouping) => grouping.tabs.length > 0);
}

export function findGloballyOptimalAssignment(
  expected: WindowGrouping[],
  open: OpenWindowGrouping[],
): Array<[number, number]> {
  const size = Math.max(expected.length, open.length);
  if (size === 0) {
    return [];
  }

  const maximumPairPenalty = Math.max(
    1,
    ...expected.flatMap((grouping) =>
      open.map(
        (candidate) => grouping.tabs.length + candidate.tabs.length,
      ),
    ),
  );
  const occurrenceScale = size * maximumPairPenalty + 1;
  const weights = Array.from({ length: size }, (_row, expectedIndex) =>
    Array.from({ length: size }, (_column, openIndex) => {
      if (expectedIndex >= expected.length || openIndex >= open.length) {
        return 0;
      }
      const overlap = countAddressOccurrenceOverlap(
        expected[expectedIndex]!.tabs,
        open[openIndex]!.tabs,
      );
      const unmatched =
        expected[expectedIndex]!.tabs.length +
        open[openIndex]!.tabs.length -
        overlap * 2;
      return overlap * occurrenceScale + (maximumPairPenalty - unmatched);
    }),
  );
  const assignment = maximizeSquareAssignment(weights);
  return assignment.flatMap((openIndex, expectedIndex) =>
    expectedIndex < expected.length && openIndex < open.length
      ? [[expectedIndex, openIndex] as [number, number]]
      : [],
  );
}

// Hungarian assignment, with stable row/column iteration as the final tie-breaker.
export function maximizeSquareAssignment(weights: number[][]): number[] {
  const size = weights.length;
  const maximumWeight = Math.max(0, ...weights.flat());
  const rowPotential = Array<number>(size + 1).fill(0);
  const columnPotential = Array<number>(size + 1).fill(0);
  const matchedRow = Array<number>(size + 1).fill(0);
  const predecessor = Array<number>(size + 1).fill(0);

  for (let row = 1; row <= size; row += 1) {
    matchedRow[0] = row;
    let column = 0;
    const minimum = Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array<boolean>(size + 1).fill(false);
    do {
      used[column] = true;
      const currentRow = matchedRow[column]!;
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let candidateColumn = 1; candidateColumn <= size; candidateColumn += 1) {
        if (used[candidateColumn]) {
          continue;
        }
        const cost =
          maximumWeight - weights[currentRow - 1]![candidateColumn - 1]!;
        const reduced =
          cost - rowPotential[currentRow]! - columnPotential[candidateColumn]!;
        if (reduced < minimum[candidateColumn]!) {
          minimum[candidateColumn] = reduced;
          predecessor[candidateColumn] = column;
        }
        if (minimum[candidateColumn]! < delta) {
          delta = minimum[candidateColumn]!;
          nextColumn = candidateColumn;
        }
      }
      for (let candidateColumn = 0; candidateColumn <= size; candidateColumn += 1) {
        if (used[candidateColumn]) {
          rowPotential[matchedRow[candidateColumn]!] += delta;
          columnPotential[candidateColumn] -= delta;
        } else {
          minimum[candidateColumn] -= delta;
        }
      }
      column = nextColumn;
    } while (matchedRow[column] !== 0);

    do {
      const previousColumn = predecessor[column]!;
      matchedRow[column] = matchedRow[previousColumn]!;
      column = previousColumn;
    } while (column !== 0);
  }

  const assignment = Array<number>(size).fill(0);
  for (let column = 1; column <= size; column += 1) {
    assignment[matchedRow[column]! - 1] = column - 1;
  }
  return assignment;
}

export function countAddressOccurrenceOverlap(
  expectedTabs: TrackedTab[],
  openTabs: OpenWebTab[],
): number {
  const openCounts = new Map<string, number>();
  for (const tab of openTabs) {
    openCounts.set(tab.url, (openCounts.get(tab.url) ?? 0) + 1);
  }
  let overlapCount = 0;
  for (const tab of expectedTabs) {
    const remaining = openCounts.get(tab.url) ?? 0;
    if (remaining > 0) {
      overlapCount += 1;
      openCounts.set(tab.url, remaining - 1);
    }
  }
  return overlapCount;
}

function associateWindowGrouping(
  expected: WindowGrouping,
  open: OpenWindowGrouping,
): void {
  const matches = matchTrackedTabsToOpenTabs(expected.tabs, open.tabs);
  for (const [trackedTab, browserTab] of matches) {
    trackedTab.browserTabId = browserTab.id;
    delete trackedTab.missingReason;
    trackedTab.title = browserTab.title ?? browserTab.url;
    trackedTab.placement = {
      index: browserTab.index,
      pinned: browserTab.pinned,
    };
  }
  if (matches.length > 0) {
    expected.browserWindowId = open.browserWindowId;
  }
}

export function matchTrackedTabsToOpenTabs(
  trackedTabs: TrackedTab[],
  openTabs: OpenWebTab[],
): Array<[TrackedTab, OpenWebTab]> {
  const tabsByAddress = new Map<string, OpenWebTab[]>();
  for (const tab of openTabs) {
    const occurrences = tabsByAddress.get(tab.url) ?? [];
    occurrences.push(tab);
    tabsByAddress.set(tab.url, occurrences);
  }
  const matches: Array<[TrackedTab, OpenWebTab]> = [];
  for (const trackedTab of trackedTabs) {
    const browserTab = tabsByAddress.get(trackedTab.url)?.shift();
    if (browserTab) {
      matches.push([trackedTab, browserTab]);
    }
  }
  return matches;
}
