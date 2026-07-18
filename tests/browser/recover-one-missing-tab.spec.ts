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
  browserTabId?: number,
): TrackedTab {
  return {
    recordId,
    browserTabId,
    title: url.slice(url.lastIndexOf("/") + 1),
    url,
    placement: { index, pinned: false },
    ...(browserTabId === undefined
      ? { missingReason: "window-closure" as const }
      : {}),
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

async function readOpenWebTabs(serviceWorker: Worker) {
  return serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    return tabs
      .filter(
        (tab) =>
          tab.id !== undefined &&
          tab.url !== undefined &&
          (tab.url.startsWith("http://") || tab.url.startsWith("https://")),
      )
      .map((tab) => ({
        tabId: tab.id!,
        windowId: tab.windowId,
        url: tab.url!,
      }));
  });
}

test("Restore Tab moves one Missing Tab into the active Window Grouping", async () => {
  const extension = await launchExtensionProfile();
  const activeUrl = `${origin}/active-protected`;
  const selectedUrl = `${origin}/selected-tab`;
  const remainingUrl = `${origin}/remaining-tab`;
  const selectedTitle = "selected-tab";

  try {
    const activeWindow = await createRecoverableWindow(
      extension.serviceWorker,
      activeUrl,
    );
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "active-grouping",
          browserWindowId: activeWindow.windowId,
          tabs: [recoveryTab("active-record", activeUrl, 0, activeWindow.tabId)],
        },
        {
          groupingId: "source-grouping",
          tabs: [
            recoveryTab("selected-record", selectedUrl, 0),
            recoveryTab("remaining-record", remainingUrl, 1),
          ],
        },
      ],
    });

    let popup = await extension.openPopup();
    await expect(popup.getByText("1 open protected tab")).toBeVisible();
    await expect
      .poll(() =>
        extension.serviceWorker.evaluate(async () => chrome.action.getBadgeText({})),
      )
      .toBe("2");

    await popup
      .getByRole("button", { name: `Restore Tab: ${selectedTitle}` })
      .click();

    await expect.poll(() => readOpenWebTabs(extension.serviceWorker)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          windowId: activeWindow.windowId,
          url: selectedUrl,
        }),
      ]),
    );
    expect(await readRecoverySet(extension.serviceWorker)).toMatchObject({
      windows: expect.arrayContaining([
        expect.objectContaining({
          browserWindowId: activeWindow.windowId,
          tabs: expect.arrayContaining([
            expect.objectContaining({
              recordId: "selected-record",
              browserTabId: expect.any(Number),
            }),
          ]),
        }),
        expect.objectContaining({
          groupingId: "source-grouping",
          tabs: [expect.objectContaining({ recordId: "remaining-record" })],
        }),
      ]),
    });

    await popup.close();
    popup = await extension.openPopup();
    await expect(popup.getByText(selectedTitle, { exact: true })).toHaveCount(0);
    await expect(popup.getByText("remaining-tab", { exact: true })).toBeVisible();
    await expect(popup.getByText("2 open protected tabs")).toBeVisible();
    await expect
      .poll(() =>
        extension.serviceWorker.evaluate(async () => chrome.action.getBadgeText({})),
      )
      .toBe("1");

    await popup.getByRole("button", { name: "Restore Window" }).click();
    await expect(popup.getByText("remaining-tab", { exact: true })).toHaveCount(0);
    await expect(popup.locator(".missing-window-grouping")).toHaveCount(0);

    await expect
      .poll(async () => {
        const openTabs = await readOpenWebTabs(extension.serviceWorker);
        return {
          selectedWindowIds: openTabs
            .filter((tab) => tab.url === selectedUrl)
            .map((tab) => tab.windowId),
          remainingWindowIds: openTabs
            .filter((tab) => tab.url === remainingUrl)
            .map((tab) => tab.windowId),
        };
      })
      .toEqual({
        selectedWindowIds: [activeWindow.windowId],
        remainingWindowIds: [expect.any(Number)],
      });
    const remainingOpenTab = (await readOpenWebTabs(extension.serviceWorker)).find(
      (tab) => tab.url === remainingUrl,
    )!;
    expect(remainingOpenTab.windowId).not.toBe(activeWindow.windowId);
    expect(await readRecoverySet(extension.serviceWorker)).toMatchObject({
      windows: expect.arrayContaining([
        expect.objectContaining({
          groupingId: "source-grouping",
          browserWindowId: remainingOpenTab?.windowId,
          tabs: [expect.objectContaining({ recordId: "remaining-record" })],
        }),
      ]),
    });
  } finally {
    await extension.close();
  }
});

