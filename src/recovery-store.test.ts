import { describe, expect, it } from "vitest";
import { EMPTY_RECOVERY_SET } from "./recovery-model.js";
import { migrateRecoverySet, type StoredRecoverySet } from "./recovery-store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stored(windows: StoredRecoverySet["windows"]): StoredRecoverySet {
  return { version: 1, windows };
}

describe("migrateRecoverySet", () => {
  it("returns a fresh empty set for absent Recovery Data without marking a migration", () => {
    const { set, migrated } = migrateRecoverySet(undefined);

    expect(set).toEqual({ version: 1, windows: [] });
    expect(migrated).toBe(false);
    expect(set).not.toBe(EMPTY_RECOVERY_SET);

    set.windows.push({ groupingId: "x", tabs: [] });
    expect(EMPTY_RECOVERY_SET.windows).toHaveLength(0);
  });

  it("passes an already-canonical set through unchanged and reports no migration", () => {
    const input = stored([
      {
        groupingId: "g1",
        browserWindowId: 7,
        tabs: [
          {
            recordId: "r1",
            browserTabId: 21,
            title: "A",
            url: "https://a.test/",
            placement: { index: 0, pinned: false },
          },
        ],
      },
    ]);

    const { set, migrated } = migrateRecoverySet(input);

    expect(migrated).toBe(false);
    expect(set).toEqual({
      version: 1,
      windows: [
        {
          groupingId: "g1",
          browserWindowId: 7,
          tabs: [
            {
              recordId: "r1",
              browserTabId: 21,
              title: "A",
              url: "https://a.test/",
              placement: { index: 0, pinned: false },
            },
          ],
        },
      ],
    });
  });

  it("promotes the legacy windowId field to browserWindowId and marks a migration", () => {
    const { set, migrated } = migrateRecoverySet(
      stored([
        {
          groupingId: "g1",
          windowId: 42,
          tabs: [],
        },
      ]),
    );

    expect(migrated).toBe(true);
    expect(set.windows[0]!.browserWindowId).toBe(42);
    expect(set.windows[0]).not.toHaveProperty("windowId");
  });

  it("keeps an existing browserWindowId but still migrates away the leftover legacy windowId", () => {
    const { set, migrated } = migrateRecoverySet(
      stored([
        {
          groupingId: "g1",
          browserWindowId: 9,
          windowId: 42,
          tabs: [],
        },
      ]),
    );

    expect(migrated).toBe(true);
    expect(set.windows[0]!.browserWindowId).toBe(9);
    expect(set.windows[0]).not.toHaveProperty("windowId");
  });

  it("generates a durable groupingId when one is missing", () => {
    const { set, migrated } = migrateRecoverySet(
      stored([{ browserWindowId: 1, tabs: [] }]),
    );

    expect(migrated).toBe(true);
    expect(set.windows[0]!.groupingId).toMatch(UUID_RE);
  });

  it("generates a durable recordId when a tab is missing one", () => {
    const { set, migrated } = migrateRecoverySet(
      stored([
        {
          groupingId: "g1",
          browserWindowId: 1,
          tabs: [
            {
              title: "A",
              url: "https://a.test/",
              placement: { index: 0, pinned: false },
            },
          ],
        },
      ]),
    );

    expect(migrated).toBe(true);
    expect(set.windows[0]!.tabs[0]!.recordId).toMatch(UUID_RE);
  });

  it("strips the legacy placement.windowId and marks a migration", () => {
    const { set, migrated } = migrateRecoverySet(
      stored([
        {
          groupingId: "g1",
          browserWindowId: 1,
          tabs: [
            {
              recordId: "r1",
              title: "A",
              url: "https://a.test/",
              placement: { index: 3, pinned: true, windowId: 1 },
            },
          ],
        },
      ]),
    );

    expect(migrated).toBe(true);
    expect(set.windows[0]!.tabs[0]!.placement).toEqual({ index: 3, pinned: true });
    expect(set.windows[0]!.tabs[0]!.placement).not.toHaveProperty("windowId");
  });

  it("preserves a missingReason when present and omits the key when absent", () => {
    const { set } = migrateRecoverySet(
      stored([
        {
          groupingId: "g1",
          tabs: [
            {
              recordId: "missing",
              missingReason: "window-closure",
              title: "A",
              url: "https://a.test/",
              placement: { index: 0, pinned: false },
            },
            {
              recordId: "open",
              browserTabId: 5,
              title: "B",
              url: "https://b.test/",
              placement: { index: 1, pinned: false },
            },
          ],
        },
      ]),
    );

    expect(set.windows[0]!.tabs[0]!.missingReason).toBe("window-closure");
    expect(set.windows[0]!.tabs[1]).not.toHaveProperty("missingReason");
  });
});
