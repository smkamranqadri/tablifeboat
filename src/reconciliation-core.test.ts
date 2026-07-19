import { describe, expect, it } from "vitest";
import type {
  RecoverySet,
  TrackedTab,
  WindowGrouping,
} from "./recovery-model.js";
import {
  countAddressOccurrenceOverlap,
  findGloballyOptimalAssignment,
  matchTrackedTabsToOpenTabs,
  maximizeSquareAssignment,
  reconcileWindows,
  removeNativeRestorationDuplicates,
} from "./reconciliation-core.js";
import { makeTab } from "./test-support.js";

const A = "https://a.test/";
const B = "https://b.test/";
const C = "https://c.test/";
const D = "https://d.test/";
const Z = "https://z.test/";

type OpenWebTab = chrome.tabs.Tab & { id: number; url: string };

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

function grouping(
  groupingId: string,
  tabs: TrackedTab[],
  extra: Partial<WindowGrouping> = {},
): WindowGrouping {
  return { groupingId, tabs, ...extra };
}

function recoverySet(windows: WindowGrouping[]): RecoverySet {
  return { version: 1, windows };
}

function openTab(
  id: number,
  url: string,
  overrides: Partial<chrome.tabs.Tab> = {},
): OpenWebTab {
  return { ...makeTab({ id, url, ...overrides }), id, url };
}

function openGrouping(
  browserWindowId: number,
  tabs: OpenWebTab[],
): { browserWindowId: number; tabs: OpenWebTab[] } {
  return { browserWindowId, tabs };
}

describe("maximizeSquareAssignment", () => {
  it("keeps the best pairing on the diagonal", () => {
    expect(maximizeSquareAssignment([[5, 1], [1, 5]])).toEqual([0, 1]);
  });

  it("swaps to the higher-weight off-diagonal pairing", () => {
    expect(maximizeSquareAssignment([[1, 5], [5, 1]])).toEqual([1, 0]);
  });

  it("beats a greedy single-cell choice", () => {
    // Greedy grabs the lone 4 at (0,0) and is forced into (1,1)=1 -> total 5.
    // The optimal assignment is (0,1)=3 + (1,0)=3 -> total 6.
    expect(maximizeSquareAssignment([[4, 3], [3, 1]])).toEqual([1, 0]);
  });

  it("breaks genuine ties toward stable row/column order", () => {
    expect(maximizeSquareAssignment([[2, 2], [2, 2]])).toEqual([0, 1]);
    expect(
      maximizeSquareAssignment([
        [3, 0, 0],
        [0, 3, 0],
        [0, 0, 3],
      ]),
    ).toEqual([0, 1, 2]);
  });
});

