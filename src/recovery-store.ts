import {
  createDurableId,
  EMPTY_RECOVERY_SET,
  type RecoverySet,
  type TabPlacement,
  type TrackedTab,
  type WindowGrouping,
} from "./recovery-model.js";

interface StoredTabPlacement extends TabPlacement {
  windowId?: number;
}

interface StoredTrackedTab extends Omit<TrackedTab, "recordId" | "placement"> {
  recordId?: string;
  placement: StoredTabPlacement;
}

interface StoredWindowGrouping
  extends Omit<WindowGrouping, "groupingId" | "browserWindowId" | "tabs"> {
  groupingId?: string;
  browserWindowId?: number;
  windowId?: number;
  tabs: StoredTrackedTab[];
}

interface StoredRecoverySet extends Omit<RecoverySet, "windows"> {
  windows: StoredWindowGrouping[];
}

export class RecoveryStore {
  private pendingOperation: Promise<void> = Promise.resolve();

  read(): Promise<RecoverySet> {
    return this.serialize(async () => {
      const { recoverySet } = (await chrome.storage.local.get("recoverySet")) as {
        recoverySet?: StoredRecoverySet;
      };
      const { set, migrated } = migrateRecoverySet(recoverySet);

      if (migrated) {
        await chrome.storage.local.set({ recoverySet: set });
      }

      return set;
    });
  }

  update(mutator: (set: RecoverySet) => void | Promise<void>): Promise<RecoverySet> {
    return this.serialize(async () => {
      const { recoverySet } = (await chrome.storage.local.get("recoverySet")) as {
        recoverySet?: StoredRecoverySet;
      };
      const { set } = migrateRecoverySet(recoverySet);
      await mutator(set);
      await chrome.storage.local.set({ recoverySet: set });
      return set;
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingOperation.then(operation, operation);
    this.pendingOperation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function migrateRecoverySet(storedSet: StoredRecoverySet | undefined): {
  set: RecoverySet;
  migrated: boolean;
} {
  if (!storedSet) {
    return {
      set: structuredClone(EMPTY_RECOVERY_SET),
      migrated: false,
    };
  }

  let migrated = false;
  const windows = storedSet.windows.map((window): WindowGrouping => {
    const groupingId = window.groupingId ?? createDurableId();
    const browserWindowId = window.browserWindowId ?? window.windowId;
    migrated ||=
      window.groupingId === undefined ||
      window.windowId !== undefined;

    return {
      groupingId,
      browserWindowId,
      tabs: window.tabs.map((tab): TrackedTab => {
        const recordId = tab.recordId ?? createDurableId();
        migrated ||= tab.recordId === undefined || tab.placement.windowId !== undefined;
        return {
          recordId,
          browserTabId: tab.browserTabId,
          title: tab.title,
          url: tab.url,
          placement: {
            index: tab.placement.index,
            pinned: tab.placement.pinned,
          },
        };
      }),
    };
  });

  return {
    set: { ...storedSet, windows },
    migrated,
  };
}
