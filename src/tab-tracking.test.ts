import { describe, expect, it } from "vitest";
import type { TrackedTab, WindowGrouping } from "./recovery-model.js";
import { findAdoptableTrackedTab } from "./tab-tracking.js";
import { makeTab } from "./test-support.js";

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

function grouping(tabs: TrackedTab[]): WindowGrouping {
  return { groupingId: "g0", browserWindowId: 1, tabs };
}

function webTab(id: number, url: string) {
  return { ...makeTab({ id, url }), id, url };
}

describe("findAdoptableTrackedTab", () => {
  it("adopts the record whose browser tab id the browser has retired", () => {
    const replaced = webTab(200, A);
    const candidates = grouping([tracked("original", A, { browserTabId: 100 })]);

    expect(
      findAdoptableTrackedTab(candidates, replaced, [replaced])?.recordId,
    ).toBe("original");
  });

  it("adopts a startup-missing record at the same address", () => {
    const opened = webTab(200, A);
    const candidates = grouping([
      tracked("orphan", A, { missingReason: "startup" }),
    ]);

    expect(
      findAdoptableTrackedTab(candidates, opened, [opened])?.recordId,
    ).toBe("orphan");
  });

  it("leaves a record whose own tab is still open alone", () => {
    const original = webTab(100, A);
    const duplicate = webTab(200, A);
    const candidates = grouping([tracked("original", A, { browserTabId: 100 })]);

    expect(
      findAdoptableTrackedTab(candidates, duplicate, [original, duplicate]),
    ).toBeUndefined();
  });

  it("never adopts a window-closure record", () => {
    const opened = webTab(200, A);
    const candidates = grouping([
      tracked("closed", A, { missingReason: "window-closure" }),
    ]);

    expect(
      findAdoptableTrackedTab(candidates, opened, [opened]),
    ).toBeUndefined();
  });

  it("adopts across a fragment the page rewrote after tracking", () => {
    const opened = webTab(200, `${A}doc#heading=later`);
    const candidates = grouping([
      tracked("original", `${A}doc#heading=earlier`, { browserTabId: 100 }),
    ]);

    expect(
      findAdoptableTrackedTab(candidates, opened, [opened])?.recordId,
    ).toBe("original");
  });

  it("requires a matching address beyond the fragment", () => {
    const opened = webTab(200, B);
    const candidates = grouping([tracked("orphan", A, { missingReason: "startup" })]);

    expect(
      findAdoptableTrackedTab(candidates, opened, [opened]),
    ).toBeUndefined();
  });
});
