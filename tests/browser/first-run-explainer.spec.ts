import { expect, test, type Worker } from "@playwright/test";
import type { RecoverySet, TrackedTab } from "../../src/recovery-model";
import { launchExtensionProfile } from "./extension-profile";
import {
  clearStoredFirstRunExplainerDismissed,
  readStoredFirstRunExplainerDismissed,
} from "./preference-state";
import { readRecoverySet } from "./recovery-data";

function missingTab(recordId: string, url: string, index: number): TrackedTab {
  return {
    recordId,
    missingReason: "window-closure",
    title: recordId,
    url,
    placement: { index, pinned: false },
  };
}

async function seedRecoverySet(worker: Worker, set: RecoverySet): Promise<void> {
  await expect.poll(() => readRecoverySet(worker)).not.toBeUndefined();
  await worker.evaluate(
    async (recoverySet) => chrome.storage.local.set({ recoverySet }),
    set,
  );
  await expect.poll(() => readRecoverySet(worker)).toEqual(set);
}

test("the first-run explainer appears on a fresh install", async () => {
  const extension = await launchExtensionProfile();
  try {
    const popup = await extension.openPopup();
    const explainer = popup.locator("#first-run-explainer");
    await expect(explainer).toBeVisible();
    await expect(explainer.getByRole("heading", { name: "Welcome", exact: true })).toBeVisible();
    await expect(explainer.getByText(/never\s+restores\s+tabs\s+on\s+its\s+own/i)).toBeVisible();
  } finally {
    await extension.close();
  }
});

test("dismissing the explainer hides it, persists outside Recovery Data, and stays hidden across reopen", async () => {
  const extension = await launchExtensionProfile();
  try {
    await seedRecoverySet(extension.serviceWorker, { version: 1, windows: [] });
    const recoverySetBeforeDismiss = await readRecoverySet(extension.serviceWorker);

    const popup = await extension.openPopup();
    const explainer = popup.locator("#first-run-explainer");
    await expect(explainer).toBeVisible();

    await popup.getByRole("button", { name: "Dismiss welcome explainer" }).click();
    await expect(explainer).toBeHidden();
    await expect(popup.locator("#popup-title")).toBeFocused();

    await expect
      .poll(() => readStoredFirstRunExplainerDismissed(extension.serviceWorker))
      .toBe(true);
    expect(await readRecoverySet(extension.serviceWorker)).toEqual(recoverySetBeforeDismiss);

    await popup.close();
    const reopened = await extension.openPopup();
    await expect(reopened.locator("#first-run-explainer")).toBeHidden();
  } finally {
    await extension.close();
  }
});

test("completing a first recovery dismisses the explainer", async () => {
  const extension = await launchExtensionProfile();
  try {
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "first-window",
          tabs: [missingTab("recover-me", "https://example.test/recover", 0)],
        },
      ],
    });

    const popup = await extension.openPopup();
    await expect(popup.locator("#first-run-explainer")).toBeVisible();

    await popup.getByRole("button", { name: "Restore Tab: recover-me" }).click();
    await expect(popup.getByText("recover-me", { exact: true })).toHaveCount(0);

    await expect(popup.locator("#first-run-explainer")).toBeHidden();
    await expect
      .poll(() => readStoredFirstRunExplainerDismissed(extension.serviceWorker))
      .toBe(true);
  } finally {
    await extension.close();
  }
});

test("clearing the dismissed flag re-shows the explainer without affecting Recovery Data", async () => {
  const extension = await launchExtensionProfile();
  try {
    await seedRecoverySet(extension.serviceWorker, { version: 1, windows: [] });
    const popup = await extension.openPopup();
    await popup.getByRole("button", { name: "Dismiss welcome explainer" }).click();
    await expect(popup.locator("#first-run-explainer")).toBeHidden();
    const recoverySetBeforeClear = await readRecoverySet(extension.serviceWorker);
    await popup.close();

    await clearStoredFirstRunExplainerDismissed(extension.serviceWorker);

    const reopened = await extension.openPopup();
    await expect(reopened.locator("#first-run-explainer")).toBeVisible();
    expect(await readRecoverySet(extension.serviceWorker)).toEqual(recoverySetBeforeClear);
  } finally {
    await extension.close();
  }
});
