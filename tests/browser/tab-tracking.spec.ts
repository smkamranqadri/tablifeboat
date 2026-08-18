import { expect, test } from "@playwright/test";

interface ListenerHarness {
  fireTabRemoved: (tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void;
  fireWindowRemoved: (windowId: number) => void;
  announceReplacement: (
    replacement: chrome.tabs.Tab,
    removedTabId: number,
  ) => void;
  readWindows: () => Array<{
    groupingId: string;
    browserWindowId?: number;
    tabs: Array<{
      recordId: string;
      browserTabId?: number;
      missingReason?: "startup" | "window-closure";
    }>;
  }>;
}

async function startListenerHarness(): Promise<ListenerHarness> {
  let tabRemovedListener:
    | ((tabId: number, removeInfo: chrome.tabs.TabRemoveInfo) => void)
    | undefined;
  let windowRemovedListener: ((windowId: number) => void) | undefined;
  let tabReplacedListener:
    | ((addedTabId: number, removedTabId: number) => void)
    | undefined;
  let replacementTab: chrome.tabs.Tab | undefined;
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
      onReplaced: {
        addListener: (listener: typeof tabReplacedListener) => {
          tabReplacedListener = listener;
        },
      },
      onRemoved: {
        addListener: (listener: typeof tabRemovedListener) => {
          tabRemovedListener = listener;
        },
      },
      get: async (tabId: number) => {
        if (replacementTab?.id !== tabId) {
          throw new Error(`unknown tab ${tabId}`);
        }
        return replacementTab;
      },
      query: async () => {
        throw new Error("ambiguous tab lookup failure");
      },
    },
    windows: {
      onRemoved: {
        addListener: (listener: typeof windowRemovedListener) => {
          windowRemovedListener = listener;
        },
      },
      get: async () => {
        throw new Error("ambiguous window lookup failure");
      },
    },
  } as unknown as typeof chrome;

  const [{ RecoveryStore }, { startTabTracking }] = await Promise.all([
    import("../../dist/recovery-store.js"),
    import("../../dist/tab-tracking.js"),
  ]);
  startTabTracking(new RecoveryStore());

  return {
    fireTabRemoved: (tabId, removeInfo) => tabRemovedListener!(tabId, removeInfo),
    fireWindowRemoved: (windowId) => windowRemovedListener!(windowId),
    announceReplacement: (replacement, removedTabId) => {
      replacementTab = replacement;
      tabReplacedListener!(replacement.id!, removedTabId);
    },
    readWindows: () =>
      storedRecoverySet.windows.map((grouping) => ({
        groupingId: grouping.groupingId,
        browserWindowId: grouping.browserWindowId,
        tabs: grouping.tabs.map((tab) => ({
          recordId: tab.recordId,
          browserTabId: tab.browserTabId,
          missingReason: tab.missingReason,
        })),
      })),
  };
}

test("preserves a pending false removal when Window Closure arrives before settlement", async () => {
  const originalChrome = globalThis.chrome;
  const harness = await startListenerHarness();

  try {
    harness.fireTabRemoved(42, { windowId: 7, isWindowClosing: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    harness.fireWindowRemoved(7);

    await expect.poll(harness.readWindows).toEqual([
      {
        groupingId: "grouping-1",
        browserWindowId: undefined,
        tabs: [
          {
            recordId: "record-1",
            browserTabId: undefined,
            missingReason: "window-closure",
          },
        ],
      },
    ]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("does not resurrect an Individual Tab Closure when Window Closure arrives after settlement", async () => {
  const originalChrome = globalThis.chrome;
  const originalConsoleError = console.error;
  const harness = await startListenerHarness();
  console.error = () => undefined;

  try {
    harness.fireTabRemoved(42, { windowId: 7, isWindowClosing: false });
    await expect.poll(harness.readWindows).toEqual([]);

    harness.fireWindowRemoved(7);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(harness.readWindows()).toEqual([]);
  } finally {
    console.error = originalConsoleError;
    globalThis.chrome = originalChrome;
  }
});

test("persists Individual Tab Closure when the window has already gone", async () => {
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
      onReplaced: { addListener: () => undefined },
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
    // A window that has already gone is the ordinary shape of this race, not a
    // reindex failure worth reporting to the extension error log.
    expect(loggedError).toBeUndefined();
  } finally {
    console.error = originalConsoleError;
    globalThis.chrome = originalChrome;
  }
});

test("moves a Tracked Tab onto the browser tab id that replaced it", async () => {
  const originalChrome = globalThis.chrome;
  const harness = await startListenerHarness();

  try {
    harness.announceReplacement(
      {
        id: 99,
        index: 0,
        pinned: false,
        windowId: 7,
        url: "https://example.com/",
        title: "Tracked page",
        incognito: false,
      } as chrome.tabs.Tab,
      42,
    );

    await expect.poll(harness.readWindows).toEqual([
      {
        groupingId: "grouping-1",
        browserWindowId: 7,
        tabs: [
          {
            recordId: "record-1",
            browserTabId: 99,
            missingReason: undefined,
          },
        ],
      },
    ]);
  } finally {
    globalThis.chrome = originalChrome;
  }
});
