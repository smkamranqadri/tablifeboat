export function isWebTab(tab: chrome.tabs.Tab): tab is chrome.tabs.Tab & {
  id: number;
  url: string;
} {
  if (tab.incognito || tab.id === undefined || tab.url === undefined) {
    return false;
  }

  return isWebAddress(tab.url);
}

export function webTabAddress(tab: chrome.tabs.Tab): string | undefined {
  if (tab.incognito || tab.id === undefined) {
    return undefined;
  }

  if (tab.url !== undefined && isWebAddress(tab.url)) {
    return tab.url;
  }
  if (tab.pendingUrl !== undefined && isWebAddress(tab.pendingUrl)) {
    return tab.pendingUrl;
  }
  return undefined;
}

export function isWebAddress(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

// A fragment addresses a secondary part of a resource, never a different one,
// and pages like Google Docs rewrite theirs as a person scrolls. Matching a
// Tracked Tab to its own tab has to survive that drift.
export function comparableAddress(url: string): string {
  try {
    const address = new URL(url);
    address.hash = "";
    return address.href;
  } catch {
    return url;
  }
}
