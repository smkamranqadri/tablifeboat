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

async function readOpenWebWindowLayout(serviceWorker: Worker) {
  return serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    const byWindow = new Map<
      number,
      Array<{ id: number; url: string; index: number; pinned: boolean }>
    >();
    for (const tab of tabs) {
      if (
        tab.id === undefined ||
        tab.url === undefined ||
        (!tab.url.startsWith("http://") && !tab.url.startsWith("https://"))
      ) {
        continue;
      }
      const windowTabs = byWindow.get(tab.windowId) ?? [];
      windowTabs.push({
        id: tab.id,
        url: tab.url,
        index: tab.index,
        pinned: tab.pinned,
      });
      byWindow.set(tab.windowId, windowTabs);
    }
    return Array.from(byWindow, ([windowId, windowTabs]) => ({
      windowId,
      tabs: windowTabs.sort((left, right) => left.index - right.index),
    })).sort((left, right) => left.windowId - right.windowId);
  });
}

test("Restore Window repairs only the Missing Tabs in a matching partial Window Grouping", async () => {
  const extension = await launchExtensionProfile();
  const pinnedUrl = `${origin}/partial-pinned`;
  const openUrl = `${origin}/partial-open`;
  const trailingUrl = `${origin}/partial-trailing`;
  const unrelatedUrl = `${origin}/partial-unrelated`;

  try {
    const partialWindow = await createRecoverableWindow(extension.serviceWorker, openUrl);
    const unrelatedWindow = await createRecoverableWindow(
      extension.serviceWorker,
      unrelatedUrl,
    );
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "partial-grouping",
          browserWindowId: partialWindow.windowId,
          tabs: [
            {
              ...recoveryTab("partial-pinned", pinnedUrl, 0, true),
              missingReason: "startup",
            },
            recoveryTab("partial-open", openUrl, 1, false, partialWindow.tabId),
            {
              ...recoveryTab("partial-trailing", trailingUrl, 2, false),
              missingReason: "startup",
            },
          ],
        },
        {
          groupingId: "unrelated-grouping",
          browserWindowId: unrelatedWindow.windowId,
          tabs: [
            recoveryTab(
              "partial-unrelated",
              unrelatedUrl,
              0,
              false,
              unrelatedWindow.tabId,
            ),
          ],
        },
      ],
    });

    const popup = await extension.openPopup();
    await expect(popup.getByText("partial-pinned", { exact: true })).toBeVisible();
    await expect(popup.getByText("partial-trailing", { exact: true })).toBeVisible();
    await popup.getByRole("button", { name: "Restore Window" }).click();

    await expect(popup.getByText("partial-pinned", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("partial-trailing", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("4 open protected tabs")).toBeVisible();

    await expect.poll(() => readOpenWebWindowLayout(extension.serviceWorker)).toEqual([
      {
        windowId: partialWindow.windowId,
        tabs: [
          { id: expect.any(Number), url: pinnedUrl, index: 0, pinned: true },
          { id: partialWindow.tabId, url: openUrl, index: 1, pinned: false },
          { id: expect.any(Number), url: trailingUrl, index: 2, pinned: false },
        ],
      },
      {
        windowId: unrelatedWindow.windowId,
        tabs: [
          {
            id: unrelatedWindow.tabId,
            url: unrelatedUrl,
            index: 0,
            pinned: false,
          },
        ],
      },
    ].sort((left, right) => left.windowId - right.windowId));

    const recoverySet = (await readRecoverySet(extension.serviceWorker))!;
    const partialGrouping = recoverySet.windows.find(
      (grouping) => grouping.groupingId === "partial-grouping",
    )!;
    expect(partialGrouping.tabs.map((tab) => tab.recordId)).toEqual([
      "partial-pinned",
      "partial-open",
      "partial-trailing",
    ]);
    expect(partialGrouping.tabs.every((tab) => tab.browserTabId !== undefined)).toBe(
      true,
    );
    expect(partialGrouping.tabs.every((tab) => tab.missingReason === undefined)).toBe(
      true,
    );
    expect(
      (await readOpenWebWindowLayout(extension.serviceWorker))
        .flatMap((window) => window.tabs)
        .filter((tab) => tab.url === openUrl),
    ).toHaveLength(1);
  } finally {
    await extension.close();
  }
});

