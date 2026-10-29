import { expect, test, type Worker } from "@playwright/test";
import type { RecoverySet, TrackedTab } from "../../src/recovery-model";
import { launchExtensionProfile } from "./extension-profile";
import { readRecoverySet } from "./recovery-data";

function missingTab(recordId: string, url: string, index: number): TrackedTab {
  return {
    recordId,
    missingReason: "startup",
    title: recordId,
    url,
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

async function recordIds(serviceWorker: Worker): Promise<string[][]> {
  const set = await readRecoverySet(serviceWorker);
  return (set?.windows ?? []).map((grouping) =>
    grouping.tabs.map((tab) => tab.recordId),
  );
}

test("Check open tabs forgets only confirmed Missing Tabs whose address is open", async () => {
  const extension = await launchExtensionProfile();

  try {
    const openTabs = await extension.serviceWorker.evaluate(async () => {
      const browserWindow = await chrome.windows.create({
        type: "normal",
        url: ["https://example.com/first", "https://example.com/second"],
      });
      // Tab tracking rewrites titles as pages load, which would race the seed.
      for (;;) {
        const tabs = await chrome.tabs.query({ windowId: browserWindow.id });
        if (tabs.every((tab) => tab.status === "complete")) return tabs;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "live-window",
          browserWindowId: openTabs[0]!.windowId,
          tabs: openTabs.map((tab, index) => ({
            recordId: `live-${index}`,
            browserTabId: tab.id,
            title: tab.title ?? tab.url!,
            url: tab.url!,
            placement: { index: tab.index, pinned: tab.pinned },
          })),
        },
        {
          groupingId: "stale-copy",
          tabs: [
            missingTab("stale-first", "https://example.com/first", 0),
            missingTab("stale-second", "https://example.com/second#later", 1),
            missingTab("not-open-anywhere", "https://example.com/gone", 2),
          ],
        },
      ],
    });

    const popup = await extension.openPopup();
    const check = popup.getByRole("button", { name: "Check open tabs" });
    await expect(popup.getByText("stale-first", { exact: true })).toBeVisible();

    const nativeDialogs: string[] = [];
    popup.on("dialog", async (dialog) => {
      nativeDialogs.push(dialog.message());
      await dialog.dismiss();
    });
    const confirmation = popup.getByRole("dialog", {
      name: "Forget 2 missing tabs that are already open in a window?",
    });
    await check.click();
    await expect(confirmation).toBeVisible();
    await confirmation.getByRole("button", { name: "Cancel" }).click();
    await expect(popup.getByRole("dialog")).toHaveCount(0);
    await expect(check).toBeEnabled();
    await expect(popup.getByText("stale-first", { exact: true })).toBeVisible();
    expect(await recordIds(extension.serviceWorker)).toEqual([
      ["live-0", "live-1"],
      ["stale-first", "stale-second", "not-open-anywhere"],
    ]);
    expect(await badgeText(extension.serviceWorker)).toBe("3");

    await check.click();
    await confirmation.getByRole("button", { name: "Forget" }).click();
    await expect(popup.locator(".inline-note")).toHaveText(
      /^Forgot 2 tabs already open$/,
    );
    await expect(popup.getByText("stale-first", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("stale-second", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("not-open-anywhere", { exact: true })).toBeVisible();
    expect(await recordIds(extension.serviceWorker)).toEqual([
      ["live-0", "live-1"],
      ["not-open-anywhere"],
    ]);
    await expect.poll(() => badgeText(extension.serviceWorker)).toBe("1");

    await popup.getByRole("button", { name: "Check open tabs" }).click();
    await expect(popup.locator(".inline-note")).toHaveText(
      /^None of the missing tabs are open$/,
    );
    await expect(popup.getByRole("dialog")).toHaveCount(0);
    expect(nativeDialogs).toEqual([]);
    expect(await recordIds(extension.serviceWorker)).toEqual([
      ["live-0", "live-1"],
      ["not-open-anywhere"],
    ]);
  } finally {
    await extension.close();
  }
});
