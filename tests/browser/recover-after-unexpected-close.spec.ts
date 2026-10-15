import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Worker } from "@playwright/test";
import {
  launchExtensionProfile,
  type ExtensionProfile,
} from "./extension-profile";
import { readRecoverySet } from "./recovery-data";

const SESSION_PERSIST_MS = 4_000;

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

// The headless harness never performs Chromium's own session restore, so a
// restored Recoverable Window is stood up by recreating its addresses.
async function nativelyRestoreWindow(
  serviceWorker: Worker,
  urls: string[],
): Promise<void> {
  await serviceWorker.evaluate(async (addresses) => {
    const browserWindow = await chrome.windows.create({
      type: "normal",
      url: addresses[0],
    });
    for (const address of addresses.slice(1)) {
      await chrome.tabs.create({ windowId: browserWindow.id, url: address });
    }
  }, urls);
}

async function openWebTabAddresses(serviceWorker: Worker): Promise<string[]> {
  const urls = await serviceWorker.evaluate(async () => {
    const tabs = await chrome.tabs.query({ windowType: "normal" });
    return tabs.flatMap((tab) => (tab.url?.startsWith("http") ? [tab.url] : []));
  });
  return urls.sort();
}

// "open" counts only records bound to a browser tab that exists right now: a
// stale association left by the crash would otherwise read as a protected tab.
async function recoverySummary(serviceWorker: Worker) {
  const set = await readRecoverySet(serviceWorker);
  const tabs = set?.windows.flatMap((grouping) => grouping.tabs) ?? [];
  const liveTabIds = new Set(
    await serviceWorker.evaluate(async () => {
      const openTabs = await chrome.tabs.query({ windowType: "normal" });
      return openTabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
    }),
  );
  return {
    addresses: tabs.map((tab) => tab.url).sort(),
    recordIds: tabs.map((tab) => tab.recordId).sort(),
    open: tabs.filter(
      (tab) => tab.browserTabId !== undefined && liveTabIds.has(tab.browserTabId),
    ).length,
    missing: tabs.filter((tab) => tab.browserTabId === undefined).length,
  };
}

async function waitForTrackedAddresses(
  serviceWorker: Worker,
  addresses: string[],
): Promise<void> {
  await expect
    .poll(async () => (await recoverySummary(serviceWorker)).addresses)
    .toEqual([...addresses].sort());
}

async function restoreAll(extension: ExtensionProfile) {
  const popup = await extension.openPopup();
  try {
    return (await popup.evaluate(async () =>
      chrome.runtime.sendMessage({ type: "restoreAll" }),
    )) as { restoredRecordIds: string[]; failedRecordIds: string[] };
  } finally {
    await popup.close();
  }
}

async function readRecoveryPopupSummary(extension: ExtensionProfile) {
  const popup = await extension.openPopup();
  try {
    return (await popup.evaluate(async () =>
      chrome.runtime.sendMessage({ type: "getRecoverySummary" }),
    )) as { protectedTabCount: number; missingTabCount: number };
  } finally {
    await popup.close();
  }
}

interface UnexpectedClose {
  extension: ExtensionProfile;
  recordIdsBeforeClose: string[];
  relaunch: () => Promise<ExtensionProfile>;
  close: () => Promise<void>;
}

interface UnexpectedCloseOptions {
  // Chromium only rebuilds the previous session when the profile already holds
  // one from an earlier clean run, so a warm-up launch is what decides whether
  // this close is followed by native restoration or by an empty browser.
  withNativeRestoration: boolean;
}

