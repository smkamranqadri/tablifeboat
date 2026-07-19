import type { RecoverySet } from "./recovery-model.js";
import type { RecoveryStore } from "./recovery-store.js";
import { hasStartupMissingTabs } from "./recovery-status.js";
import { reconcileWindows } from "./reconciliation-core.js";

// Native restoration is asynchronous. Give Chromium a fixed opportunity to
// finish rebuilding windows before deciding which Recovery Data is missing.
export const STARTUP_SETTLING_MS = 5_000;
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
  reconcileAfterStartupSettlingForTest(): Promise<RecoverySet | undefined>;
  simulateStartupForTest(): Promise<boolean>;
  scheduleAfterTabActivity(): void;
}

export async function reconcileRecoverySet(
  store: RecoveryStore,
  openTabs: chrome.tabs.Tab[],
  recoverySetAtWorkerStart?: RecoverySet,
): Promise<RecoverySet> {
  return store.update((set) =>
    reconcileWindows(set, openTabs, recoverySetAtWorkerStart),
  );
}

export async function reconcileOpenTabsAfterStartup(
  store: RecoveryStore,
  recoverySetAtWorkerStart?: RecoverySet,
): Promise<RecoverySet> {
  const openTabs = await chrome.tabs.query({ windowType: "normal" });
  return reconcileRecoverySet(store, openTabs, recoverySetAtWorkerStart);
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
        lateRestorationPending = hasStartupMissingTabs(recoverySet);
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
      } else if (state?.armed && state.completed) {
        lateRestorationPending = hasStartupMissingTabs(
          await readCurrentRecoverySet(),
        );
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
    scheduleAfterTabActivity: () => {
      void startupStateReady
        .then(() => {
          if (!lateRestorationPending) {
            return;
          }
          if (lateRestorationTimer !== undefined) {
            clearTimeout(lateRestorationTimer);
          }
          lateRestorationTimer = setTimeout(() => {
            lateRestorationTimer = undefined;
            void operation({ claimStartupNotification })
              .then((recoverySet) => {
                lateRestorationPending = hasStartupMissingTabs(recoverySet);
              })
              .catch((error: unknown) => {
                console.error(
                  "Failed to reconcile late native tab restoration",
                  error,
                );
              });
          }, 100);
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
