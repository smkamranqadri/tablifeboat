import type { RecoverySet } from "./recovery-model.js";
import type { RecoveryStore } from "./recovery-store.js";
import { hasStartupMissingTabs } from "./recovery-status.js";
import { reconcileWindows } from "./reconciliation-core.js";

// Native restoration is asynchronous. Give Chromium a fixed opportunity to
// finish rebuilding windows before deciding which Recovery Data is missing.
export const STARTUP_SETTLING_MS = 5_000;
// Late restoration belongs to browser startup alone. Left open-ended, a single
// unrecoverable Missing Tab keeps the latch armed for the whole browser session
// and every tab event pays for a full reconciliation pass.
const LATE_RESTORATION_WINDOW_MS = 60_000;
const SETTLING_POLL_MS = 50;
const LATE_RESTORATION_DEBOUNCE_MS = 100;
const STARTUP_STATE_KEY = "startupReconciliationState";

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
  armForBrowserSessionStart(): void;
  ensureReconciledBeforeManualRecovery(): Promise<void>;
  reconcileAfterStartupSettlingForTest(): Promise<RecoverySet | undefined>;
  simulateStartupForTest(): Promise<boolean>;
  scheduleAfterTabActivity(): void;
}

export async function reconcileOpenTabsAfterStartup(
  store: RecoveryStore,
  recoverySetAtBrowserStart?: RecoverySet,
): Promise<RecoverySet> {
  // Querying inside the mutator keeps the snapshot and the mutation on one
  // queue; a tab-tracking update landing between them would hide an open tab.
  return store.update(async (set) => {
    const openTabs = await chrome.tabs.query({ windowType: "normal" });
    reconcileWindows(set, openTabs, recoverySetAtBrowserStart);
  });
}

export function scheduleStartupReconciliation(
  operation: (context: StartupOperationContext) => Promise<RecoverySet>,
  readCurrentRecoverySet: () => Promise<RecoverySet>,
  automatedTestControlsEnabled = false,
): StartupReconciliation {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lateRestorationTimer: ReturnType<typeof setTimeout> | undefined;
  let result: Promise<RecoverySet> | undefined;
  let startupArming = Promise.resolve();
  let lateRestorationPending = false;
  let reconciliationInFlight = false;
  let tabActivityDuringReconciliation = false;

  const withinLateRestorationWindow = (
    state: StartupReconciliationState,
  ): boolean => Date.now() < state.settleAfter + LATE_RESTORATION_WINDOW_MS;

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

  // Tabs Chromium restores while a pass is running are absent from the single
  // read that pass took, so that activity has to earn another pass by itself.
  const runReconciliation = async (): Promise<RecoverySet> => {
    reconciliationInFlight = true;
    tabActivityDuringReconciliation = false;
    try {
      const recoverySet = await operation({ claimStartupNotification });
      lateRestorationPending =
        hasStartupMissingTabs(recoverySet) || tabActivityDuringReconciliation;
      return recoverySet;
    } finally {
      reconciliationInFlight = false;
      if (tabActivityDuringReconciliation) {
        scheduleLateReconciliation();
      }
    }
  };

  const scheduleLateReconciliation = (): void => {
    if (lateRestorationTimer !== undefined) {
      clearTimeout(lateRestorationTimer);
    }
    lateRestorationTimer = setTimeout(() => {
      lateRestorationTimer = undefined;
      if (reconciliationInFlight) {
        tabActivityDuringReconciliation = true;
        return;
      }
      void runReconciliation().catch((error: unknown) => {
        console.error("Failed to reconcile late native tab restoration", error);
      });
    }, LATE_RESTORATION_DEBOUNCE_MS);
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

    result = runReconciliation()
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

  // Re-reads the deadline every tick: a startup event arriving mid-wait extends
  // the settling window, and waiting on the old deadline is the original defect.
  const waitForStartupSettling = async (): Promise<void> => {
    for (;;) {
      const state = await readState();
      if (!state?.armed || state.completed || result !== undefined) {
        return;
      }
      if (Date.now() >= state.settleAfter) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, SETTLING_POLL_MS));
    }
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
    lateRestorationPending = false;
    startupArming = armStartup();
    void startupArming.catch((error: unknown) => {
      console.error("Failed to arm startup reconciliation", error);
    });
  };

  chrome.runtime.onStartup.addListener(handleStartup);

  const startupStateReady = readState()
    .then(async (state) => {
      if (state?.armed && !state.completed) {
        armTimer(state.settleAfter);
      } else if (
        state?.armed &&
        state.completed &&
        withinLateRestorationWindow(state)
      ) {
        lateRestorationPending = hasStartupMissingTabs(
          await readCurrentRecoverySet(),
        );
      }
    })
    .catch((error: unknown) => {
      console.error("Failed to resume startup reconciliation", error);
    });

  return {
    armForBrowserSessionStart: () => {
      handleStartup();
    },
    // Every Recovery Popup request waits on this, and a rejection here would
    // leave sendResponse uncalled and the popup blank, so it never rejects.
    ensureReconciledBeforeManualRecovery: async () => {
      try {
        await startupStateReady;
        await startupArming.catch(() => undefined);
        // Reconciling before the window elapses would call tabs Chromium has
        // not restored yet Missing, and Manual Recovery would reopen them.
        await waitForStartupSettling();
        await reconcileOnce();
      } catch (error: unknown) {
        console.error(
          "Failed to reconcile Recovery Data before Manual Recovery",
          error,
        );
      }
    },
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
      // This control owns reconciliation timing, so it reconciles again even
      // when a Recovery Popup already drove the startup phase to completion.
      if (result) {
        await result.catch(() => undefined);
      }
      const recoverySet = await runReconciliation();
      result = Promise.resolve(recoverySet);
      const latestState = await readState();
      if (latestState?.armed) {
        await writeState({ ...latestState, completed: true });
      }
      return recoverySet;
    },
    simulateStartupForTest: async () => {
      if (!automatedTestControlsEnabled) {
        return false;
      }
      handleStartup();
      await startupArming;
      return true;
    },
    scheduleAfterTabActivity: () => {
      if (reconciliationInFlight) {
        tabActivityDuringReconciliation = true;
        return;
      }
      void startupStateReady
        .then(async () => {
          if (reconciliationInFlight) {
            tabActivityDuringReconciliation = true;
            return;
          }
          if (!lateRestorationPending) {
            return;
          }
          const state = await readState();
          if (!state?.armed || !withinLateRestorationWindow(state)) {
            lateRestorationPending = false;
            return;
          }
          scheduleLateReconciliation();
        })
        .catch((error: unknown) => {
          console.error(
            "Failed to schedule reconciliation after startup tab activity",
            error,
          );
        });
    },
  };
}
