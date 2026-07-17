import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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

test("an automated control rejects an unarmed request and preserves one startup operation across worker restart", async () => {
  const originalChrome = globalThis.chrome;
  let startupListeners: Array<() => void> = [];
  let sessionState: Record<string, unknown> = {};
  let notificationInvocationCount = 0;
  const currentRecoverySet: RecoverySet = { version: 1, windows: [] };

  globalThis.chrome = {
    runtime: {
      onStartup: {
        addListener: (listener: () => void) => {
          startupListeners.push(listener);
        },
      },
    },
    storage: {
      session: {
        get: async () => structuredClone(sessionState),
        set: async (values: Record<string, unknown>) => {
          sessionState = { ...sessionState, ...structuredClone(values) };
        },
      },
    },
  } as unknown as typeof chrome;

  try {
    const { scheduleStartupReconciliation } = await import(
      "../../dist/reconciliation.js"
    );
    const runStartupOperation = async ({
      claimStartupNotification,
    }: {
      claimStartupNotification: () => Promise<boolean>;
    }) => {
      if (await claimStartupNotification()) {
        notificationInvocationCount += 1;
      }
      return currentRecoverySet;
    };
    const readCurrentRecoverySet = async () => currentRecoverySet;
    const firstWorker = scheduleStartupReconciliation(
      runStartupOperation,
      readCurrentRecoverySet,
      true,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(
      await firstWorker.reconcileAfterStartupSettlingForTest(),
    ).toBeUndefined();
    expect(notificationInvocationCount).toBe(0);
    expect(startupListeners).toHaveLength(1);
    startupListeners[0]!();
    await expect.poll(() => sessionState).toMatchObject({
      startupReconciliationState: {
        armed: true,
        completed: false,
        notified: false,
      },
    });

    expect(
      await firstWorker.reconcileAfterStartupSettlingForTest(),
    ).toEqual(currentRecoverySet);
    expect(notificationInvocationCount).toBe(1);

    startupListeners = [];
    const restartedWorker = scheduleStartupReconciliation(
      runStartupOperation,
      readCurrentRecoverySet,
      true,
    );
    expect(
      await restartedWorker.reconcileAfterStartupSettlingForTest(),
    ).toEqual(currentRecoverySet);
    expect(notificationInvocationCount).toBe(1);
    expect(sessionState).toMatchObject({
      startupReconciliationState: {
        armed: true,
        completed: true,
        notified: true,
      },
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
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
  };
}

interface RestartedProfile {
  extension: ExtensionProfile;
  close: () => Promise<void>;
}

async function simulateStartupForTest(extension: ExtensionProfile): Promise<void> {
  const popup = await extension.openPopup();
  try {
    expect(
      await popup.evaluate(async () =>
        chrome.runtime.sendMessage({ type: "simulateStartupForTest" }),
      ),
    ).toBe(true);
  } finally {
    await popup.close();
  }
}

async function launchExistingProfileAfterRestart(
  setup: (extension: ExtensionProfile) => Promise<void>,
): Promise<RestartedProfile> {
  const profileDirectory = await mkdtemp(
    path.join(tmpdir(), "tab-recovery-restart-profile-"),
  );
  let firstLaunch: ExtensionProfile | undefined;
  let restarted: ExtensionProfile | undefined;

  try {
    firstLaunch = await launchExtensionProfile({
      automatedTest: true,
      profileDirectory,
    });
    await firstLaunch.close();
    firstLaunch = undefined;

    restarted = await launchExtensionProfile({
      automatedTest: true,
      profileDirectory,
      restoreLastSession: true,
    });
    await simulateStartupForTest(restarted);
    await setup(restarted);
    return {
      extension: restarted,
      close: async () => {
        await restarted?.close();
        restarted = undefined;
        await rm(profileDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await firstLaunch?.close();
    await restarted?.close();
    await rm(profileDirectory, { recursive: true, force: true });
    throw error;
  }
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
): Promise<RecoverySet | undefined> {
  const popup = await extension.openPopup();
  try {
    let recoverySet: RecoverySet | undefined;
    await expect
      .poll(async () => {
        recoverySet = (await popup.evaluate(async () =>
          chrome.runtime.sendMessage({
            type: "reconcileAfterStartupSettlingForTest",
          }),
        )) ?? undefined;
        return recoverySet;
      })
      .toBeDefined();
    return recoverySet;
  } finally {
    await popup.close();
  }
}

async function sendReconciliationControlOnce(
  extension: ExtensionProfile,
): Promise<RecoverySet | undefined> {
  const popup = await extension.openPopup();
  try {
    return (await popup.evaluate(async () =>
      chrome.runtime.sendMessage({ type: "reconcileAfterStartupSettlingForTest" }),
    )) ?? undefined;
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

async function findWindowIdForUrl(
  serviceWorker: Worker,
  url: string,
): Promise<number> {
  const windowId = await serviceWorker.evaluate(async (address) => {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    return tabs.find((tab) => tab.url === address)?.windowId;
  }, url);
  expect(windowId).toEqual(expect.any(Number));
  return windowId!;
}

test("refuses the deterministic control outside browser startup", async () => {
  const extension = await launchExtensionProfile();
  try {
    const popup = await extension.openPopup();
    expect(
      await popup.evaluate(async () =>
        chrome.runtime.sendMessage({ type: "simulateStartupForTest" }),
      ),
    ).toBe(false);
    await popup.close();
    expect(await sendReconciliationControlOnce(extension)).toBeUndefined();
  } finally {
    await extension.close();
  }
});

test("allows startup controls only in the explicit automated-test build", async () => {
  const extension = await launchExtensionProfile({ automatedTest: true });
  try {
    await simulateStartupForTest(extension);
    expect(await reconcileAfterStartupSettlingForTest(extension)).toBeDefined();
  } finally {
    await extension.close();
  }
});

test("complete native restoration associates every equal-address occurrence without changing Recovery Data membership", async () => {
  const duplicateUrl = `${origin}/complete-duplicate`;
  const distinctUrl = `${origin}/complete-distinct`;
  const restarted = await launchExistingProfileAfterRestart(async (extension) => {
    await createRecoverableWindow(extension.serviceWorker, [
      duplicateUrl,
      duplicateUrl,
      distinctUrl,
    ]);
    await waitForOpenWebTabsToSettle(extension.serviceWorker, [
      duplicateUrl,
      duplicateUrl,
      distinctUrl,
    ]);
  });
  const { extension } = restarted;

  try {
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
          browserWindowId: 900,
          tabs: [
            recoveryTab("complete-1", duplicateUrl, 0, 901),
            recoveryTab("complete-2", duplicateUrl, 1, 902),
            recoveryTab("complete-3", distinctUrl, 2, 903),
          ],
        },
      ],
    });
    const browserWindowId = await findWindowIdForUrl(
      extension.serviceWorker,
      distinctUrl,
    );
    const openTabsBefore = await readOpenWebTabs(extension.serviceWorker);

    const reconciled = (await reconcileAfterStartupSettlingForTest(extension))!;

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
    await restarted.close();
  }
});

test("partial native restoration reports only absent occurrences in their best matching Window Grouping", async () => {
  const sharedUrl = `${origin}/partial-shared`;
  const firstSpecificUrl = `${origin}/partial-first`;
  const secondSpecificUrl = `${origin}/partial-second`;
  const restarted = await launchExistingProfileAfterRestart(async (extension) => {
    await createRecoverableWindow(extension.serviceWorker, [
      sharedUrl,
      firstSpecificUrl,
    ]);
    await createRecoverableWindow(extension.serviceWorker, [
      sharedUrl,
      secondSpecificUrl,
    ]);
    await waitForOpenWebTabsToSettle(extension.serviceWorker, [
      sharedUrl,
      firstSpecificUrl,
      sharedUrl,
      secondSpecificUrl,
    ]);
  });
  const { extension } = restarted;

  try {
    await waitForOpenWebTabsToSettle(extension.serviceWorker, [
      sharedUrl,
      firstSpecificUrl,
      sharedUrl,
      secondSpecificUrl,
    ]);
    const firstWindowId = await findWindowIdForUrl(
      extension.serviceWorker,
      firstSpecificUrl,
    );
    const secondWindowId = await findWindowIdForUrl(
      extension.serviceWorker,
      secondSpecificUrl,
    );
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "partial-first-grouping",
          browserWindowId: 910,
          tabs: [
            recoveryTab("partial-first-shared-1", sharedUrl, 0, 911),
            recoveryTab("partial-first-shared-2", sharedUrl, 1, 912),
            recoveryTab("partial-first-specific", firstSpecificUrl, 2, 913),
          ],
        },
        {
          groupingId: "partial-second-grouping",
          browserWindowId: 920,
          tabs: [
            recoveryTab("partial-second-shared", sharedUrl, 0, 921),
            recoveryTab("partial-second-specific", secondSpecificUrl, 1, 922),
          ],
        },
      ],
    });
    const openTabsBefore = await readOpenWebTabs(extension.serviceWorker);

    const reconciled = (await reconcileAfterStartupSettlingForTest(extension))!;
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
        .map((tab) => ({ recordId: tab.recordId, missingReason: tab.missingReason })),
    ).toEqual([
      { recordId: "partial-first-shared-2", missingReason: "startup" },
    ]);
    expect(
      secondGrouping.tabs.filter((tab) => tab.browserTabId === undefined),
    ).toEqual([]);
    expect(reconciled.windows.flatMap((grouping) => grouping.tabs)).toHaveLength(5);
    expect(await readRecoverySet(extension.serviceWorker)).toEqual(reconciled);

    const secondResult = await reconcileAfterStartupSettlingForTest(extension);
    expect(secondResult).toEqual(reconciled);
    expect(await readNotificationIds(extension.serviceWorker)).toHaveLength(1);
    const { startupReconciliationState } = await extension.serviceWorker.evaluate(
      async () => chrome.storage.session.get("startupReconciliationState"),
    );
    expect(startupReconciliationState).toMatchObject({
      completed: true,
      notified: true,
      notificationInvocationCount: 1,
    });
  } finally {
    await restarted.close();
  }
});

