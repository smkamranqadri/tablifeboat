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
const STARTUP_STATE_KEY = "startupReconciliationState";

interface OpenWindowGrouping {
  browserWindowId: number;
  tabs: Array<chrome.tabs.Tab & { id: number; url: string }>;
}

interface StartupReconciliationState {
  armed: boolean;
  completed: boolean;
  notified: boolean;
  notificationInvocationCount: number;
  settleAfter: number;
}

interface StartupOperationContext {
  claimStartupNotification(): Promise<boolean>;
}

export interface StartupReconciliation {
  reconcileAfterStartupSettlingForTest(): Promise<RecoverySet | undefined>;
  simulateStartupForTest(): Promise<boolean>;
}

export async function reconcileRecoverySet(
  store: RecoveryStore,
  openTabs: chrome.tabs.Tab[],
): Promise<RecoverySet> {
  return store.update((set) => {
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
  });
}

export async function reconcileOpenTabsAfterStartup(
  store: RecoveryStore,
): Promise<RecoverySet> {
  const openTabs = await chrome.tabs.query({ windowType: "normal" });
  return reconcileRecoverySet(store, openTabs);
}

export function scheduleStartupReconciliation(
  operation: (context: StartupOperationContext) => Promise<RecoverySet>,
  readCurrentRecoverySet: () => Promise<RecoverySet>,
  automatedTestControlsEnabled = false,
): StartupReconciliation {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: Promise<RecoverySet> | undefined;
  let startupArming = Promise.resolve();

  const readState = async (): Promise<StartupReconciliationState | undefined> => {
    const stored = (await chrome.storage.session.get(STARTUP_STATE_KEY)) as {
      startupReconciliationState?: StartupReconciliationState;
    };
    return stored.startupReconciliationState;
  };

  const writeState = async (state: StartupReconciliationState): Promise<void> => {
    await chrome.storage.session.set({ [STARTUP_STATE_KEY]: state });
  };

  const claimStartupNotification = async (): Promise<boolean> => {
    const state = await readState();
    if (!state?.armed || state.completed || state.notified) {
      return false;
    }
    await writeState({
      ...state,
      notified: true,
      notificationInvocationCount: state.notificationInvocationCount + 1,
    });
    return true;
  };

  const reconcileOnce = async (): Promise<RecoverySet | undefined> => {
    const state = await readState();
    if (!state?.armed) {
      return undefined;
    }
    if (state.completed) {
      return readCurrentRecoverySet();
    }
    if (result) {
      return result;
    }

    result = operation({ claimStartupNotification })
      .then(async (recoverySet) => {
        const latestState = await readState();
        if (latestState?.armed) {
          await writeState({ ...latestState, completed: true });
        }
        return recoverySet;
      })
      .catch((error: unknown) => {
        result = undefined;
        throw error;
      });
    return result;
  };

  const armTimer = (settleAfter: number): void => {
    if (timer !== undefined || result !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void reconcileOnce().catch((error: unknown) => {
        console.error("Failed to reconcile Recovery Data after startup", error);
      });
    }, Math.max(0, settleAfter - Date.now()));
  };

  const armStartup = async (): Promise<void> => {
    const state: StartupReconciliationState = {
      armed: true,
      completed: false,
      notified: false,
      notificationInvocationCount: 0,
      settleAfter: Date.now() + STARTUP_SETTLING_MS,
    };
    await writeState(state);
    armTimer(state.settleAfter);
  };

  const handleStartup = (): void => {
    startupArming = armStartup();
    void startupArming.catch((error: unknown) => {
      console.error("Failed to arm startup reconciliation", error);
    });
  };

  chrome.runtime.onStartup.addListener(handleStartup);

  void readState()
    .then((state) => {
      if (state?.armed && !state.completed) {
        armTimer(state.settleAfter);
      }
    })
    .catch((error: unknown) => {
      console.error("Failed to resume startup reconciliation", error);
    });

  return {
    reconcileAfterStartupSettlingForTest: async () => {
      if (!automatedTestControlsEnabled) {
        return undefined;
      }
      const state = await readState();
      if (!state?.armed) {
        return undefined;
      }
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      return reconcileOnce();
    },
    simulateStartupForTest: async () => {
      if (!automatedTestControlsEnabled) {
        return false;
      }
      handleStartup();
      await startupArming;
      return true;
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

function findGloballyOptimalAssignment(
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
function maximizeSquareAssignment(weights: number[][]): number[] {
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
    delete trackedTab.missingReason;
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
