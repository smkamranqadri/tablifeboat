import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
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

test("preserves every affected Tab Placement through reorder, pin, unpin, and cross-window moves", async () => {
  const extension = await launchExtensionProfile();

  try {
    const initialIneligibleTab = extension.context.pages()[0]!;
    const sourceSiblingPage = await extension.context.newPage();
    await sourceSiblingPage.goto(`${origin}/source-sibling`);
    const primaryTrackedTabPage = await extension.context.newPage();
    await primaryTrackedTabPage.goto(`${origin}/primary`);
    await initialIneligibleTab.close();

    const findBrowserTab = async (url: string): Promise<chrome.tabs.Tab> => {
      const browserTab = await extension.serviceWorker.evaluate(async (address) => {
        const normalTabs = await chrome.tabs.query({ windowType: "normal" });
        return normalTabs.find((tab) => tab.url === address);
      }, url);
      expect(browserTab).toBeDefined();
      return browserTab!;
    };
    const primaryBrowserTab = await findBrowserTab(`${origin}/primary`);
    const sourceSiblingBrowserTab = await findBrowserTab(`${origin}/source-sibling`);
    const sourceBrowserWindowId = primaryBrowserTab.windowId;
    expect(sourceSiblingBrowserTab.windowId).toBe(sourceBrowserWindowId);

    interface ExpectedTrackedTabPlacement {
      url: string;
      browserTabId: number;
      browserWindowId: number;
      index: number;
      pinned: boolean;
    }

    const durableRecordIds = new Map<string, string>();
    const expectRecoveryData = async (
      expectedTrackedTabs: ExpectedTrackedTabPlacement[],
    ): Promise<void> => {
      const readPlacements = async () => {
        const recoverySet = await readRecoverySet(extension.serviceWorker);
        return (
          recoverySet?.windows.flatMap((windowGrouping) =>
            windowGrouping.tabs.map((trackedTab) => ({
              url: trackedTab.url,
              recordId: trackedTab.recordId,
              browserTabId: trackedTab.browserTabId,
              browserWindowId: windowGrouping.browserWindowId,
              index: trackedTab.placement.index,
              pinned: trackedTab.placement.pinned,
            })),
          ) ?? []
        ).sort((left, right) => left.url.localeCompare(right.url));
      };
      const expectedPlacements = expectedTrackedTabs
        .map((trackedTab) => ({
          ...trackedTab,
          recordId: durableRecordIds.get(trackedTab.url) ?? expect.any(String),
        }))
        .sort((left, right) => left.url.localeCompare(right.url));

      await expect.poll(readPlacements).toEqual(expectedPlacements);

      const savedTrackedTabs = await readPlacements();
      for (const trackedTab of savedTrackedTabs) {
        const existingRecordId = durableRecordIds.get(trackedTab.url);
        if (existingRecordId) {
          expect(trackedTab.recordId).toBe(existingRecordId);
        } else {
          durableRecordIds.set(trackedTab.url, trackedTab.recordId);
        }
      }

      const primaryRecordId = durableRecordIds.get(`${origin}/primary`);
      if (primaryRecordId) {
        expect(
          savedTrackedTabs.filter(
            (trackedTab) =>
              trackedTab.recordId === primaryRecordId ||
              trackedTab.browserTabId === primaryBrowserTab.id,
          ),
        ).toHaveLength(1);
      }
    };

    await expectRecoveryData([
      {
        url: `${origin}/source-sibling`,
        browserTabId: sourceSiblingBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 0,
        pinned: false,
      },
      {
        url: `${origin}/primary`,
        browserTabId: primaryBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 1,
        pinned: false,
      },
    ]);
    const originalPrimaryRecordId = durableRecordIds.get(`${origin}/primary`)!;

    await extension.serviceWorker.evaluate(
      async (browserTabId) => chrome.tabs.move(browserTabId, { index: 0 }),
      primaryBrowserTab.id!,
    );
    await expectRecoveryData([
      {
        url: `${origin}/primary`,
        browserTabId: primaryBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 0,
        pinned: false,
      },
      {
        url: `${origin}/source-sibling`,
        browserTabId: sourceSiblingBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 1,
        pinned: false,
      },
    ]);

    await extension.serviceWorker.evaluate(
      async (browserTabId) => chrome.tabs.update(browserTabId, { pinned: true }),
      primaryBrowserTab.id!,
    );
    await extension.serviceWorker.evaluate(
      async (browserTabId) => chrome.tabs.update(browserTabId, { pinned: true }),
      sourceSiblingBrowserTab.id!,
    );
    await expectRecoveryData([
      {
        url: `${origin}/primary`,
        browserTabId: primaryBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 0,
        pinned: true,
      },
      {
        url: `${origin}/source-sibling`,
        browserTabId: sourceSiblingBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 1,
        pinned: true,
      },
    ]);

    await extension.serviceWorker.evaluate(
      async (browserTabId) => chrome.tabs.update(browserTabId, { pinned: false }),
      primaryBrowserTab.id!,
    );
    await expectRecoveryData([
      {
        url: `${origin}/source-sibling`,
        browserTabId: sourceSiblingBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 0,
        pinned: true,
      },
      {
        url: `${origin}/primary`,
        browserTabId: primaryBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 1,
        pinned: false,
      },
    ]);

    const destinationBrowserWindow = await extension.serviceWorker.evaluate(async (url) => {
      const createdWindow = await chrome.windows.create({ type: "normal", url });
      return { windowId: createdWindow.id!, tabId: createdWindow.tabs![0]!.id! };
    }, `${origin}/destination-sibling`);
    await extension.serviceWorker.evaluate(
      async ({ browserTabId, browserWindowId }) =>
        chrome.tabs.move(browserTabId, { windowId: browserWindowId, index: 0 }),
      {
        browserTabId: primaryBrowserTab.id!,
        browserWindowId: destinationBrowserWindow.windowId,
      },
    );
    await expectRecoveryData([
      {
        url: `${origin}/source-sibling`,
        browserTabId: sourceSiblingBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 0,
        pinned: true,
      },
      {
        url: `${origin}/primary`,
        browserTabId: primaryBrowserTab.id!,
        browserWindowId: destinationBrowserWindow.windowId,
        index: 0,
        pinned: false,
      },
      {
        url: `${origin}/destination-sibling`,
        browserTabId: destinationBrowserWindow.tabId,
        browserWindowId: destinationBrowserWindow.windowId,
        index: 1,
        pinned: false,
      },
    ]);

    const finalBrowserWindow = await extension.serviceWorker.evaluate(async (url) => {
      const createdWindow = await chrome.windows.create({ type: "normal", url });
      return { windowId: createdWindow.id!, tabId: createdWindow.tabs![0]!.id! };
    }, `${origin}/final-sibling`);
    await extension.serviceWorker.evaluate(
      async ({ browserTabId, browserWindowId }) =>
        chrome.tabs.move(browserTabId, { windowId: browserWindowId, index: 1 }),
      {
        browserTabId: primaryBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
      },
    );
    await expectRecoveryData([
      {
        url: `${origin}/source-sibling`,
        browserTabId: sourceSiblingBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 0,
        pinned: true,
      },
      {
        url: `${origin}/primary`,
        browserTabId: primaryBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 1,
        pinned: false,
      },
      {
        url: `${origin}/destination-sibling`,
        browserTabId: destinationBrowserWindow.tabId,
        browserWindowId: destinationBrowserWindow.windowId,
        index: 0,
        pinned: false,
      },
      {
        url: `${origin}/final-sibling`,
        browserTabId: finalBrowserWindow.tabId,
        browserWindowId: finalBrowserWindow.windowId,
        index: 0,
        pinned: false,
      },
    ]);

    await extension.serviceWorker.evaluate(
      async ({ browserTabId, intermediateWindowId, finalWindowId }) => {
        await chrome.tabs.move(browserTabId, {
          windowId: intermediateWindowId,
          index: 0,
        });
        await chrome.tabs.move(browserTabId, { windowId: finalWindowId, index: 0 });
      },
      {
        browserTabId: primaryBrowserTab.id!,
        intermediateWindowId: destinationBrowserWindow.windowId,
        finalWindowId: finalBrowserWindow.windowId,
      },
    );
    await expectRecoveryData([
      {
        url: `${origin}/source-sibling`,
        browserTabId: sourceSiblingBrowserTab.id!,
        browserWindowId: sourceBrowserWindowId,
        index: 0,
        pinned: true,
      },
      {
        url: `${origin}/destination-sibling`,
        browserTabId: destinationBrowserWindow.tabId,
        browserWindowId: destinationBrowserWindow.windowId,
        index: 0,
        pinned: false,
      },
      {
        url: `${origin}/primary`,
        browserTabId: primaryBrowserTab.id!,
        browserWindowId: finalBrowserWindow.windowId,
        index: 0,
        pinned: false,
      },
      {
        url: `${origin}/final-sibling`,
        browserTabId: finalBrowserWindow.tabId,
        browserWindowId: finalBrowserWindow.windowId,
        index: 1,
        pinned: false,
      },
    ]);

    const finalRecoverySet = (await readRecoverySet(extension.serviceWorker))!;
    const finalWindowGrouping = finalRecoverySet.windows.find(
      (windowGrouping) =>
        windowGrouping.browserWindowId === finalBrowserWindow.windowId,
    );
    expect(
      finalWindowGrouping?.tabs.filter(
        (trackedTab) => trackedTab.recordId === originalPrimaryRecordId,
      ),
    ).toEqual([
      expect.objectContaining({
        browserTabId: primaryBrowserTab.id,
        placement: { index: 0, pinned: false },
      }),
    ]);
    expect(
      finalRecoverySet.windows
        .find(
          (windowGrouping) =>
            windowGrouping.browserWindowId === destinationBrowserWindow.windowId,
        )
        ?.tabs.some((trackedTab) => trackedTab.recordId === originalPrimaryRecordId),
    ).toBe(false);
  } finally {
    await extension.close();
  }
});
