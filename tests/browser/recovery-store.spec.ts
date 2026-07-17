import { expect, test } from "@playwright/test";

test("does not resolve a mutation until its serialized persistent write completes", async () => {
  const originalChrome = globalThis.chrome;
  let releaseWrite!: () => void;
  let markWriteStarted!: () => void;
  const writeCanFinish = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const writeStarted = new Promise<void>((resolve) => {
    markWriteStarted = resolve;
  });

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({}),
        set: async () => {
          markWriteStarted();
          await writeCanFinish;
        },
      },
    },
  } as typeof chrome;

  try {
    const { RecoveryStore } = await import("../../dist/recovery-store.js");
    const store = new RecoveryStore();
    let mutationResolved = false;
    const mutation = store.update((set) => {
      set.windows.push({
        groupingId: "durable-grouping",
        browserWindowId: 1,
        tabs: [],
      });
    });
    void mutation.then(() => {
      mutationResolved = true;
    });

    await writeStarted;
    expect(mutationResolved).toBe(false);

    releaseWrite();
    await mutation;
    expect(mutationResolved).toBe(true);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test("awaits async mutators before the next queued update", async () => {
  const originalChrome = globalThis.chrome;
  let storedRecoverySet: unknown;

  globalThis.chrome = {
    storage: {
      local: {
        get: async () => ({ recoverySet: structuredClone(storedRecoverySet) }),
        set: async ({ recoverySet }: { recoverySet: unknown }) => {
          storedRecoverySet = structuredClone(recoverySet);
        },
      },
    },
  } as typeof chrome;

  try {
    const { RecoveryStore } = await import("../../dist/recovery-store.js");
    const store = new RecoveryStore();
    const operationOrder: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const firstUpdate = store.update(async (set) => {
      operationOrder.push("first-start");
      await firstCanFinish;
      set.windows.push({
        groupingId: "first-grouping",
        browserWindowId: 1,
        tabs: [],
      });
      operationOrder.push("first-end");
    });
    const secondUpdate = store.update((set) => {
      operationOrder.push("second");
      set.windows.push({
        groupingId: "second-grouping",
        browserWindowId: 2,
        tabs: [],
      });
    });

    await expect.poll(() => operationOrder).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([firstUpdate, secondUpdate]);

    expect(operationOrder).toEqual(["first-start", "first-end", "second"]);
    expect(storedRecoverySet).toMatchObject({
      windows: [
        { groupingId: "first-grouping", browserWindowId: 1 },
        { groupingId: "second-grouping", browserWindowId: 2 },
      ],
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});
