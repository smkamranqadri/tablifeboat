import { describe, expect, it } from "vitest";
import type { RecoverySet, TrackedTab } from "./recovery-model.js";
import { removeStartupMissingBacklog } from "./recovery-data-repair.js";

const A = "https://a.test/";
const B = "https://b.test/";

function tracked(
  recordId: string,
  url: string,
  extra: Partial<TrackedTab> = {},
): TrackedTab {
  return {
    recordId,
    title: url,
    url,
    placement: { index: 0, pinned: false },
    ...extra,
  };
}

function recoverySet(tabs: TrackedTab[]): RecoverySet {
  return { version: 1, windows: [{ groupingId: "g0", tabs }] };
}

describe("removeStartupMissingBacklog", () => {
  it("clears every startup-missing record", () => {
    const set = recoverySet([
      tracked("live", A, { browserTabId: 100 }),
      tracked("orphan", A, { missingReason: "startup" }),
      tracked("stale", B, { missingReason: "startup" }),
    ]);

    expect(removeStartupMissingBacklog(set)).toBe(2);
    expect(set.windows[0]!.tabs.map((tab) => tab.recordId)).toEqual(["live"]);
  });

  it("keeps window-closure records", () => {
    const set = recoverySet([
      tracked("closed", A, { missingReason: "window-closure" }),
      tracked("orphan", B, { missingReason: "startup" }),
    ]);

    expect(removeStartupMissingBacklog(set)).toBe(1);
    expect(set.windows[0]!.tabs.map((tab) => tab.recordId)).toEqual(["closed"]);
  });

  it("keeps a missing record carrying no reason at all", () => {
    const set = recoverySet([tracked("unlabelled", A)]);

    expect(removeStartupMissingBacklog(set)).toBe(0);
    expect(set.windows[0]!.tabs).toHaveLength(1);
  });

  it("drops a Window Grouping the repair empties", () => {
    const set: RecoverySet = {
      version: 1,
      windows: [
        { groupingId: "g0", tabs: [tracked("live", A, { browserTabId: 100 })] },
        {
          groupingId: "g1",
          tabs: [tracked("orphan", B, { missingReason: "startup" })],
        },
      ],
    };

    expect(removeStartupMissingBacklog(set)).toBe(1);
    expect(set.windows.map((grouping) => grouping.groupingId)).toEqual(["g0"]);
  });

  it("reports nothing removed from clean Recovery Data", () => {
    const set = recoverySet([tracked("live", A, { browserTabId: 100 })]);

    expect(removeStartupMissingBacklog(set)).toBe(0);
  });
});
