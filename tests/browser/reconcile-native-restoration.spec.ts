import { createServer, type Server } from "node:http";
import { expect, test, type Worker } from "@playwright/test";
import type { RecoverySet, TrackedTab } from "../../src/recovery-model";
import {
  launchExtensionProfile,
  type ExtensionProfile,
} from "./extension-profile";
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

test("arms deterministic reconciliation only for browser startup and bypasses only its wait", async () => {
  const originalChrome = globalThis.chrome;
  let startupListener: (() => void) | undefined;
  let operationCount = 0;

  globalThis.chrome = {
    runtime: {
      onStartup: {
        addListener: (listener: () => void) => {
          startupListener = listener;
        },
      },
    },
  } as unknown as typeof chrome;

  try {
    const { scheduleStartupReconciliation } = await import(
      "../../dist/reconciliation.js"
    );
    const startupReconciliation = scheduleStartupReconciliation(async () => {
      operationCount += 1;
      return { version: 1, windows: [] };
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(operationCount).toBe(0);
    expect(startupListener).toBeDefined();

    startupListener!();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(operationCount).toBe(0);

    const firstResult =
      await startupReconciliation.reconcileAfterStartupSettlingForTest();
    const secondResult =
      await startupReconciliation.reconcileAfterStartupSettlingForTest();
    expect(firstResult).toEqual({ version: 1, windows: [] });
    expect(secondResult).toEqual(firstResult);
    expect(operationCount).toBe(1);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

function recoveryTab(
  recordId: string,
  url: string,
  index: number,
): TrackedTab {
  return {
    recordId,
    title: url.slice(url.lastIndexOf("/") + 1),
    url,
    placement: { index, pinned: false },
  };
}

async function createRecoverableWindow(
  serviceWorker: Worker,
  urls: string[],
): Promise<number> {
  return serviceWorker.evaluate(async (addresses) => {
    const browserWindow = await chrome.windows.create({
      type: "normal",
      url: addresses[0],
    });
    for (const address of addresses.slice(1)) {
      await chrome.tabs.create({ windowId: browserWindow.id, url: address });
    }
    return browserWindow.id!;
  }, urls);
}

async function waitForOpenWebTabsToSettle(
  serviceWorker: Worker,
  expectedUrls: string[],
): Promise<void> {
  await expect
    .poll(() =>
      serviceWorker.evaluate(async () => {
        const tabs = await chrome.tabs.query({ windowType: "normal" });
        return tabs
          .flatMap((tab) =>
            tab.url?.startsWith("http://") || tab.url?.startsWith("https://")
              ? [tab.url]
              : [],
          )
          .sort();
      }),
    )
    .toEqual([...expectedUrls].sort());
  await expect
    .poll(async () => {
      const recoverySet = await readRecoverySet(serviceWorker);
      return (
        recoverySet?.windows.flatMap((grouping) =>
          grouping.tabs.map((tab) => tab.url),
        ) ?? []
      ).sort();
    })
    .toEqual([...expectedUrls].sort());
}

async function seedRecoverySet(
  serviceWorker: Worker,
  recoverySet: RecoverySet,
): Promise<void> {
  await serviceWorker.evaluate(
    async (set) => chrome.storage.local.set({ recoverySet: set }),
    recoverySet,
  );
  await expect.poll(() => readRecoverySet(serviceWorker)).toEqual(recoverySet);
}

async function reconcileAfterStartupSettlingForTest(
  extension: ExtensionProfile,
): Promise<RecoverySet> {
  const popup = await extension.openPopup();
  try {
    return await popup.evaluate(async () =>
      chrome.runtime.sendMessage({ type: "reconcileAfterStartupSettlingForTest" }),
    );
  } finally {
    await popup.close();
  }
}

async function readOpenWebTabs(serviceWorker: Worker) {
  return serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    return tabs
      .flatMap((tab) =>
        tab.id !== undefined &&
        (tab.url?.startsWith("http://") || tab.url?.startsWith("https://"))
          ? [{ id: tab.id, windowId: tab.windowId, url: tab.url }]
          : [],
      )
      .sort((left, right) => left.id - right.id);
  });
}

async function readNotificationIds(serviceWorker: Worker): Promise<string[]> {
  return serviceWorker.evaluate(async () =>
    Object.keys(await chrome.notifications.getAll()).sort(),
  );
}

test("complete native restoration associates every equal-address occurrence without changing Recovery Data membership", async () => {
  const extension = await launchExtensionProfile();
  const duplicateUrl = `${origin}/complete-duplicate`;
  const distinctUrl = `${origin}/complete-distinct`;

  try {
    const browserWindowId = await createRecoverableWindow(extension.serviceWorker, [
      duplicateUrl,
      duplicateUrl,
      distinctUrl,
    ]);
    await waitForOpenWebTabsToSettle(extension.serviceWorker, [
      duplicateUrl,
      duplicateUrl,
      distinctUrl,
    ]);
    const expectedRecordIds = ["complete-1", "complete-2", "complete-3"];
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "complete-grouping",
          tabs: [
            recoveryTab(expectedRecordIds[0]!, duplicateUrl, 0),
            recoveryTab(expectedRecordIds[1]!, duplicateUrl, 1),
            recoveryTab(expectedRecordIds[2]!, distinctUrl, 2),
          ],
        },
      ],
    });
    const openTabsBefore = await readOpenWebTabs(extension.serviceWorker);

    const reconciled = await reconcileAfterStartupSettlingForTest(extension);

    expect(await readOpenWebTabs(extension.serviceWorker)).toEqual(openTabsBefore);
    expect(reconciled.windows).toHaveLength(1);
    expect(reconciled.windows[0]).toMatchObject({
      groupingId: "complete-grouping",
      browserWindowId,
    });
    expect(reconciled.windows[0]!.tabs.map((tab) => tab.recordId)).toEqual(
      expectedRecordIds,
    );
    expect(
      new Set(reconciled.windows[0]!.tabs.map((tab) => tab.browserTabId)).size,
    ).toBe(3);
    expect(
      reconciled.windows[0]!.tabs.every(
        (tab) => tab.browserTabId !== undefined,
      ),
    ).toBe(true);
    expect(await readRecoverySet(extension.serviceWorker)).toEqual(reconciled);
    expect(await readNotificationIds(extension.serviceWorker)).toEqual([]);
  } finally {
    await extension.close();
  }
});

