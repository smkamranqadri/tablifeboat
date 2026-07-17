import { createServer, type Server } from "node:http";
import { expect, test, type Worker } from "@playwright/test";
import { launchExtensionProfile } from "./extension-profile";
import { readRecoverySet, type WindowGrouping } from "./recovery-data";

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

async function findWindowGrouping(
  serviceWorker: Worker,
  urls: string[],
): Promise<WindowGrouping | undefined> {
  const recoverySet = await readRecoverySet(serviceWorker);
  return recoverySet?.windows.find((grouping) =>
    urls.every((url) => grouping.tabs.some((tab) => tab.url === url)),
  );
}

async function readWindowGroupingSnapshot(
  serviceWorker: Worker,
  urls: string[],
): Promise<
  | {
      groupingId: string;
      browserWindowId: number | undefined;
      tabs: {
        url: string;
        browserTabId: number | undefined;
        missingReason: "startup" | "window-closure" | undefined;
      }[];
    }
  | undefined
> {
  const grouping = await findWindowGrouping(serviceWorker, urls);
  return grouping
    ? {
        groupingId: grouping.groupingId,
        browserWindowId: grouping.browserWindowId,
        tabs: grouping.tabs.map((tab) => ({
          url: tab.url,
          browserTabId: tab.browserTabId,
          missingReason: tab.missingReason,
        })),
      }
    : undefined;
}

async function expectNoNotifications(serviceWorker: Worker): Promise<void> {
  const notifications = await serviceWorker.evaluate(async () =>
    chrome.notifications.getAll(),
  );
  expect(notifications).toEqual({});
}

test("preserves a closed multi-tab Recoverable Window as one missing Window Grouping", async () => {
  const extension = await launchExtensionProfile();
  const urls = [`${origin}/first-missing`, `${origin}/second-missing`];

  try {
    const createdWindow = await extension.serviceWorker.evaluate(async (url) => {
      const browserWindow = await chrome.windows.create({ type: "normal", url });
      return { windowId: browserWindow.id!, tabId: browserWindow.tabs![0]!.id! };
    }, urls[0]);
    await extension.serviceWorker.evaluate(
      async ({ windowId, url }) => chrome.tabs.create({ windowId, url }),
      { windowId: createdWindow.windowId, url: urls[1] },
    );

    await expect.poll(() => findWindowGrouping(extension.serviceWorker, urls)).toMatchObject({
      browserWindowId: createdWindow.windowId,
      tabs: expect.arrayContaining([
        expect.objectContaining({ url: urls[0], browserTabId: createdWindow.tabId }),
        expect.objectContaining({ url: urls[1], browserTabId: expect.any(Number) }),
      ]),
    });
    const groupingId = (await findWindowGrouping(extension.serviceWorker, urls))!.groupingId;

    await extension.serviceWorker.evaluate(
      async (windowId) => chrome.windows.remove(windowId),
      createdWindow.windowId,
    );

    await expect.poll(() => readWindowGroupingSnapshot(extension.serviceWorker, urls)).toEqual({
      groupingId,
      browserWindowId: undefined,
      tabs: [
        {
          url: urls[0],
          browserTabId: undefined,
          missingReason: "window-closure",
        },
        {
          url: urls[1],
          browserTabId: undefined,
          missingReason: "window-closure",
        },
      ],
    });
    await expect
      .poll(() => extension.serviceWorker.evaluate(() => chrome.action.getBadgeText({})))
      .toBe("2");

    const popup = await extension.openPopup();
    await expect(popup.getByText("0 open protected tabs")).toBeVisible();
    await expect(popup.getByRole("heading", { name: "Missing Window" })).toBeVisible();
    await expect(popup.getByText("first-missing", { exact: true })).toBeVisible();
    await expect(popup.getByText("second-missing", { exact: true })).toBeVisible();
    await expectNoNotifications(extension.serviceWorker);
  } finally {
    await extension.close();
  }
});

test("treats closing the last Web Tab as Window Closure", async () => {
  const extension = await launchExtensionProfile();
  const url = `${origin}/last-tab-missing`;

  try {
    const createdWindow = await extension.serviceWorker.evaluate(async (address) => {
      const browserWindow = await chrome.windows.create({ type: "normal", url: address });
      return { windowId: browserWindow.id!, tabId: browserWindow.tabs![0]!.id! };
    }, url);

    await expect.poll(() => findWindowGrouping(extension.serviceWorker, [url])).toMatchObject({
      browserWindowId: createdWindow.windowId,
      tabs: [expect.objectContaining({ url, browserTabId: createdWindow.tabId })],
    });
    const groupingId = (await findWindowGrouping(extension.serviceWorker, [url]))!.groupingId;

    await extension.serviceWorker.evaluate(
      async (tabId) => chrome.tabs.remove(tabId),
      createdWindow.tabId,
    );

    await expect.poll(() => readWindowGroupingSnapshot(extension.serviceWorker, [url])).toEqual({
      groupingId,
      browserWindowId: undefined,
      tabs: [
        { url, browserTabId: undefined, missingReason: "window-closure" },
      ],
    });
    await expect
      .poll(() => extension.serviceWorker.evaluate(() => chrome.action.getBadgeText({})))
      .toBe("1");

    const popup = await extension.openPopup();
    await expect(popup.getByText("0 open protected tabs")).toBeVisible();
    await expect(popup.getByRole("heading", { name: "Missing Window" })).toBeVisible();
    await expect(popup.getByText("last-tab-missing", { exact: true })).toBeVisible();
    await expectNoNotifications(extension.serviceWorker);
  } finally {
    await extension.close();
  }
});
