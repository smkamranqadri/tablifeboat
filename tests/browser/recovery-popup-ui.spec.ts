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
