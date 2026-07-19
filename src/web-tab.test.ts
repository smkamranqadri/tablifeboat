import { describe, expect, it } from "vitest";
import { makeTab } from "./test-support.js";
import { isWebTab } from "./web-tab.js";

describe("isWebTab", () => {
  it("accepts http and https tabs with an id and url", () => {
    expect(isWebTab(makeTab({ id: 1, url: "http://example.com/" }))).toBe(true);
    expect(isWebTab(makeTab({ id: 2, url: "https://example.com/path" }))).toBe(
      true,
    );
  });

  it("rejects incognito tabs", () => {
    expect(
      isWebTab(makeTab({ id: 1, url: "https://example.com/", incognito: true })),
    ).toBe(false);
  });

  it("rejects tabs missing an id or url", () => {
    expect(isWebTab(makeTab({ url: "https://example.com/" }))).toBe(false);
    expect(isWebTab(makeTab({ id: 1 }))).toBe(false);
  });

  it("rejects non-web protocols", () => {
    expect(isWebTab(makeTab({ id: 1, url: "chrome://extensions/" }))).toBe(false);
    expect(isWebTab(makeTab({ id: 1, url: "file:///tmp/page.html" }))).toBe(
      false,
    );
    expect(isWebTab(makeTab({ id: 1, url: "ftp://example.com/" }))).toBe(false);
  });

  it("rejects unparseable urls", () => {
    expect(isWebTab(makeTab({ id: 1, url: "not a url" }))).toBe(false);
  });
});
