import { describe, expect, it } from "vitest";
import {
  FIRST_RUN_EXPLAINER_DISMISSED_KEY,
  parseFirstRunExplainerDismissed,
} from "./preference-state.js";

describe("FIRST_RUN_EXPLAINER_DISMISSED_KEY", () => {
  it("is stored under its own key, separate from the Recovery Set", () => {
    expect(FIRST_RUN_EXPLAINER_DISMISSED_KEY).not.toBe("recoverySet");
  });
});

describe("parseFirstRunExplainerDismissed", () => {
  it("defaults to not dismissed when nothing has been stored", () => {
    expect(parseFirstRunExplainerDismissed(undefined)).toBe(false);
  });

  it("treats any non-true stored value as not dismissed, so a lost or corrupted flag is harmless", () => {
    expect(parseFirstRunExplainerDismissed(null)).toBe(false);
    expect(parseFirstRunExplainerDismissed(false)).toBe(false);
    expect(parseFirstRunExplainerDismissed("true")).toBe(false);
    expect(parseFirstRunExplainerDismissed(1)).toBe(false);
  });

  it("recognizes an explicit dismissal", () => {
    expect(parseFirstRunExplainerDismissed(true)).toBe(true);
  });
});
