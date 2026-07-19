import type { Worker } from "@playwright/test";
import { FIRST_RUN_EXPLAINER_DISMISSED_KEY } from "../../src/preference-state";

export { FIRST_RUN_EXPLAINER_DISMISSED_KEY };

export async function readStoredFirstRunExplainerDismissed(worker: Worker): Promise<boolean> {
  return worker.evaluate(async (key) => {
    const stored = (await chrome.storage.local.get(key)) as Record<string, unknown>;
    return stored[key] === true;
  }, FIRST_RUN_EXPLAINER_DISMISSED_KEY);
}

export async function clearStoredFirstRunExplainerDismissed(worker: Worker): Promise<void> {
  await worker.evaluate(async (key) => {
    await chrome.storage.local.remove(key);
  }, FIRST_RUN_EXPLAINER_DISMISSED_KEY);
}
