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

async function setTabOpenState(
  worker: Worker,
  recordId: string,
  browserTabId: number | undefined,
): Promise<void> {
  await worker.evaluate(
    async ({ recordId, browserTabId }) => {
      const { recoverySet } = (await chrome.storage.local.get("recoverySet")) as {
        recoverySet: RecoverySet;
      };
      const tab = recoverySet.windows
        .flatMap((grouping) => grouping.tabs)
        .find((candidate) => candidate.recordId === recordId);
      if (!tab) throw new Error(`Missing recovery record: ${recordId}`);
      if (browserTabId === undefined) delete tab.browserTabId;
      else tab.browserTabId = browserTabId;
      await chrome.storage.local.set({ recoverySet });
    },
    { recordId, browserTabId },
  );
}

async function createBrowserWindow(worker: Worker, url: string): Promise<number> {
  return worker.evaluate(async (url) => {
    const browserWindow = await chrome.windows.create({ type: "normal", url });
    if (browserWindow.id === undefined) throw new Error("Chromium did not return a window ID");
    return browserWindow.id;
  }, url);
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

    const dimensions = await popup.evaluate(() => ({
      bodyWidth: document.body.getBoundingClientRect().width,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(dimensions.bodyWidth).toBeLessThanOrEqual(384);
    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);

    await popup.emulateMedia({ colorScheme: "dark" });
    const darkBackground = await popup.locator("body").evaluate(
      (body) => getComputedStyle(body).backgroundColor,
    );
    await popup.emulateMedia({ colorScheme: "light" });
    const lightBackground = await popup.locator("body").evaluate(
      (body) => getComputedStyle(body).backgroundColor,
    );
    expect(darkBackground).not.toBe(lightBackground);

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

    const focusOrder: Array<{ label: string | null; hidden: boolean }> = [];
    for (let index = 0; index < 3; index += 1) {
      await popup.keyboard.press("Shift+Tab");
    }
    for (let index = 0; index < 9; index += 1) {
      if (index > 0) await popup.keyboard.press("Tab");
      focusOrder.push(
        await popup.evaluate(() => {
          const active = document.activeElement as HTMLElement;
          return {
            label: active.getAttribute("aria-label") ?? active.textContent,
            hidden: active.closest("[hidden]") !== null,
          };
        }),
      );
    }
    expect(focusOrder).toEqual([
      { label: "Restore All", hidden: false },
      { label: "Project notes", hidden: false },
      { label: "Restore Tab: Project notes", hidden: false },
      { label: "More actions for Project notes", hidden: false },
      { label: "Quarterly roadmap", hidden: false },
      { label: "Restore Tab: Quarterly roadmap", hidden: false },
      { label: "More actions for Quarterly roadmap", hidden: false },
      { label: "Restore Window", hidden: false },
      { label: "Forget Window", hidden: false },
    ]);
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

test("Restore Window keeps failures scoped and other windows actionable", async () => {
  const extension = await launchExtensionProfile({ automatedTest: true });
  try {
    const failedWindowId = await createBrowserWindow(
      extension.serviceWorker,
      "https://example.test/restore-window-failed",
    );
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "failed-window",
          browserWindowId: failedWindowId,
          tabs: [missingTab("failed-window-tab", "https://example.test/failed", 0)],
        },
        { groupingId: "other-window", tabs: [missingTab("other-window-tab", "https://example.test/other", 0)] },
      ],
    });
    const popup = await extension.openPopup();
    await expect(
      popup.evaluate(async () =>
        chrome.runtime.sendMessage({
          type: "failNextTabCreationForAutomatedTest",
          recordId: "failed-window-tab",
        }),
      ),
    ).resolves.toEqual({ enabled: true });

    const failedWindow = popup.locator('[data-grouping-id="failed-window"]');
    const failedRestore = failedWindow.getByRole("button", { name: "Restore Window" });
    const otherRestore = popup
      .locator('[data-grouping-id="other-window"]')
      .getByRole("button", { name: "Restore Window" });
    const pending = await failedRestore.evaluate((button: HTMLButtonElement) => {
      button.click();
      return { disabled: button.disabled, text: button.textContent };
    });
    expect(pending).toEqual({ disabled: true, text: "Restoring…" });
    await expect(otherRestore).toBeEnabled();
    await expect(failedWindow.getByRole("alert")).toContainText("Could not restore this window");
    await expect(popup.locator("#popup-status")).toHaveText("Recovery needs attention");
    await expect(failedRestore).toBeEnabled();
    await expect(otherRestore).toBeEnabled();
  } finally {
    await extension.close();
  }
});

