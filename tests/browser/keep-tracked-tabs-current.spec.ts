import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { launchExtensionProfile } from "./extension-profile";
import { readRecoverySet, type TrackedTab } from "./recovery-data";

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const title = request.url === "/first" ? "First page" : "Second page";
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

test("keeps each Tracked Tab current through navigation and Individual Tab Closure", async () => {
  const extension = await launchExtensionProfile();

  try {
    const expectProtectedCount = async (expectedCount: number): Promise<void> => {
      const popup = await extension.openPopup();
      const noun = expectedCount === 1 ? "tab" : "tabs";
      await expect(
        popup.getByText(`${expectedCount} open protected ${noun}`),
      ).toBeVisible();
      await popup.close();
    };
    const readTrackedTabs = async (): Promise<TrackedTab[]> => {
      const recoverySet = await readRecoverySet(extension.serviceWorker);
      return recoverySet?.windows.flatMap((window) => window.tabs) ?? [];
    };

    await expectProtectedCount(0);

    const webTab = await extension.context.newPage();
    await webTab.goto(`${origin}/first`);

    let firstRecord: TrackedTab | undefined;
    await expect
      .poll(async () => {
        const trackedTabs = await readTrackedTabs();
        firstRecord = trackedTabs[0];
        return trackedTabs.map(({ title, url }) => ({ title, url }));
      })
      .toEqual([{ title: "First page", url: `${origin}/first` }]);

    expect(firstRecord?.recordId).toEqual(expect.any(String));
    const originalRecordId = firstRecord!.recordId;
    const originalBrowserTabId = firstRecord!.browserTabId;
    await expectProtectedCount(1);

    await webTab.goto(`${origin}/second`);
    await expect
      .poll(async () => {
        return (await readTrackedTabs()).map(({ recordId, title, url }) => ({
          recordId,
          title,
          url,
        }));
      })
      .toEqual([
        {
          recordId: originalRecordId,
          title: "Second page",
          url: `${origin}/second`,
        },
      ]);
    await expectProtectedCount(1);

    expect((await readTrackedTabs()).some((tab) => tab.url === `${origin}/first`)).toBe(
      false,
    );

    await webTab.goto("about:blank");
    await expect.poll(readTrackedTabs).toEqual([]);
    expect(
      (await readTrackedTabs()).some(
        (tab) =>
          tab.recordId === originalRecordId || tab.browserTabId === originalBrowserTabId,
      ),
    ).toBe(false);
    await expectProtectedCount(0);

    await webTab.goto(`${origin}/first`);
    let readdedRecord: TrackedTab | undefined;
    await expect
      .poll(async () => {
        const trackedTabs = await readTrackedTabs();
        readdedRecord = trackedTabs[0];
        return trackedTabs.map(({ title, url }) => ({ title, url }));
      })
      .toEqual([{ title: "First page", url: `${origin}/first` }]);
    await expectProtectedCount(1);

    const popupWindow = await extension.serviceWorker.evaluate(async (url) => {
      const createdWindow = await chrome.windows.create({ type: "popup", url });
      return { windowId: createdWindow.id, tabId: createdWindow.tabs?.[0]?.id };
    }, `${origin}/second`);
    expect(popupWindow).toEqual({
      windowId: expect.any(Number),
      tabId: expect.any(Number),
    });

    const windowId = readdedRecord!.placement.windowId;
    const insertedTabId = await extension.serviceWorker.evaluate(
      async ({ targetWindowId, url }) => {
        const tab = await chrome.tabs.create({
          windowId: targetWindowId,
          index: 0,
          url,
        });
        return tab.id;
      },
      { targetWindowId: windowId, url: `${origin}/second` },
    );
    expect(insertedTabId).toEqual(expect.any(Number));
    await expect
      .poll(async () =>
        (await readTrackedTabs())
          .map(({ browserTabId, placement }) => ({
            browserTabId,
            index: placement.index,
          }))
          .sort((left, right) => left.index - right.index),
      )
      .toEqual([
        { browserTabId: insertedTabId, index: 0 },
        { browserTabId: readdedRecord!.browserTabId, index: 2 },
      ]);
    expect(
      (await readTrackedTabs()).some(
        (trackedTab) => trackedTab.browserTabId === popupWindow.tabId,
      ),
    ).toBe(false);
    await expectProtectedCount(2);

    await extension.serviceWorker.evaluate(
      async (popupWindowId) => chrome.windows.remove(popupWindowId),
      popupWindow.windowId!,
    );

    await extension.serviceWorker.evaluate(
      async (tabId) => chrome.tabs.remove(tabId),
      insertedTabId!,
    );
    await expect
      .poll(async () =>
        (await readTrackedTabs()).map(({ browserTabId, placement }) => ({
          browserTabId,
          index: placement.index,
        })),
      )
      .toEqual([{ browserTabId: readdedRecord!.browserTabId, index: 1 }]);
    await expectProtectedCount(1);

    await webTab.close();
    await expect.poll(readTrackedTabs).toEqual([]);
    expect(
      (await readTrackedTabs()).some(
        (tab) =>
          tab.recordId === readdedRecord!.recordId ||
          tab.browserTabId === readdedRecord!.browserTabId,
      ),
    ).toBe(false);
    await expectProtectedCount(0);
  } finally {
    await extension.close();
  }
});