test("partial native restoration reports only absent occurrences in their best matching Window Grouping", async () => {
  const extension = await launchExtensionProfile();
  const sharedUrl = `${origin}/partial-shared`;
  const firstSpecificUrl = `${origin}/partial-first`;
  const secondSpecificUrl = `${origin}/partial-second`;

  try {
    const firstWindowId = await createRecoverableWindow(extension.serviceWorker, [
      sharedUrl,
      firstSpecificUrl,
    ]);
    const secondWindowId = await createRecoverableWindow(extension.serviceWorker, [
      sharedUrl,
      secondSpecificUrl,
    ]);
    await waitForOpenWebTabsToSettle(extension.serviceWorker, [
      sharedUrl,
      firstSpecificUrl,
      sharedUrl,
      secondSpecificUrl,
    ]);
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "partial-first-grouping",
          tabs: [
            recoveryTab("partial-first-shared-1", sharedUrl, 0),
            recoveryTab("partial-first-shared-2", sharedUrl, 1),
            recoveryTab("partial-first-specific", firstSpecificUrl, 2),
          ],
        },
        {
          groupingId: "partial-second-grouping",
          tabs: [
            recoveryTab("partial-second-shared", sharedUrl, 0),
            recoveryTab("partial-second-specific", secondSpecificUrl, 1),
          ],
        },
      ],
    });
    const openTabsBefore = await readOpenWebTabs(extension.serviceWorker);

    const reconciled = await reconcileAfterStartupSettlingForTest(extension);
    const firstGrouping = reconciled.windows.find(
      (grouping) => grouping.groupingId === "partial-first-grouping",
    )!;
    const secondGrouping = reconciled.windows.find(
      (grouping) => grouping.groupingId === "partial-second-grouping",
    )!;

    expect(await readOpenWebTabs(extension.serviceWorker)).toEqual(openTabsBefore);
    expect(firstGrouping.browserWindowId).toBe(firstWindowId);
    expect(secondGrouping.browserWindowId).toBe(secondWindowId);
    expect(
      firstGrouping.tabs
        .filter((tab) => tab.browserTabId === undefined)
        .map((tab) => tab.recordId),
    ).toEqual(["partial-first-shared-2"]);
    expect(
      secondGrouping.tabs.filter((tab) => tab.browserTabId === undefined),
    ).toEqual([]);
    expect(reconciled.windows.flatMap((grouping) => grouping.tabs)).toHaveLength(5);
    expect(await readRecoverySet(extension.serviceWorker)).toEqual(reconciled);

    const secondResult = await reconcileAfterStartupSettlingForTest(extension);
    expect(secondResult).toEqual(reconciled);
    expect(await readNotificationIds(extension.serviceWorker)).toHaveLength(1);
  } finally {
    await extension.close();
  }
});

test("absent native restoration preserves a distinct missing Window Grouping without opening tabs", async () => {
  const extension = await launchExtensionProfile();
  const absentUrls = [`${origin}/absent-first`, `${origin}/absent-second`];

  try {
    await waitForOpenWebTabsToSettle(extension.serviceWorker, []);
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "absent-grouping",
          tabs: [
            recoveryTab("absent-1", absentUrls[0]!, 0),
            recoveryTab("absent-2", absentUrls[1]!, 1),
          ],
        },
      ],
    });
    const openTabsBefore = await readOpenWebTabs(extension.serviceWorker);

    const reconciled = await reconcileAfterStartupSettlingForTest(extension);

    expect(await readOpenWebTabs(extension.serviceWorker)).toEqual(openTabsBefore);
    expect(reconciled).toEqual({
      version: 1,
      windows: [
        {
          groupingId: "absent-grouping",
          tabs: [
            recoveryTab("absent-1", absentUrls[0]!, 0),
            recoveryTab("absent-2", absentUrls[1]!, 1),
          ],
        },
      ],
    });
    expect(await readRecoverySet(extension.serviceWorker)).toEqual(reconciled);
    expect(await readNotificationIds(extension.serviceWorker)).toHaveLength(1);
  } finally {
    await extension.close();
  }
});
