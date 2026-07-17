import { createServer, type Server } from "node:http";
import { expect, test, type Worker } from "@playwright/test";
import type { RecoverySet, TrackedTab } from "../../src/recovery-model";
import { launchExtensionProfile } from "./extension-profile";
import { readRecoverySet } from "./recovery-data";

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const title = request.url?.slice(1) || "Web Tab";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the test HTTP server to listen on a TCP port");
  }
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function recoveryTab(
  recordId: string,
  url: string,
  index: number,
  pinned: boolean,
  browserTabId?: number,
): TrackedTab {
  return {
    recordId,
    browserTabId,
    title: url.slice(url.lastIndexOf("/") + 1),
    url,
    placement: { index, pinned },
    ...(browserTabId === undefined ? { missingReason: "startup" as const } : {}),
  };
}

async function createRecoverableWindow(
  serviceWorker: Worker,
  url: string,
): Promise<{ windowId: number; tabId: number }> {
  return serviceWorker.evaluate(async (address) => {
    const browserWindow = await chrome.windows.create({ type: "normal", url: address });
    return {
      windowId: browserWindow.id!,
      tabId: browserWindow.tabs![0]!.id!,
    };
  }, url);
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

async function readOpenWebWindows(serviceWorker: Worker) {
  return serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const windows = new Map<
      number,
      Array<{ url: string; index: number; pinned: boolean }>
    >();
    for (const tab of tabs) {
      if (
        tab.url === undefined ||
        (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))
      ) {
        continue;
      }
      const windowTabs = windows.get(tab.windowId) ?? [];
      windowTabs.push({ url: tab.url, index: tab.index, pinned: tab.pinned });
      windows.set(tab.windowId, windowTabs);
    }
    return Array.from(windows, ([windowId, tabs]) => ({
      windowId,
      tabs: tabs.sort((left, right) => left.index - right.index),
    })).sort((left, right) => left.windowId - right.windowId);
  });
}

test("Restore All repairs partial and absent Window Groupings without duplicating durable records", async () => {
  const extension = await launchExtensionProfile();
  const openUrl = `${origin}/all-partial-open`;
  const partialMissingUrl = `${origin}/all-partial-missing`;
  const absentUrls = [`${origin}/all-absent-pinned`, `${origin}/all-absent-last`];

  try {
    const partialWindow = await createRecoverableWindow(
      extension.serviceWorker,
      openUrl,
    );
    const intendedRecordIds = [
      "all-partial-missing",
      "all-partial-open",
      "all-absent-pinned",
      "all-absent-last",
    ];
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "all-partial-grouping",
          browserWindowId: partialWindow.windowId,
          tabs: [
            recoveryTab("all-partial-missing", partialMissingUrl, 0, true),
            recoveryTab("all-partial-open", openUrl, 1, false, partialWindow.tabId),
          ],
        },
        {
          groupingId: "all-absent-grouping",
          tabs: absentUrls.map((url, index) =>
            recoveryTab(
              index === 0 ? "all-absent-pinned" : "all-absent-last",
              url,
              index,
              index === 0,
            ),
          ),
        },
      ],
    });

    const popup = await extension.openPopup();
    await expect(popup.getByRole("button", { name: "Restore All" })).toBeVisible();
    await popup.getByRole("button", { name: "Restore All" }).click();

    await expect(popup.getByText("4 open protected tabs")).toBeVisible();
    await expect(popup.locator(".missing-window")).toHaveCount(0);
    await expect
      .poll(() =>
        extension.serviceWorker.evaluate(async () =>
          chrome.action.getBadgeText({}),
        ),
      )
      .toBe("");
    await expect.poll(() => readOpenWebWindows(extension.serviceWorker)).toEqual([
      {
        windowId: partialWindow.windowId,
        tabs: [
          { url: partialMissingUrl, index: 0, pinned: true },
          { url: openUrl, index: 1, pinned: false },
        ],
      },
      {
        windowId: expect.any(Number),
        tabs: absentUrls.map((url, index) => ({
          url,
          index,
          pinned: index === 0,
        })),
      },
    ]);

    const recoverySet = (await readRecoverySet(extension.serviceWorker))!;
    const durableRecordIds = recoverySet.windows.flatMap((grouping) =>
      grouping.tabs.map((tab) => tab.recordId),
    );
    expect(durableRecordIds).toEqual(intendedRecordIds);
    expect(new Set(durableRecordIds).size).toBe(intendedRecordIds.length);
    expect(
      recoverySet.windows
        .flatMap((grouping) => grouping.tabs)
        .every((tab) => tab.browserTabId !== undefined),
    ).toBe(true);
  } finally {
    await extension.close();
  }
});