async function closeBrowserUnexpectedly(
  windows: string[][],
  options: UnexpectedCloseOptions,
): Promise<UnexpectedClose> {
  const profileDirectory = await mkdtemp(
    path.join(tmpdir(), "tablifeboat-unexpected-close-"),
  );
  let session: ExtensionProfile | undefined;

  const launch = () =>
    launchExtensionProfile({
      automatedTest: true,
      profileDirectory,
      restoreLastSession: true,
    });

  try {
    if (options.withNativeRestoration) {
      const warmUp = await launchExtensionProfile({
        automatedTest: true,
        profileDirectory,
      });
      await warmUp.close();
    }

    session = await launch();
    for (const urls of windows) {
      await nativelyRestoreWindow(session.serviceWorker, urls);
    }
    await waitForTrackedAddresses(session.serviceWorker, windows.flat());
    const recordIdsBeforeClose = (await recoverySummary(session.serviceWorker))
      .recordIds;

    // Chromium writes its session file on a delay. Crashing before that write
    // lands leaves the next launch with nothing to restore.
    const crashAfterSessionIsPersisted = async () => {
      await new Promise((resolve) => setTimeout(resolve, SESSION_PERSIST_MS));
      await session!.crash();
    };

    await crashAfterSessionIsPersisted();
    session = await launch();

    return {
      extension: session,
      recordIdsBeforeClose,
      relaunch: async () => {
        await crashAfterSessionIsPersisted();
        session = await launch();
        return session;
      },
      close: async () => {
        await session?.close().catch(() => undefined);
        await rm(profileDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await session?.close().catch(() => undefined);
    await rm(profileDirectory, { recursive: true, force: true });
    throw error;
  }
}

test("Manual Recovery started while Chromium is still restoring does not duplicate the restored tabs", async () => {
  const alpha = `${origin}/unexpected-alpha`;
  const beta = `${origin}/unexpected-beta`;
  const gamma = `${origin}/unexpected-gamma`;
  const restarted = await closeBrowserUnexpectedly([[alpha, beta], [gamma]], {
    withNativeRestoration: false,
  });
  const { extension, recordIdsBeforeClose } = restarted;

  try {
    // Chromium rebuilds the previous session shortly after launch, while the
    // user is already reaching for the Recovery Popup.
    const nativeRestoration = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        void nativelyRestoreWindow(extension.serviceWorker, [alpha, beta])
          .then(() => nativelyRestoreWindow(extension.serviceWorker, [gamma]))
          .then(resolve, reject);
      }, 1_500);
    });

    const summary = await readRecoveryPopupSummary(extension);
    const result = await restoreAll(extension);
    await nativeRestoration;

    expect(summary).toMatchObject({ missingTabCount: 0, protectedTabCount: 3 });
    expect(result).toEqual({ restoredRecordIds: [], failedRecordIds: [] });
    expect(await openWebTabAddresses(extension.serviceWorker)).toEqual(
      [alpha, beta, gamma].sort(),
    );
    await expect
      .poll(() => recoverySummary(extension.serviceWorker))
      .toEqual({
        addresses: [alpha, beta, gamma].sort(),
        recordIds: recordIdsBeforeClose,
        open: 3,
        missing: 0,
      });
  } finally {
    await restarted.close();
  }
});

test("an unexpected close keeps every durable record when Chromium restores only some Window Groupings", async () => {
  const alpha = `${origin}/partial-alpha`;
  const beta = `${origin}/partial-beta`;
  const gamma = `${origin}/partial-gamma`;
  const restarted = await closeBrowserUnexpectedly([[alpha, beta], [gamma]], {
    withNativeRestoration: false,
  });
  const { extension, recordIdsBeforeClose } = restarted;

  try {
    await nativelyRestoreWindow(extension.serviceWorker, [alpha, beta]);

    await expect
      .poll(() => recoverySummary(extension.serviceWorker), { timeout: 20_000 })
      .toEqual({
        addresses: [alpha, beta, gamma].sort(),
        recordIds: recordIdsBeforeClose,
        open: 2,
        missing: 1,
      });

    const result = await restoreAll(extension);

    expect(result.failedRecordIds).toEqual([]);
    expect(result.restoredRecordIds).toHaveLength(1);
    expect(await openWebTabAddresses(extension.serviceWorker)).toEqual(
      [alpha, beta, gamma].sort(),
    );
    await expect
      .poll(() => recoverySummary(extension.serviceWorker))
      .toEqual({
        addresses: [alpha, beta, gamma].sort(),
        recordIds: recordIdsBeforeClose,
        open: 3,
        missing: 0,
      });
  } finally {
    await restarted.close();
  }
});

test("Chromium's own session restore after repeated unexpected closes reuses the durable records", async () => {
  test.setTimeout(180_000);
  const alpha = `${origin}/native-alpha`;
  const beta = `${origin}/native-beta`;
  const restarted = await closeBrowserUnexpectedly([[alpha, beta]], {
    withNativeRestoration: true,
  });
  const { recordIdsBeforeClose } = restarted;
  let extension = restarted.extension;

  try {
    for (let round = 0; round < 3; round += 1) {
      await expect
        .poll(() => openWebTabAddresses(extension.serviceWorker), { timeout: 40_000 })
        .toEqual([alpha, beta].sort());
      await expect
        .poll(() => recoverySummary(extension.serviceWorker), { timeout: 20_000 })
        .toEqual({
          addresses: [alpha, beta].sort(),
          recordIds: recordIdsBeforeClose,
          open: 2,
          missing: 0,
        });
      if (round < 2) {
        extension = await restarted.relaunch();
      }
    }
  } finally {
    await restarted.close();
  }
});
