import { expect, test } from "@playwright/test";

test("logs badge synchronization rejection with its lifecycle context", async () => {
  const originalChrome = globalThis.chrome;
  const originalConsoleError = console.error;
  const badgeError = new Error("badge unavailable");
  let loggedError: unknown[] | undefined;

  globalThis.chrome = {
    action: {
      setBadgeText: async () => {
        throw badgeError;
      },
    },
  } as unknown as typeof chrome;
  console.error = (...args: unknown[]) => {
    loggedError = args;
  };

  try {
    const { synchronizeRecoveryBadgeWithLogging } = await import(
      "../../dist/recovery-status.js"
    );
    synchronizeRecoveryBadgeWithLogging(
      { version: 1, windows: [] },
      "after Recovery Data changed",
    );

    await expect.poll(() => loggedError).toEqual([
      "Failed to synchronize Recovery badge after Recovery Data changed",
      badgeError,
    ]);
  } finally {
    console.error = originalConsoleError;
    globalThis.chrome = originalChrome;
  }
});
