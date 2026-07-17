import type { Worker } from "@playwright/test";

export interface TrackedTab {
  recordId: string;
  browserTabId?: number;
  title: string;
  url: string;
  placement: {
    windowId: number;
    index: number;
    pinned: boolean;
  };
}

export interface WindowGrouping {
  groupingId: string;
  windowId: number;
  tabs: TrackedTab[];
}

export interface RecoverySet {
  version: 1;
  windows: WindowGrouping[];
}

export async function readRecoverySet(serviceWorker: Worker): Promise<RecoverySet | undefined> {
  return serviceWorker.evaluate(async () => {
    const { recoverySet } = (await chrome.storage.local.get("recoverySet")) as {
      recoverySet?: RecoverySet;
    };
    return recoverySet;
  });
}
