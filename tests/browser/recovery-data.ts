import type { Worker } from "@playwright/test";
import type { RecoverySet } from "../../src/recovery-model";

export type {
  RecoverySet,
  TrackedTab,
  WindowGrouping,
} from "../../src/recovery-model";

export async function readRecoverySet(serviceWorker: Worker): Promise<RecoverySet | undefined> {
  return serviceWorker.evaluate(async () => {
    const { recoverySet } = (await chrome.storage.local.get("recoverySet")) as {
      recoverySet?: RecoverySet;
    };
    return recoverySet;
  });
}
