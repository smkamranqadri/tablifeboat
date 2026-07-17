import { createServer, type Server } from "node:http";
import { expect, test } from "@playwright/test";
import { launchExtensionProfile } from "./extension-profile";
import { readRecoverySet, type TrackedTab } from "./recovery-data";

let server: Server;
let origin: string;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const title = request.url === "/first" ? "First page" : "Second page";
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

test("keeps each Tracked Tab current through navigation and Individual Tab Closure", async () => {
  const extension = await launchExtensionProfile();

  try {
    const webTab = await extension.context.newPage();
    await webTab.goto(`${origin}/first`);

    let firstRecord: TrackedTab | undefined;
    await expect
      .poll(async () => {
        const recoverySet = await readRecoverySet(extension.serviceWorker);
        const matchingTabs =
          recoverySet?.windows.flatMap((window) => window.tabs).filter((tab) =>
            tab.url.startsWith(origin),
          ) ?? [];
        firstRecord = matchingTabs[0];
        return matchingTabs.map(({ title, url }) => ({ title, url }));
      })
      .toEqual([{ title: "First page", url: `${origin}/first` }]);

    expect(firstRecord?.recordId).toEqual(expect.any(String));
    const originalRecordId = firstRecord!.recordId;

    await webTab.goto(`${origin}/second`);
    await expect
      .poll(async () => {
        const recoverySet = await readRecoverySet(extension.serviceWorker);
        return (
          recoverySet?.windows.flatMap((window) => window.tabs).filter((tab) =>
            tab.url.startsWith(origin),
          ) ?? []
        ).map(({ recordId, title, url }) => ({ recordId, title, url }));
      })
      .toEqual([
        {
          recordId: originalRecordId,
          title: "Second page",
          url: `${origin}/second`,
        },
      ]);

    const afterNavigation = await readRecoverySet(extension.serviceWorker);
    expect(
      afterNavigation?.windows
        .flatMap((window) => window.tabs)
        .some((tab) => tab.url === `${origin}/first`),
    ).toBe(false);

    await webTab.goto("about:blank");
    await expect
      .poll(async () => {
        const recoverySet = await readRecoverySet(extension.serviceWorker);
        return (
          recoverySet?.windows.flatMap((window) => window.tabs).filter((tab) =>
            tab.url.startsWith(origin),
          ).length ?? 0
        );
      })
      .toBe(0);

    await webTab.goto(`${origin}/first`);
    await expect
      .poll(async () => {
        const recoverySet = await readRecoverySet(extension.serviceWorker);
        return (
          recoverySet?.windows.flatMap((window) => window.tabs).filter((tab) =>
            tab.url.startsWith(origin),
          ) ?? []
        ).map(({ title, url }) => ({ title, url }));
      })
      .toEqual([{ title: "First page", url: `${origin}/first` }]);

    await webTab.close();
    await expect
      .poll(async () => {
        const recoverySet = await readRecoverySet(extension.serviceWorker);
        return (
          recoverySet?.windows.flatMap((window) => window.tabs).filter((tab) =>
            tab.url.startsWith(origin),
          ).length ?? 0
        );
      })
      .toBe(0);
  } finally {
    await extension.close();
  }
});