test("absent native restoration preserves a distinct missing Window Grouping without opening tabs", async () => {
  const absentUrls = [`${origin}/absent-first`, `${origin}/absent-second`];
  const restarted = await launchExistingProfileAfterRestart(async (extension) => {
    await waitForOpenWebTabsToSettle(extension.serviceWorker, []);
  });
  const { extension } = restarted;

  try {
    await waitForOpenWebTabsToSettle(extension.serviceWorker, []);
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "absent-grouping",
          browserWindowId: 930,
          tabs: [
            recoveryTab("absent-1", absentUrls[0]!, 0, 931),
            recoveryTab("absent-2", absentUrls[1]!, 1, 932),
          ],
        },
      ],
    });
    const openTabsBefore = await readOpenWebTabs(extension.serviceWorker);

    const reconciled = (await reconcileAfterStartupSettlingForTest(extension))!;

    expect(await readOpenWebTabs(extension.serviceWorker)).toEqual(openTabsBefore);
    expect(reconciled).toEqual({
      version: 1,
      windows: [
        {
          groupingId: "absent-grouping",
          tabs: [
            {
              ...recoveryTab("absent-1", absentUrls[0]!, 0),
              missingReason: "startup",
            },
            {
              ...recoveryTab("absent-2", absentUrls[1]!, 1),
              missingReason: "startup",
            },
          ],
        },
      ],
    });
    expect(await readRecoverySet(extension.serviceWorker)).toEqual(reconciled);
    expect(await readNotificationIds(extension.serviceWorker)).toHaveLength(1);
  } finally {
    await restarted.close();
  }
});

