import { expect, test, type Worker } from "@playwright/test";
import type { RecoverySet, TrackedTab } from "../../src/recovery-model";
import { launchExtensionProfile } from "./extension-profile";
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

test("the Recovery Popup shows a reassuring empty state", async () => {
  const extension = await launchExtensionProfile();
  try {
    await seedRecoverySet(extension.serviceWorker, { version: 1, windows: [] });
    const popup = await extension.openPopup();
    await expect(popup.getByText("All tabs are available", { exact: true })).toBeVisible();
    await expect(popup.getByRole("button", { name: "Restore All" })).toHaveCount(0);
    await expect(popup.locator(".missing-window-grouping")).toHaveCount(0);
  } finally {
    await extension.close();
  }
});

test("the Recovery Popup presents missing tabs by Window first", async () => {
  const extension = await launchExtensionProfile();
  try {
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "first-window",
          tabs: [
            missingTab("Project notes", "https://notion.so/project", 0),
            missingTab("Quarterly roadmap", "https://docs.google.com/roadmap", 1),
          ],
        },
      ],
    });
    const popup = await extension.openPopup();
    const card = popup.locator(".missing-window-grouping");
    await expect(popup.getByText("2 tabs missing", { exact: true })).toBeVisible();
    await expect(popup.getByText("1 missing window", { exact: true })).toBeVisible();
    await expect(card.getByText("Window 1", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Restore Window" })).toBeVisible();
    await expect(card.getByText("notion.so", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Restore Tab: Project notes" })).toBeVisible();
    const moreActions = popup.getByRole("button", {
      name: "More actions for Project notes",
    });
    await expect(moreActions).toHaveAttribute("aria-expanded", "false");
    await moreActions.click();
    await expect(moreActions).toHaveAttribute("aria-expanded", "true");
    await expect(
      popup.getByRole("menuitem", { name: "Forget Tab: Project notes" }),
    ).toBeVisible();
    await popup.keyboard.press("Escape");
    await expect(moreActions).toBeFocused();
    await expect(moreActions).toHaveAttribute("aria-expanded", "false");
  } finally {
    await extension.close();
  }
});

test("recovery actions show scoped pending feedback, inline failures, and remain retryable", async () => {
  const extension = await launchExtensionProfile({ automatedTest: true });
  try {
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "retry-window",
          tabs: [missingTab("retry-tab", "https://example.test/retry", 0)],
        },
        {
          groupingId: "other-window",
          tabs: [missingTab("other-tab", "https://example.test/other", 0)],
        },
      ],
    });
    const popup = await extension.openPopup();
    await expect(
      popup.evaluate(async () =>
        chrome.runtime.sendMessage({
          type: "failNextTabCreationForAutomatedTest",
          recordId: "retry-tab",
        }),
      ),
    ).resolves.toEqual({ enabled: true });

    const restore = popup.getByRole("button", { name: "Restore Tab: retry-tab" });
    const pending = await restore.evaluate((button: HTMLButtonElement) => {
      button.click();
      return { disabled: button.disabled, text: button.textContent };
    });
    expect(pending).toEqual({ disabled: true, text: "Restoring…" });
    await expect(popup.getByRole("alert")).toContainText("Could not restore this tab");
    await expect(restore).toBeEnabled();
    await restore.click();
    await expect(popup.getByText("retry-tab", { exact: true })).toHaveCount(0);

    const firstWindow = popup.locator(".missing-window-grouping").filter({ hasText: "other-tab" });
    const restoreWindow = firstWindow.getByRole("button", { name: "Restore Window" });
    const pendingWindow = await restoreWindow.evaluate((button: HTMLButtonElement) => {
      button.click();
      return { disabled: button.disabled, text: button.textContent };
    });
    expect(pendingWindow).toEqual({ disabled: true, text: "Restoring…" });
    await expect(firstWindow).toHaveCount(0);
  } finally {
    await extension.close();
  }
});

test("recovery refresh moves focus to a surviving card or the popup heading", async () => {
  const extension = await launchExtensionProfile();
  try {
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "focus-window",
          tabs: [
            missingTab("focus-first", "https://example.test/focus-first", 0),
            missingTab("focus-last", "https://example.test/focus-last", 1),
          ],
        },
      ],
    });
    const popup = await extension.openPopup();
    await popup.getByRole("button", { name: "Restore Tab: focus-first" }).click();
    await expect(popup.getByRole("button", { name: "Restore Window" })).toBeFocused();
    await popup.getByRole("button", { name: "Restore Window" }).click();
    await expect(popup.locator("#popup-title")).toBeFocused();
  } finally {
    await extension.close();
  }
});
