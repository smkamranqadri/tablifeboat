import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect, test, type BrowserContext } from "@playwright/test";
import { launchExtensionProfile, type ExtensionProfile } from "./extension-profile";
import { readRecoverySet } from "./recovery-data";

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
  const profileDirectory = await mkdtemp(path.join(tmpdir(), "tablifeboat-profile-"));
  let setupContext: BrowserContext | undefined;
  let extension: ExtensionProfile | undefined;

  try {
    setupContext = await chromium.launchPersistentContext(profileDirectory, {
      headless: true,
      channel: "chromium",
    });
    const [initialPage] = setupContext.pages();
    await initialPage.goto(`${origin}/shared`);
    await (await setupContext.newPage()).goto(`${origin}/shared`);
    await (await setupContext.newPage()).goto(`${origin}/distinct`);
    await setupContext.newPage();
    await setupContext.close();
    setupContext = undefined;

    extension = await launchExtensionProfile({
      profileDirectory,
      restoreLastSession: true,
    });

    const popup = await extension.openPopup();

    await expect(popup.getByRole("heading", { name: "Tab Lifeboat" })).toBeVisible();
    await expect(popup.getByText("3 open protected tabs")).toBeVisible();

    const hasIncognitoAccess = await extension.serviceWorker.evaluate(
      () => chrome.extension.isAllowedIncognitoAccess(),
    );
    expect(hasIncognitoAccess).toBe(false);

    await expect
      .poll(async () =>
        readRecoverySet(extension!.serviceWorker),
      )
      .toBeDefined();

    const recoverySet = (await readRecoverySet(extension.serviceWorker))!;
    const trackedTabs = recoverySet.windows.flatMap((window) => window.tabs);

    expect(recoverySet.version).toBe(1);
    expect(trackedTabs).toHaveLength(3);
    expect(trackedTabs.map((tab) => tab.url).sort()).toEqual(
      [`${origin}/distinct`, `${origin}/shared`, `${origin}/shared`].sort(),
    );
    expect(trackedTabs.every((tab) => tab.url.startsWith("http://"))).toBe(true);
    expect(new Set(trackedTabs.map((tab) => tab.browserTabId)).size).toBe(3);
    expect(
      recoverySet.windows.every((window) =>
        Number.isInteger(window.browserWindowId),
      ),
    ).toBe(true);
    expect(
      trackedTabs.every(
        (tab) =>
          typeof tab.title === "string" &&
          Number.isInteger(tab.placement.index) &&
          typeof tab.placement.pinned === "boolean",
      ),
    ).toBe(true);
  } finally {
    await setupContext?.close();
    if (extension) {
      await extension.close();
    }
    await expect(stat(profileDirectory)).resolves.toBeDefined();
    await rm(profileDirectory, { recursive: true, force: true });
  }
});