describe("findGloballyOptimalAssignment", () => {
  it("returns nothing for empty inputs", () => {
    expect(findGloballyOptimalAssignment([], [])).toEqual([]);
  });

  it("pairs each expected window with its overlapping open window", () => {
    const expected = [
      grouping("g0", [tracked("r0a", A), tracked("r0b", B)]),
      grouping("g1", [tracked("r1c", C), tracked("r1d", D)]),
    ];
    const open = [
      openGrouping(10, [openTab(1, C), openTab(2, D)]),
      openGrouping(11, [openTab(3, A), openTab(4, B)]),
    ];

    expect(findGloballyOptimalAssignment(expected, open)).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("drops padded pairings when window counts differ", () => {
    const expected = [
      grouping("g0", [tracked("r0", A)]),
      grouping("g1", [tracked("r1", B)]),
    ];
    const open = [openGrouping(10, [openTab(1, B)])];

    expect(findGloballyOptimalAssignment(expected, open)).toEqual([[1, 0]]);
  });

  it("keeps stable order when every pairing overlaps equally", () => {
    const expected = [
      grouping("g0", [tracked("r0", A)]),
      grouping("g1", [tracked("r1", A)]),
    ];
    const open = [
      openGrouping(10, [openTab(1, A)]),
      openGrouping(11, [openTab(2, A)]),
    ];

    expect(findGloballyOptimalAssignment(expected, open)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("countAddressOccurrenceOverlap", () => {
  it("counts duplicate urls by occurrence, not presence", () => {
    expect(
      countAddressOccurrenceOverlap(
        [tracked("r0", A), tracked("r1", A)],
        [openTab(1, A), openTab(2, A)],
      ),
    ).toBe(2);
  });

  it("is bounded by the smaller occurrence count", () => {
    expect(
      countAddressOccurrenceOverlap(
        [tracked("r0", A), tracked("r1", A)],
        [openTab(1, A)],
      ),
    ).toBe(1);
  });

  it("counts only the shared urls on partial overlap", () => {
    expect(
      countAddressOccurrenceOverlap(
        [tracked("r0", A), tracked("r1", B), tracked("r2", C)],
        [openTab(1, B), openTab(2, C), openTab(3, D)],
      ),
    ).toBe(2);
  });

  it("is zero with no shared urls", () => {
    expect(
      countAddressOccurrenceOverlap([tracked("r0", A)], [openTab(1, B)]),
    ).toBe(0);
  });
});

describe("matchTrackedTabsToOpenTabs", () => {
  it("pairs tracked tabs to open tabs in order, consuming each occurrence", () => {
    const matches = matchTrackedTabsToOpenTabs(
      [tracked("r0", A), tracked("r1", A), tracked("r2", B)],
      [openTab(1, A), openTab(2, A), openTab(3, B)],
    );

    expect(matches.map(([tab]) => tab.recordId)).toEqual(["r0", "r1", "r2"]);
    expect(matches.map(([, open]) => open.id)).toEqual([1, 2, 3]);
  });

  it("skips tracked tabs with no matching open tab", () => {
    const matches = matchTrackedTabsToOpenTabs(
      [tracked("r0", A), tracked("r1", Z)],
      [openTab(1, A)],
    );

    expect(matches).toHaveLength(1);
    expect(matches[0]![0].recordId).toBe("r0");
    expect(matches[0]![1].id).toBe(1);
  });
});

describe("removeNativeRestorationDuplicates", () => {
  it("collapses a natively-restored duplicate of a tracked tab", () => {
    const workerStart = recoverySet([
      grouping("g0", [tracked("r1", A)]),
    ]);
    const current = recoverySet([
      grouping("g0", [
        tracked("r1", A),
        tracked("r2", A, { browserTabId: 100 }),
      ]),
    ]);

    removeNativeRestorationDuplicates(current, workerStart, [
      openTab(100, A, { windowId: 5 }),
    ]);

    expect(current.windows[0]!.tabs.map((tab) => tab.recordId)).toEqual(["r1"]);
  });

  it("preserves a genuinely new tab that is not a restoration duplicate", () => {
    const workerStart = recoverySet([grouping("g0", [tracked("r1", A)])]);
    const current = recoverySet([
      grouping("g0", [
        tracked("r1", A),
        tracked("r2", A, { browserTabId: 100 }),
        tracked("rz", Z, { browserTabId: 200 }),
      ]),
    ]);

    removeNativeRestorationDuplicates(current, workerStart, [
      openTab(100, A, { windowId: 5 }),
      openTab(200, Z, { windowId: 5 }),
    ]);

    expect(current.windows[0]!.tabs.map((tab) => tab.recordId)).toEqual([
      "r1",
      "rz",
    ]);
  });
});

describe("reconcileWindows", () => {
  it("associates a live tab and clears its missing reason", () => {
    const set = recoverySet([
      grouping("g0", [tracked("r1", A, { missingReason: "startup" })]),
    ]);

    reconcileWindows(set, [
      openTab(100, A, {
        windowId: 5,
        index: 3,
        title: "A Title",
        pinned: true,
      }),
    ]);

    const tab = set.windows[0]!.tabs[0]!;
    expect(tab.browserTabId).toBe(100);
    expect(tab.missingReason).toBeUndefined();
    expect(tab.title).toBe("A Title");
    expect(tab.placement).toEqual({ index: 3, pinned: true });
    expect(set.windows[0]!.browserWindowId).toBe(5);
  });

  it("marks a previously-live, now-absent tab as startup-missing", () => {
    const set = recoverySet([
      grouping("g0", [tracked("r1", A, { browserTabId: 100 })], {
        browserWindowId: 5,
      }),
    ]);

    reconcileWindows(set, []);

    const tab = set.windows[0]!.tabs[0]!;
    expect(tab.browserTabId).toBeUndefined();
    expect(tab.missingReason).toBe("startup");
  });

  it("never relabels a window-closure tab as startup", () => {
    const set = recoverySet([
      grouping("g0", [tracked("r1", A, { missingReason: "window-closure" })]),
    ]);

    reconcileWindows(set, []);

    expect(set.windows[0]!.tabs[0]!.missingReason).toBe("window-closure");
  });

  it("does not dedup restorations without a worker-start snapshot", () => {
    const set = recoverySet([
      grouping("g0", [tracked("r1", A), tracked("r2", A)]),
    ]);

    reconcileWindows(set, [openTab(100, A, { windowId: 5 })]);

    const tabs = set.windows[0]!.tabs;
    expect(tabs.map((tab) => tab.recordId)).toEqual(["r1", "r2"]);
    expect(tabs[0]!.browserTabId).toBe(100);
    expect(tabs[1]!.browserTabId).toBeUndefined();
  });
});
