export const FIRST_RUN_EXPLAINER_DISMISSED_KEY = "ui.firstRunDismissed";

export function parseFirstRunExplainerDismissed(stored: unknown): boolean {
  return stored === true;
}

export async function readFirstRunExplainerDismissed(): Promise<boolean> {
  const stored = await chrome.storage.local.get(FIRST_RUN_EXPLAINER_DISMISSED_KEY);
  return parseFirstRunExplainerDismissed(stored[FIRST_RUN_EXPLAINER_DISMISSED_KEY]);
}

export async function dismissFirstRunExplainer(): Promise<void> {
  await chrome.storage.local.set({ [FIRST_RUN_EXPLAINER_DISMISSED_KEY]: true });
}
