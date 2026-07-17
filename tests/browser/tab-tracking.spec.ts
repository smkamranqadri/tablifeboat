import { expect, test } from "@playwright/test";

test("persists Individual Tab Closure when placement reindex lookup fails", async () => {
  const originalChrome = globalThis.chrome;
  const originalConsoleError = console.error;
  let removedListener:
    | ((tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void)
    | undefined;
  let loggedError: unknown[] | undefined;
  let storedRecoverySet = {
    version: 1 as const,
    windows: [
      {
        groupingId: "grouping-1",
        browserWindowId: 7,
        tabs: [
          {
            recordId: "record-1",
            browserTabId: 42,
            title: "Tracked page",
            url: "https://example.com/",
            placement: { index: 0, pinned: false },
          },
        ],
      },
    ],
  };

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ recoverySet: structuredClone(storedRecoverySet) }),
        set: async ({ recoverySet }: { recoverySet: typeof storedRecoverySet }) => {
          storedRecoverySet = structuredClone(recoverySet);
        },
      },
    },
    tabs: {
      onCreated: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
      onMoved: { addListener: () => undefined },
      onDetached: { addListener: () => undefined },
      onAttached: { addListener: () => undefined },
      onRemoved: {
        addListener: (listener: typeof removedListener) => {
          removedListener = listener;
        },
      },
    },
    windows: {
      onRemoved: { addListener: () => undefined },
      get: async () => {
        throw new Error("window lookup failed");
      },
    },
  } as unknown as typeof chrome;
  console.error = (...args: unknown[]) => {
    loggedError = args;
  };

  try {
    const [{ RecoveryStore }, { startTabTracking }] = await Promise.all([
      import("../../dist/recovery-store.js"),
      import("../../dist/tab-tracking.js"),
    ]);
    startTabTracking(new RecoveryStore());

    removedListener?.(42, { windowId: 7, isWindowClosing: false });

    await expect.poll(() => storedRecoverySet.windows).toEqual([]);
    await expect.poll(() => loggedError?.[0]).toBe(
      "Failed to reindex Window Grouping after Individual Tab Closure",
    );
  } finally {
    console.error = originalConsoleError;
    globalThis.chrome = originalChrome;
  }
});
