import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { launchExtensionProfile } from "./extension-profile";
import { readRecoverySet, type RecoverySet } from "./recovery-data";

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Placement page</title><h1>Placement page</h1>");
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

test("preserves Tab Placement through reorder, pin, unpin, and a cross-window move", async () => {
  const extension = await launchExtensionProfile();

  try {
    const webTab = await extension.context.newPage();
    await webTab.goto(`${origin}/tracked`);

    const browserTabId = await extension.serviceWorker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id;
    });
    expect(browserTabId).toEqual(expect.any(Number));

    let recordId: string | undefined;
    const expectSinglePlacement = async (expected: {
      browserWindowId: number;
      index: number;
      pinned: boolean;
    }): Promise<void> => {
      await expect
        .poll(async () => {
          const set = await readRecoverySet(extension.serviceWorker);
          const records = set?.windows.flatMap((window) =>
            window.tabs.map((tab) => ({
              groupingBrowserWindowId: window.browserWindowId,
              browserTabId: tab.browserTabId,
              recordId: tab.recordId,
              placement: tab.placement,
            })),
          );
          return records;
        })
        .toEqual([
          {
            groupingBrowserWindowId: expected.browserWindowId,
            browserTabId,
            recordId: recordId ?? expect.any(String),
            placement: { index: expected.index, pinned: expected.pinned },
          },
        ]);

      const set = (await readRecoverySet(extension.serviceWorker)) as RecoverySet;
      const records = set.windows.flatMap((window) => window.tabs);
      recordId ??= records[0]?.recordId;
      expect(records).toHaveLength(1);
      expect(records[0]?.recordId).toBe(recordId);
    };

    const initialTab = await extension.serviceWorker.evaluate(async (tabId) => {
      return chrome.tabs.get(tabId);
    }, browserTabId!);
    await expectSinglePlacement({
      browserWindowId: initialTab.windowId,
      index: initialTab.index,
      pinned: false,
    });

    const reorderedTab = await extension.serviceWorker.evaluate(async (tabId) => {
      return chrome.tabs.move(tabId, { index: 0 });
    }, browserTabId!);
    await expectSinglePlacement({
      browserWindowId: reorderedTab.windowId,
      index: reorderedTab.index,
      pinned: false,
    });

    const pinnedTab = await extension.serviceWorker.evaluate(async (tabId) => {
      return chrome.tabs.update(tabId, { pinned: true });
    }, browserTabId!);
    await expectSinglePlacement({
      browserWindowId: pinnedTab.windowId,
      index: pinnedTab.index,
      pinned: true,
    });

    const unpinnedTab = await extension.serviceWorker.evaluate(async (tabId) => {
      return chrome.tabs.update(tabId, { pinned: false });
    }, browserTabId!);
    await expectSinglePlacement({
      browserWindowId: unpinnedTab.windowId,
      index: unpinnedTab.index,
      pinned: false,
    });

    const targetWindow = await extension.serviceWorker.evaluate(async () => {
      const created = await chrome.windows.create({ type: "normal", url: "about:blank" });
      return created.id;
    });
    expect(targetWindow).toEqual(expect.any(Number));

    const movedTab = await extension.serviceWorker.evaluate(
      async ({ tabId, windowId }) => {
        return chrome.tabs.move(tabId, { windowId, index: 0 });
      },
      { tabId: browserTabId!, windowId: targetWindow! },
    );
    await expectSinglePlacement({
      browserWindowId: movedTab.windowId,
      index: movedTab.index,
      pinned: false,
    });
  } finally {
    await extension.close();
  }
});
