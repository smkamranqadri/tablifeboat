import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Worker } from "@playwright/test";
import type { RecoverySet, WindowGrouping } from "../../src/recovery-model";
import {
  launchExtensionProfile,
  type ExtensionProfile,
} from "./extension-profile";
import { readRecoverySet } from "./recovery-data";

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const title = request.url?.slice(1) || "Durability";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${title}</title><h1>${title}</h1>`);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected the durability server to listen on a TCP port");
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

async function reconcileAfterWorkerRestart(
  extension: ExtensionProfile,
): Promise<RecoverySet> {
  const popup = await extension.openPopup();
  try {
    const startupArmed = await popup.evaluate(async () =>
      chrome.runtime.sendMessage({ type: "simulateStartupForTest" }),
    );
    expect(startupArmed).toBe(true);

    const reconciled = await popup.evaluate(async () =>
      chrome.runtime.sendMessage({
        type: "reconcileAfterStartupSettlingForTest",
      }),
    );
    return reconciled as RecoverySet;
  } finally {
    await popup.close();
  }
}

function durableSnapshot(recoverySet: RecoverySet) {
  return recoverySet.windows.map((grouping) => ({
    groupingId: grouping.groupingId,
    tabs: grouping.tabs.map((tab) => ({
      recordId: tab.recordId,
      title: tab.title,
      url: tab.url,
      placement: tab.placement,
    })),
  }));
}

test("completed Recovery Data survives browser and MV3 service-worker restart, then reconciles from storage", async () => {
  const profileDirectory = await mkdtemp(
    path.join(tmpdir(), "tablifeboat-durability-profile-"),
  );
  let firstLaunch: ExtensionProfile | undefined;
  let restarted: ExtensionProfile | undefined;
  const keptUrl = `${origin}/kept-after-restart`;
  const individuallyClosedUrl = `${origin}/closed-before-restart`;

  try {
    firstLaunch = await launchExtensionProfile({
      automatedTest: true,
      profileDirectory,
    });
    const created = await firstLaunch.serviceWorker.evaluate(
      async ([firstUrl, secondUrl]) => {
        const browserWindow = await chrome.windows.create({
          type: "normal",
          url: firstUrl,
        });
        const secondTab = await chrome.tabs.create({
          windowId: browserWindow.id,
          url: secondUrl,
        });
        return { secondTabId: secondTab.id! };
      },
      [keptUrl, individuallyClosedUrl] as const,
    );

    await expect
      .poll(() =>
        findWindowGrouping(firstLaunch!.serviceWorker, [
          keptUrl,
          individuallyClosedUrl,
        ]),
      )
      .toMatchObject({
        groupingId: expect.any(String),
        tabs: [
          expect.objectContaining({ url: keptUrl }),
          expect.objectContaining({ url: individuallyClosedUrl }),
        ],
      });

    await firstLaunch.serviceWorker.evaluate(
      async (browserTabId) => chrome.tabs.remove(browserTabId),
      created.secondTabId,
    );
    await expect
      .poll(() => findWindowGrouping(firstLaunch!.serviceWorker, [keptUrl]))
      .toMatchObject({
        groupingId: expect.any(String),
        tabs: [expect.objectContaining({ url: keptUrl })],
      });
    await expect
      .poll(async () => {
        const set = await readRecoverySet(firstLaunch!.serviceWorker);
        return set?.windows.some((grouping) =>
          grouping.tabs.some((tab) => tab.url === individuallyClosedUrl),
        );
      })
      .toBe(false);

    const completedWrite = (await readRecoverySet(firstLaunch.serviceWorker))!;
    const durableGrouping = completedWrite.windows.find((grouping) =>
      grouping.tabs.some((tab) => tab.url === keptUrl),
    )!;

    await firstLaunch.close();
    firstLaunch = undefined;
    restarted = await launchExtensionProfile({
      automatedTest: true,
      profileDirectory,
      restoreLastSession: true,
    });

    expect(await readRecoverySet(restarted.serviceWorker)).toEqual(completedWrite);

    const reconciled = await reconcileAfterWorkerRestart(restarted);
    expect(durableSnapshot(reconciled)).toEqual(durableSnapshot(completedWrite));
    const reconciledGrouping = reconciled.windows.find(
      (grouping) => grouping.groupingId === durableGrouping.groupingId,
    )!;
    expect(reconciledGrouping.browserWindowId).toEqual(expect.any(Number));
    expect(reconciledGrouping.tabs[0]!.browserTabId).toEqual(expect.any(Number));
    expect(reconciledGrouping.tabs[0]!.missingReason).toBeUndefined();
    expect(
      reconciled.windows.some((grouping) =>
        grouping.tabs.some((tab) => tab.url === individuallyClosedUrl),
      ),
    ).toBe(false);
  } finally {
    await firstLaunch?.close();
    await restarted?.close();
    await rm(profileDirectory, { recursive: true, force: true });
  }
});