test("Restore Window recreates an entirely missing Window Grouping as one separate normal window", async () => {
  const extension = await launchExtensionProfile();
  const existingUrl = `${origin}/absent-existing`;
  const missingUrls = [
    `${origin}/absent-pinned`,
    `${origin}/absent-middle`,
    `${origin}/absent-last`,
  ];

  try {
    const existingWindow = await createRecoverableWindow(
      extension.serviceWorker,
      existingUrl,
    );
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "existing-grouping",
          browserWindowId: existingWindow.windowId,
          tabs: [
            recoveryTab(
              "absent-existing",
              existingUrl,
              0,
              false,
              existingWindow.tabId,
            ),
          ],
        },
        {
          groupingId: "absent-grouping",
          tabs: missingUrls.map((url, index) => ({
            ...recoveryTab(`absent-${index}`, url, index, index === 0),
            missingReason: "window-closure" as const,
          })),
        },
      ],
    });

    const popup = await extension.openPopup();
    await expect(popup.getByText("absent-pinned", { exact: true })).toBeVisible();
    await popup.getByRole("button", { name: "Restore Window" }).click();

    await expect(popup.getByText("absent-pinned", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("4 open protected tabs")).toBeVisible();

    await expect.poll(() => readOpenWebWindowLayout(extension.serviceWorker)).toEqual([
      {
        windowId: existingWindow.windowId,
        tabs: [
          {
            id: existingWindow.tabId,
            url: existingUrl,
            index: 0,
            pinned: false,
          },
        ],
      },
      {
        windowId: expect.any(Number),
        tabs: missingUrls.map((url, index) => ({
          id: expect.any(Number),
          url,
          index,
          pinned: index === 0,
        })),
      },
    ]);

    const recoverySet = (await readRecoverySet(extension.serviceWorker))!;
    const restoredGrouping = recoverySet.windows.find(
      (grouping) => grouping.groupingId === "absent-grouping",
    )!;
    expect(restoredGrouping.browserWindowId).toEqual(expect.any(Number));
    expect(restoredGrouping.browserWindowId).not.toBe(existingWindow.windowId);
    expect(restoredGrouping.tabs.map((tab) => tab.recordId)).toEqual([
      "absent-0",
      "absent-1",
      "absent-2",
    ]);
    expect(restoredGrouping.tabs.every((tab) => tab.browserTabId !== undefined)).toBe(
      true,
    );
    expect(restoredGrouping.tabs.every((tab) => tab.missingReason === undefined)).toBe(
      true,
    );
  } finally {
    await extension.close();
  }
});

test("Restore Window falls back to a new window when the saved window no longer exists", async () => {
  const extension = await launchExtensionProfile();
  const anchorUrl = `${origin}/stale-anchor`;
  const firstMissingUrl = `${origin}/stale-first`;
  const secondMissingUrl = `${origin}/stale-second`;

  try {
    const anchorWindow = await createRecoverableWindow(extension.serviceWorker, anchorUrl);
    const staleWindowId = await extension.serviceWorker.evaluate(async (address) => {
      const browserWindow = await chrome.windows.create({ type: "normal", url: address });
      await chrome.windows.remove(browserWindow.id!);
      return browserWindow.id!;
    }, firstMissingUrl);

    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "anchor-grouping",
          browserWindowId: anchorWindow.windowId,
          tabs: [recoveryTab("stale-anchor", anchorUrl, 0, false, anchorWindow.tabId)],
        },
        {
          groupingId: "stale-grouping",
          browserWindowId: staleWindowId,
          tabs: [
            {
              ...recoveryTab("stale-first", firstMissingUrl, 0, false),
              missingReason: "window-closure",
            },
            {
              ...recoveryTab("stale-second", secondMissingUrl, 1, false),
              missingReason: "window-closure",
            },
          ],
        },
      ],
    });

    const popup = await extension.openPopup();
    await expect(popup.getByText("stale-first", { exact: true })).toBeVisible();
    await popup.getByRole("button", { name: "Restore Window" }).click();

    await expect(popup.getByText("stale-first", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("stale-second", { exact: true })).toHaveCount(0);
    await expect(popup.getByText("3 open protected tabs")).toBeVisible();

    const layout = await readOpenWebWindowLayout(extension.serviceWorker);
    const restoredWindow = layout.find((window) =>
      window.tabs.some((tab) => tab.url === firstMissingUrl),
    )!;
    expect(restoredWindow).toBeDefined();
    expect(restoredWindow.windowId).not.toBe(staleWindowId);
    expect(restoredWindow.windowId).not.toBe(anchorWindow.windowId);
    expect(restoredWindow.tabs.map((tab) => tab.url)).toEqual([
      firstMissingUrl,
      secondMissingUrl,
    ]);

    const recoverySet = (await readRecoverySet(extension.serviceWorker))!;
    const staleGrouping = recoverySet.windows.find(
      (grouping) => grouping.groupingId === "stale-grouping",
    )!;
    expect(staleGrouping.browserWindowId).toBe(restoredWindow.windowId);
    expect(staleGrouping.tabs.every((tab) => tab.browserTabId !== undefined)).toBe(true);
    expect(staleGrouping.tabs.every((tab) => tab.missingReason === undefined)).toBe(true);
  } finally {
    await extension.close();
  }
});
