export interface TabPlacement {
  index: number;
  pinned: boolean;
}

export type MissingReason = "startup" | "window-closure";

export interface TrackedTab {
  recordId: string;
  browserTabId?: number;
  missingReason?: MissingReason;
  title: string;
  url: string;
  placement: TabPlacement;
}

export interface WindowGrouping {
  groupingId: string;
  browserWindowId?: number;
  tabs: TrackedTab[];
}

export interface RecoverySet {
  version: 1;
  windows: WindowGrouping[];
}

export const EMPTY_RECOVERY_SET: RecoverySet = {
  version: 1,
  windows: [],
};

export function createDurableId(): string {
  return crypto.randomUUID();
}