test("Restore All keeps failed records visible and retryable after a partial failure", async () => {
  const extension = await launchExtensionProfile({ automatedTest: true });
  try {
    const failedWindowId = await createBrowserWindow(
      extension.serviceWorker,
      "https://example.test/restore-all-failed-window",
    );
    const successfulWindowId = await createBrowserWindow(
      extension.serviceWorker,
      "https://example.test/restore-all-success-window",
    );
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "first-window",
          browserWindowId: failedWindowId,
          tabs: [missingTab("restore-all-failed", "https://example.test/failed", 0)],
        },
        {
          groupingId: "second-window",
          browserWindowId: successfulWindowId,
          tabs: [missingTab("restore-all-success", "https://example.test/success", 0)],
        },
      ],
    });
    const popup = await extension.openPopup();
    await popup.evaluate(async () =>
      chrome.runtime.sendMessage({
        type: "failNextTabCreationForAutomatedTest",
        recordId: "restore-all-failed",
      }),
    );

    const restoreAll = popup.getByRole("button", { name: "Restore All" });
    const pending = await restoreAll.evaluate((button: HTMLButtonElement) => {
      button.click();
      return { disabled: button.disabled, text: button.textContent };
    });
    expect(pending).toEqual({ disabled: true, text: "Restoring…" });
    await expect(popup.locator(".recovery-summary").getByRole("alert")).toContainText(
      "Could not restore all missing tabs",
    );
    await expect(popup.locator("#popup-status")).toHaveText("Recovery needs attention");
    await expect(popup.getByText("restore-all-failed", { exact: true })).toBeVisible();
    await expect(popup.getByText("restore-all-success", { exact: true })).toHaveCount(0);
    await expect(restoreAll).toBeEnabled();
    await restoreAll.click();
    await expect(popup.getByText("restore-all-failed", { exact: true })).toHaveCount(0);
  } finally {
    await extension.close();
  }
});

test("Forget actions show pending feedback, remain retryable, and recover focus after refresh", async () => {
  const extension = await launchExtensionProfile();
  try {
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        { groupingId: "retry-forget", tabs: [missingTab("retry-forget-tab", "https://example.test/retry", 0)] },
        {
          groupingId: "focus-forget",
          tabs: [
            missingTab("forget-first", "https://example.test/first", 0),
            missingTab("forget-last", "https://example.test/last", 1),
          ],
        },
      ],
    });
    const popup = await extension.openPopup();

    await setTabOpenState(extension.serviceWorker, "retry-forget-tab", 1);
    const retryCard = popup.locator('[data-grouping-id="retry-forget"]');
    await retryCard.getByRole("button", { name: "More actions for retry-forget-tab" }).click();
    const retryForget = retryCard.getByRole("menuitem", { name: "Forget Tab: retry-forget-tab" });
    const pending = await retryForget.evaluate((button: HTMLButtonElement) => {
      button.click();
      return { disabled: button.disabled, text: button.textContent };
    });
    expect(pending).toEqual({ disabled: true, text: "Forgetting…" });
    await expect(retryCard.getByRole("alert")).toContainText("Could not forget this tab");
    await expect(retryForget).toBeEnabled();

    await setTabOpenState(extension.serviceWorker, "retry-forget-tab", undefined);
    await retryForget.click();
    await expect(retryCard).toHaveCount(0);

    const focusCard = popup.locator('[data-grouping-id="focus-forget"]');
    await focusCard.getByRole("button", { name: "More actions for forget-first" }).click();
    await focusCard.getByRole("menuitem", { name: "Forget Tab: forget-first" }).click();
    await expect(focusCard.getByRole("button", { name: "Restore Window" })).toBeFocused();

    popup.once("dialog", (dialog) => dialog.accept());
    const forgetWindow = focusCard.getByRole("button", { name: "Forget Window" });
    const pendingWindow = await forgetWindow.evaluate((button: HTMLButtonElement) => {
      button.click();
      return { disabled: button.disabled, text: button.textContent };
    });
    expect(pendingWindow).toEqual({ disabled: true, text: "Forgetting…" });
    await expect(popup.locator("#popup-title")).toBeFocused();
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
