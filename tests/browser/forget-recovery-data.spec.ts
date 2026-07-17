import { expect, test, type Worker } from "@playwright/test";
import type { RecoverySet, TrackedTab } from "../../src/recovery-model";
import { launchExtensionProfile } from "./extension-profile";
import { readRecoverySet } from "./recovery-data";

function missingTab(recordId: string, index: number): TrackedTab {
  return {
    recordId,
    missingReason: "window-closure",
    title: recordId,
    url: `https://example.com/${recordId}`,
    placement: { index, pinned: false },
  };
}

async function seedRecoverySet(
  serviceWorker: Worker,
  recoverySet: RecoverySet,
): Promise<void> {
  await expect
    .poll(async () => {
      const set = await readRecoverySet(serviceWorker);
      return set?.windows.flatMap((grouping) => grouping.tabs).length ?? 0;
    })
    .toBeGreaterThan(0);
  await serviceWorker.evaluate(
    async (set) => chrome.storage.local.set({ recoverySet: set }),
    recoverySet,
  );
  await expect.poll(() => readRecoverySet(serviceWorker)).toEqual(recoverySet);
}

async function badgeText(serviceWorker: Worker): Promise<string> {
  return serviceWorker.evaluate(async () => chrome.action.getBadgeText({}));
}

test("Forget actions expose whole-group Forget only for an entirely missing Window Grouping and persist", async () => {
  const extension = await launchExtensionProfile();

  try {
    const openTab = await extension.serviceWorker.evaluate(async () => {
      const browserWindow = await chrome.windows.create({
        type: "normal",
        url: "https://example.com/open-record",
      });
      return browserWindow.tabs![0]!;
    });
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "one-tab-at-a-time",
          browserWindowId: openTab.windowId,
          tabs: [
            {
              recordId: "open-record",
              browserTabId: openTab.id,
              title: "Open protected tab",
              url: "https://example.com/open-record",
              placement: { index: openTab.index, pinned: openTab.pinned },
            },
            missingTab("keep-this-tab", 1),
            missingTab("forget-this-tab", 2),
          ],
        },
        {
          groupingId: "forget-this-window",
          tabs: [missingTab("window-first-tab", 0), missingTab("window-second-tab", 1)],
        },
      ],
    });

    let popup = await extension.openPopup();
    const dialogs: string[] = [];
    popup.on("dialog", async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const partialWindowGrouping = popup
      .locator(".missing-window-grouping")
      .filter({ hasText: "forget-this-tab" });
    await expect(
      partialWindowGrouping.getByRole("heading", {
        name: "Missing Window Grouping",
      }),
    ).toBeVisible();
    await expect(
      partialWindowGrouping.getByRole("button", { name: "Forget Window" }),
    ).toHaveCount(0);
    await partialWindowGrouping
      .getByRole("button", { name: "Forget Tab: forget-this-tab" })
      .click();
    expect(dialogs).toEqual([]);
    await expect(popup.getByText("forget-this-tab", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("keep-this-tab", { exact: true })).toBeVisible();
    await expect.poll(() => badgeText(extension.serviceWorker)).toBe("3");

    await popup.close();
    popup = await extension.openPopup();
    await expect(popup.getByText("forget-this-tab", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("keep-this-tab", { exact: true })).toBeVisible();

    const windowGrouping = popup
      .locator(".missing-window-grouping")
      .filter({ hasText: "window-first-tab" });
    popup.once("dialog", (dialog) => dialog.dismiss());
    await windowGrouping.getByRole("button", { name: "Forget Window" }).click();
    await expect(windowGrouping.getByText("window-first-tab", { exact: true })).toBeVisible();
    await expect.poll(() => badgeText(extension.serviceWorker)).toBe("3");

    await popup.close();
    popup = await extension.openPopup();
    await expect(popup.getByText("window-first-tab", { exact: true })).toBeVisible();
    popup.once("dialog", (dialog) => dialog.accept());
    await popup
      .locator(".missing-window-grouping")
      .filter({ hasText: "window-first-tab" })
      .getByRole("button", { name: "Forget Window" })
      .click();
    await expect(popup.getByText("window-first-tab", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("window-second-tab", { exact: true })).toHaveCount(0);
    await expect.poll(() => badgeText(extension.serviceWorker)).toBe("1");

    const rejectionResults = await popup.evaluate(async () =>
      Promise.all([
        chrome.runtime.sendMessage({ type: "forgetTab", recordId: "open-record" }),
        chrome.runtime.sendMessage({
          type: "forgetWindowGrouping",
          groupingId: "one-tab-at-a-time",
        }),
      ]),
    );
    expect(rejectionResults).toEqual([
      { forgotten: false, reason: "record-is-open" },
      { forgotten: false, reason: "grouping-has-open-records" },
    ]);

    await popup.close();
    popup = await extension.openPopup();
    await expect(popup.getByText("keep-this-tab", { exact: true })).toBeVisible();
    await expect(popup.getByText("forget-this-tab", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("window-first-tab", { exact: true })).toHaveCount(0);
    await expect.poll(() => badgeText(extension.serviceWorker)).toBe("1");

    const persisted = (await readRecoverySet(extension.serviceWorker))!;
    expect(
      persisted.windows.map((grouping) => ({
        groupingId: grouping.groupingId,
        recordIds: grouping.tabs.map((tab) => tab.recordId),
      })),
    ).toEqual([
      {
        groupingId: "one-tab-at-a-time",
        recordIds: ["open-record", "keep-this-tab"],
      },
    ]);
  } finally {
    await extension.close();
  }
});
