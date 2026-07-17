import { expect, test } from "@playwright/test";

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
        windowId: 1,
        tabs: [],
      });
      operationOrder.push("first-end");
    });
    const secondUpdate = store.update((set) => {
      operationOrder.push("second");
      set.windows.push({
        groupingId: "second-grouping",
        windowId: 2,
        tabs: [],
      });
    });

    await expect.poll(() => operationOrder).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([firstUpdate, secondUpdate]);

    expect(operationOrder).toEqual(["first-start", "first-end", "second"]);
    expect(storedRecoverySet).toMatchObject({
      windows: [
        { groupingId: "first-grouping", windowId: 1 },
        { groupingId: "second-grouping", windowId: 2 },
      ],
    });
  } finally {
    globalThis.chrome = originalChrome;
  }
});