test("a Failed Recovery keeps Restore Tab available for the same durable record", async () => {
  const extension = await launchExtensionProfile({ automatedTest: true });
  const activeUrl = `${origin}/retry-active`;
  const selectedUrl = `${origin}/retry-selected`;
  const remainingUrl = `${origin}/retry-remaining`;
  const seededRecoverySet: RecoverySet = {
    version: 1,
    windows: [],
  };

  try {
    const activeWindow = await createRecoverableWindow(
      extension.serviceWorker,
      activeUrl,
    );
    seededRecoverySet.windows = [
      {
        groupingId: "retry-active-grouping",
        browserWindowId: activeWindow.windowId,
        tabs: [
          recoveryTab("retry-active-record", activeUrl, 0, activeWindow.tabId),
        ],
      },
      {
        groupingId: "retry-source-grouping",
        tabs: [
          recoveryTab("retry-selected-record", selectedUrl, 0),
          recoveryTab("retry-remaining-record", remainingUrl, 1),
        ],
      },
    ];
    await seedRecoverySet(extension.serviceWorker, seededRecoverySet);

    const popup = await extension.openPopup();
    await expect(
      popup.evaluate(async () =>
        chrome.runtime.sendMessage({
          type: "failNextTabCreationForAutomatedTest",
          recordId: "retry-selected-record",
        }),
      ),
    ).resolves.toEqual({ enabled: true });

    const restoreTab = popup.getByRole("button", {
      name: "Restore Tab: retry-selected",
    });
    await restoreTab.click();

    await expect(restoreTab).toBeEnabled();
    expect(
      (await readOpenWebTabs(extension.serviceWorker)).some(
        (tab) => tab.url === selectedUrl,
      ),
    ).toBe(false);
    expect(await readRecoverySet(extension.serviceWorker)).toEqual(
      seededRecoverySet,
    );
    await expect
      .poll(() =>
        extension.serviceWorker.evaluate(async () => chrome.action.getBadgeText({})),
      )
      .toBe("2");

    await restoreTab.click();
    await expect(popup.getByText("retry-selected", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("retry-remaining", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        extension.serviceWorker.evaluate(async () => chrome.action.getBadgeText({})),
      )
      .toBe("1");

    const retriedSet = (await readRecoverySet(extension.serviceWorker))!;
    const retriedRecords = retriedSet.windows.flatMap((grouping) => grouping.tabs);
    expect(
      retriedRecords.filter(
        (tab) => tab.recordId === "retry-selected-record",
      ),
    ).toHaveLength(1);
    expect(
      (await readOpenWebTabs(extension.serviceWorker)).filter(
        (tab) => tab.url === selectedUrl,
      ),
    ).toHaveLength(1);
  } finally {
    await extension.close();
  }
});

test("an unknown Restore Tab request is a no-op without a normal window", async () => {
  const extension = await launchExtensionProfile();

  try {
    const popupPagePromise = extension.context.waitForEvent("page");
    await extension.serviceWorker.evaluate(async () => {
      await chrome.windows.create({
        type: "popup",
        url: chrome.runtime.getURL("popup.html"),
      });
    });
    const popup = await popupPagePromise;
    await popup.waitForLoadState();

    const remainingNormalWindowCount = await extension.serviceWorker.evaluate(
      async () => {
        const normalWindows = await chrome.windows.getAll({
          windowTypes: ["normal"],
        });
        await Promise.all(
          normalWindows.map((browserWindow) =>
            chrome.windows.remove(browserWindow.id!),
          ),
        );
        return (await chrome.windows.getAll({ windowTypes: ["normal"] })).length;
      },
    );
    const result = await popup.evaluate(async () =>
      chrome.runtime.sendMessage({
        type: "restoreTab",
        recordId: "unknown-record",
      }),
    );

    expect({ remainingNormalWindowCount, result }).toEqual({
      remainingNormalWindowCount: 0,
      result: { restoredRecordIds: [], failedRecordIds: [] },
    });
  } finally {
    await extension.close();
  }
});
