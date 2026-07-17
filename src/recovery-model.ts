export interface TabPlacement {
  windowId: number;
  index: number;
  pinned: boolean;
}

export interface TrackedTab {
  recordId: string;
  browserTabId?: number;
  title: string;
  url: string;
  placement: TabPlacement;
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

export const EMPTY_RECOVERY_SET: RecoverySet = {
  version: 1,
  windows: [],
};

export function createDurableId(): string {
  return crypto.randomUUID();
}
