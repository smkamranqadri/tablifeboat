import { describe, expect, it } from "vitest";
import { makeTab } from "./test-support.js";
import { comparableAddress, isWebTab, webTabAddress } from "./web-tab.js";

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

describe("webTabAddress", () => {
  it("returns the committed url of a web tab", () => {
    expect(webTabAddress(makeTab({ id: 1, url: "https://example.com/" }))).toBe(
      "https://example.com/",
    );
  });

  it("falls back to a pending web url while the tab is still loading", () => {
    expect(
      webTabAddress(makeTab({ id: 1, pendingUrl: "https://example.com/" })),
    ).toBe("https://example.com/");
    expect(
      webTabAddress(
        makeTab({ id: 1, url: "", pendingUrl: "https://example.com/" }),
      ),
    ).toBe("https://example.com/");
  });

  it("prefers the committed url over a pending navigation", () => {
    expect(
      webTabAddress(
        makeTab({
          id: 1,
          url: "https://committed.test/",
          pendingUrl: "https://pending.test/",
        }),
      ),
    ).toBe("https://committed.test/");
  });

  it("returns undefined for incognito tabs and tabs without an id", () => {
    expect(
      webTabAddress(
        makeTab({ id: 1, url: "https://example.com/", incognito: true }),
      ),
    ).toBeUndefined();
    expect(webTabAddress(makeTab({ url: "https://example.com/" }))).toBeUndefined();
  });

  it("returns undefined when neither url nor pending url is a web address", () => {
    expect(
      webTabAddress(
        makeTab({ id: 1, url: "chrome://extensions/", pendingUrl: "about:blank" }),
      ),
    ).toBeUndefined();
    expect(webTabAddress(makeTab({ id: 1 }))).toBeUndefined();
  });
});

describe("comparableAddress", () => {
  it("drops the fragment", () => {
    expect(comparableAddress("https://a.test/doc?tab=t.0#heading=h.x")).toBe(
      "https://a.test/doc?tab=t.0",
    );
  });

  it("keeps the query, which does identify a different resource", () => {
    expect(comparableAddress("https://a.test/doc?tab=t.1")).not.toBe(
      comparableAddress("https://a.test/doc?tab=t.0"),
    );
  });

  it("returns an unparseable address unchanged", () => {
    expect(comparableAddress("not a url")).toBe("not a url");
  });
});
