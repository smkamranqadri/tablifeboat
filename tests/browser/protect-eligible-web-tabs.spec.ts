import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";

interface TrackedTab {
  browserTabId: number;
  title: string;
  url: string;
  placement: {
    windowId: number;
    index: number;
    pinned: boolean;
  };
}

interface RecoverySet {
  version: 1;
  windows: WindowGrouping[];
}

interface WindowGrouping {
  windowId: number;
  tabs: TrackedTab[];
}

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const title = request.url === "/shared" ? "Shared page" : "Distinct page";
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

test("protects existing eligible Web Tabs when the extension is installed", async () => {
  const profileDirectory = await mkdtemp(path.join(tmpdir(), "tab-recovery-profile-"));
  const extensionDirectory = path.resolve("dist");
  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      headless: true,
      channel: "chromium",
    });
    const [initialPage] = context.pages();
    await initialPage.goto(`${origin}/shared`);
    await (await context.newPage()).goto(`${origin}/shared`);
    await (await context.newPage()).goto(`${origin}/distinct`);
    await context.newPage();
    await context.close();

    context = await chromium.launchPersistentContext(profileDirectory, {
      headless: true,
      channel: "chromium",
      args: [
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
        "--restore-last-session",
      ],
    });

    const serviceWorker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(serviceWorker.url()).hostname;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    await expect(popup.getByRole("heading", { name: "Tab Recovery" })).toBeVisible();
    await expect(popup.getByText("3 open protected tabs")).toBeVisible();

    const canAccessPrivateTabs = await serviceWorker.evaluate(
      () => chrome.extension.isAllowedIncognitoAccess(),
    );
    expect(canAccessPrivateTabs).toBe(false);

    await expect
      .poll(async () =>
        serviceWorker.evaluate(async () => {
          const { recoverySet } = (await chrome.storage.local.get("recoverySet")) as {
            recoverySet?: RecoverySet;
          };
          return recoverySet;
        }),
      )
      .toBeDefined();

    const recoverySet = await serviceWorker.evaluate(async () => {
      const stored = (await chrome.storage.local.get("recoverySet")) as {
        recoverySet: RecoverySet;
      };
      return stored.recoverySet;
    });
    const trackedTabs = recoverySet.windows.flatMap((window) => window.tabs);

    expect(recoverySet.version).toBe(1);
    expect(trackedTabs).toHaveLength(3);
    expect(trackedTabs.map((tab) => tab.url).sort()).toEqual(
      [`${origin}/distinct`, `${origin}/shared`, `${origin}/shared`].sort(),
    );
    expect(trackedTabs.every((tab) => tab.url.startsWith("http://"))).toBe(true);
    expect(new Set(trackedTabs.map((tab) => tab.browserTabId)).size).toBe(3);
    expect(
      trackedTabs.every(
        (tab) =>
          typeof tab.title === "string" &&
          Number.isInteger(tab.placement.windowId) &&
          Number.isInteger(tab.placement.index) &&
          typeof tab.placement.pinned === "boolean",
      ),
    ).toBe(true);
  } finally {
    await context?.close();
    await rm(profileDirectory, { recursive: true, force: true });
  }
});
