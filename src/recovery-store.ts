import {
  createDurableId,
  EMPTY_RECOVERY_SET,
  type RecoverySet,
  type TrackedTab,
  type WindowGrouping,
} from "./recovery-model.js";

interface StoredTrackedTab extends Omit<TrackedTab, "recordId"> {
  recordId?: string;
}

interface StoredWindowGrouping extends Omit<WindowGrouping, "groupingId" | "tabs"> {
  groupingId?: string;
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
    migrated ||= window.groupingId === undefined;

    return {
      ...window,
      groupingId,
      tabs: window.tabs.map((tab): TrackedTab => {
        const recordId = tab.recordId ?? createDurableId();
        migrated ||= tab.recordId === undefined;
        return { ...tab, recordId };
      }),
    };
  });

  return {
    set: { ...storedSet, windows },
    migrated,
  };
}