test("a Failed Recovery stays missing and a later Restore All retries the same durable record", async () => {
  const extension = await launchExtensionProfile({ automatedTest: true });
  const openUrl = `${origin}/retry-open`;
  const missingUrls = [
    `${origin}/retry-first`,
    `${origin}/retry-failed`,
    `${origin}/retry-later`,
  ];

  try {
    const browserWindow = await createRecoverableWindow(
      extension.serviceWorker,
      openUrl,
    );
    const intendedRecordIds = [
      "retry-open",
      "retry-first",
      "retry-failed",
      "retry-later",
    ];
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "retry-grouping",
          browserWindowId: browserWindow.windowId,
          tabs: [
            recoveryTab("retry-open", openUrl, 0, false, browserWindow.tabId),
            ...missingUrls.map((url, index) =>
              recoveryTab(
                ["retry-first", "retry-failed", "retry-later"][index]!,
                url,
                index + 1,
                false,
              ),
            ),
          ],
        },
      ],
    });

    const popup = await extension.openPopup();
    await expect(
      popup.evaluate(async () =>
        chrome.runtime.sendMessage({
          type: "failNextTabCreationForAutomatedTest",
          recordId: "retry-failed",
        }),
      ),
    ).resolves.toEqual({ enabled: true });

    const firstResult = await popup.evaluate(async () =>
      chrome.runtime.sendMessage({ type: "restoreAll" }),
    );
    expect(firstResult).toEqual({
      restoredRecordIds: ["retry-first", "retry-later"],
      failedRecordIds: ["retry-failed"],
    });
    await popup.reload();

    await expect(popup.getByText("retry-failed", { exact: true })).toBeVisible();
    await expect(popup.getByText("retry-first", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("retry-later", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("3 open protected tabs")).toBeVisible();
    await expect
      .poll(() =>
        extension.serviceWorker.evaluate(async () =>
          chrome.action.getBadgeText({}),
        ),
      )
      .toBe("1");

    const failedSet = (await readRecoverySet(extension.serviceWorker))!;
    expect(
      failedSet.windows.flatMap((grouping) =>
        grouping.tabs.map((tab) => tab.recordId),
      ),
    ).toEqual(intendedRecordIds);
    const failedRecord = failedSet.windows[0]!.tabs.find(
      (tab) => tab.recordId === "retry-failed",
    )!;
    expect(failedRecord.browserTabId).toBeUndefined();
    expect(failedRecord.missingReason).toBe("startup");

    await popup.getByRole("button", { name: "Restore All" }).click();
    await expect(popup.locator(".missing-window")).toHaveCount(0);
    await expect(popup.getByText("4 open protected tabs")).toBeVisible();
    await expect
      .poll(() =>
        extension.serviceWorker.evaluate(async () =>
          chrome.action.getBadgeText({}),
        ),
      )
      .toBe("");

    const retriedSet = (await readRecoverySet(extension.serviceWorker))!;
    const retriedRecords = retriedSet.windows.flatMap((grouping) => grouping.tabs);
    expect(retriedRecords.map((tab) => tab.recordId)).toEqual(intendedRecordIds);
    expect(new Set(retriedRecords.map((tab) => tab.recordId)).size).toBe(
      intendedRecordIds.length,
    );
    expect(retriedRecords.every((tab) => tab.browserTabId !== undefined)).toBe(true);
    const openTabs = (await readOpenWebWindows(extension.serviceWorker)).flatMap(
      (window) => window.tabs,
    );
    for (const url of [openUrl, ...missingUrls]) {
      expect(openTabs.filter((tab) => tab.url === url)).toHaveLength(1);
    }
  } finally {
    await extension.close();
  }
});

test("the Recovery Popup keeps Restore All available after a Failed Recovery", async () => {
  const extension = await launchExtensionProfile({ automatedTest: true });
  const openUrl = `${origin}/popup-retry-open`;
  const failedUrl = `${origin}/popup-retry-failed`;

  try {
    const browserWindow = await createRecoverableWindow(
      extension.serviceWorker,
      openUrl,
    );
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "popup-retry-grouping",
          browserWindowId: browserWindow.windowId,
          tabs: [
            recoveryTab(
              "popup-retry-open",
              openUrl,
              0,
              false,
              browserWindow.tabId,
            ),
            recoveryTab("popup-retry-failed", failedUrl, 1, false),
          ],
        },
      ],
    });

    const popup = await extension.openPopup();
    await popup.evaluate(async () =>
      chrome.runtime.sendMessage({
        type: "failNextTabCreationForAutomatedTest",
        recordId: "popup-retry-failed",
      }),
    );
    const restoreAll = popup.getByRole("button", { name: "Restore All" });
    await restoreAll.click();

    await expect(popup.getByText("popup-retry-failed", { exact: true })).toBeVisible();
    await expect(restoreAll).toBeEnabled();
    await restoreAll.click();

    await expect(popup.getByText("popup-retry-failed", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("2 open protected tabs")).toBeVisible();
  } finally {
    await extension.close();
  }
});
