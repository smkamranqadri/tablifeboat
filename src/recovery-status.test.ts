import { describe, expect, it } from "vitest";
import type {
  MissingReason,
  RecoverySet,
  TrackedTab,
  WindowGrouping,
} from "./recovery-model.js";
import { getRecoveryStatus, hasStartupMissingTabs } from "./recovery-status.js";

let nextRecordId = 0;

function tracked(overrides: Partial<TrackedTab> = {}): TrackedTab {
  nextRecordId += 1;
  return {
    recordId: `r${nextRecordId}`,
    title: "Tab",
    url: "https://example.com/",
    placement: { index: 0, pinned: false },
    ...overrides,
  };
}

function live(overrides: Partial<TrackedTab> = {}): TrackedTab {
  return tracked({ browserTabId: 100 + nextRecordId, ...overrides });
}

function missing(
  reason: MissingReason,
  overrides: Partial<TrackedTab> = {},
): TrackedTab {
  return tracked({ missingReason: reason, ...overrides });
}

function grouping(tabs: TrackedTab[]): WindowGrouping {
  return { groupingId: `g${tabs.map((tab) => tab.recordId).join("-")}`, tabs };
}

function set(windows: WindowGrouping[]): RecoverySet {
  return { version: 1, windows };
}

describe("getRecoveryStatus", () => {
  it("counts protected and missing tabs across windows", () => {
    const status = getRecoveryStatus(
      set([
        grouping([live(), live(), missing("startup")]),
        grouping([live()]),
      ]),
    );

    expect(status.protectedTabCount).toBe(3);
    expect(status.missingTabCount).toBe(1);
  });

  it("reports a partially missing window as not entirely missing", () => {
    const status = getRecoveryStatus(
      set([grouping([live(), missing("startup")])]),
    );

    expect(status.missingWindowGroupings).toHaveLength(1);
    expect(status.missingWindowGroupings[0]!.entirelyMissing).toBe(false);
    expect(status.missingWindowGroupings[0]!.tabs).toHaveLength(1);
  });

  it("flags a window with only missing tabs as entirely missing", () => {
    const status = getRecoveryStatus(
      set([grouping([missing("window-closure"), missing("window-closure")])]),
    );

    expect(status.missingWindowGroupings[0]!.entirelyMissing).toBe(true);
  });

  it("omits fully live windows from the missing groupings", () => {
    const status = getRecoveryStatus(set([grouping([live(), live()])]));

    expect(status.missingWindowGroupings).toEqual([]);
    expect(status.missingTabCount).toBe(0);
  });

  it("returns zeroed status for an empty set", () => {
    expect(getRecoveryStatus(set([]))).toEqual({
      protectedTabCount: 0,
      missingTabCount: 0,
      missingWindowGroupings: [],
    });
  });
});

describe("hasStartupMissingTabs", () => {
  it("is true when a missing tab is flagged as startup", () => {
    expect(
      hasStartupMissingTabs(set([grouping([live(), missing("startup")])])),
    ).toBe(true);
  });

  it("is false when the only missing tabs are window-closure", () => {
    expect(
      hasStartupMissingTabs(set([grouping([missing("window-closure")])])),
    ).toBe(false);
  });

  it("is false when nothing is missing", () => {
    expect(hasStartupMissingTabs(set([grouping([live()])]))).toBe(false);
  });
});