test("globally maximizes address occurrences across competing Window Groupings", async () => {
  const urls = Object.fromEntries(
    ["a", "b", "c", "d", "e"].map((name) => [name, `${origin}/global-${name}`]),
  ) as Record<"a" | "b" | "c" | "d" | "e", string>;
  const restarted = await launchExistingProfileAfterRestart(async (extension) => {
    await createRecoverableWindow(extension.serviceWorker, [urls.a, urls.b, urls.c]);
    await createRecoverableWindow(extension.serviceWorker, [urls.d, urls.e]);
    await waitForOpenWebTabsToSettle(extension.serviceWorker, Object.values(urls));
  });
  const { extension } = restarted;

  try {
    await waitForOpenWebTabsToSettle(extension.serviceWorker, Object.values(urls));
    const abcWindowId = await findWindowIdForUrl(extension.serviceWorker, urls.c);
    const deWindowId = await findWindowIdForUrl(extension.serviceWorker, urls.e);
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "large-expected",
          browserWindowId: 940,
          tabs: [urls.a, urls.b, urls.c, urls.d, urls.e].map((url, index) =>
            recoveryTab(`large-${index}`, url, index, 941 + index),
          ),
        },
        {
          groupingId: "small-expected",
          browserWindowId: 950,
          tabs: [
            recoveryTab("small-a", urls.a, 0, 951),
            recoveryTab("small-b", urls.b, 1, 952),
          ],
        },
      ],
    });

    const reconciled = (await reconcileAfterStartupSettlingForTest(extension))!;
    const large = reconciled.windows.find(
      (grouping) => grouping.groupingId === "large-expected",
    )!;
    const small = reconciled.windows.find(
      (grouping) => grouping.groupingId === "small-expected",
    )!;

    expect(large.browserWindowId).toBe(deWindowId);
    expect(small.browserWindowId).toBe(abcWindowId);
    expect(
      reconciled.windows
        .flatMap((grouping) => grouping.tabs)
        .filter((tab) => tab.browserTabId !== undefined),
    ).toHaveLength(4);
    expect(
      large.tabs
        .filter((tab) => tab.browserTabId === undefined)
        .map((tab) => ({ url: tab.url, missingReason: tab.missingReason })),
    ).toEqual([
      { url: urls.a, missingReason: "startup" },
      { url: urls.b, missingReason: "startup" },
      { url: urls.c, missingReason: "startup" },
    ]);
  } finally {
    await restarted.close();
  }
});

test("keeps ordinary Window Closure during startup settling non-notifying", async () => {
  const url = `${origin}/closed-during-startup-settling`;
  const restarted = await launchExistingProfileAfterRestart(async (extension) => {
    await createRecoverableWindow(extension.serviceWorker, [url]);
    await waitForOpenWebTabsToSettle(extension.serviceWorker, [url]);
  });
  const { extension } = restarted;

  try {
    await waitForOpenWebTabsToSettle(extension.serviceWorker, [url]);
    const browserTab = await extension.serviceWorker.evaluate(async (address) => {
      const tabs = await chrome.tabs.query({ windowType: "normal" });
      return tabs.find((tab) => tab.url === address)!;
    }, url);
    await seedRecoverySet(extension.serviceWorker, {
      version: 1,
      windows: [
        {
          groupingId: "closed-during-settling",
          browserWindowId: browserTab.windowId,
          tabs: [
            recoveryTab("closed-during-settling-tab", url, 0, browserTab.id),
          ],
        },
      ],
    });

    await extension.serviceWorker.evaluate(
      async (windowId) => chrome.windows.remove(windowId),
      browserTab.windowId,
    );
    await expect.poll(() => readRecoverySet(extension.serviceWorker)).toMatchObject({
      windows: [
        {
          groupingId: "closed-during-settling",
          tabs: [
            {
              missingReason: "window-closure",
            },
          ],
        },
      ],
    });

    const reconciled = (await reconcileAfterStartupSettlingForTest(extension))!;
    expect(reconciled.windows[0]!.tabs[0]).toMatchObject({
      recordId: "closed-during-settling-tab",
      missingReason: "window-closure",
    });
    expect(reconciled.windows[0]!.tabs[0]!.browserTabId).toBeUndefined();
    expect(await readNotificationIds(extension.serviceWorker)).toEqual([]);
    const { startupReconciliationState } = await extension.serviceWorker.evaluate(
      async () => chrome.storage.session.get("startupReconciliationState"),
    );
    expect(startupReconciliationState).toMatchObject({
      completed: true,
      notified: false,
      notificationInvocationCount: 0,
    });
  } finally {
    await restarted.close();
  }
});
