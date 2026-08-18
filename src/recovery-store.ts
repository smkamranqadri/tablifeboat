import {
  createDurableId,
  EMPTY_RECOVERY_SET,
  type RecoverySet,
  type TabPlacement,
  type TrackedTab,
  type WindowGrouping,
} from "./recovery-model.js";
import { isWebAddress } from "./web-tab.js";

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

export interface StoredRecoverySet extends Omit<RecoverySet, "windows"> {
  windows: StoredWindowGrouping[];
}

export type ForgetTabResult =
  | { forgotten: true }
  | { forgotten: false; reason: "record-not-found" | "record-is-open" };

export type ForgetWindowGroupingResult =
  | { forgotten: true }
  | {
      forgotten: false;
      reason: "grouping-not-found" | "grouping-has-open-records";
    };

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

  async forgetTab(recordId: string): Promise<ForgetTabResult> {
    let result: ForgetTabResult = {
      forgotten: false,
      reason: "record-not-found",
    };

    await this.update((set) => {
      const groupingIndex = set.windows.findIndex((grouping) =>
        grouping.tabs.some((tab) => tab.recordId === recordId),
      );
      if (groupingIndex === -1) {
        return;
      }

      const grouping = set.windows[groupingIndex]!;
      const tabIndex = grouping.tabs.findIndex((tab) => tab.recordId === recordId);
      const tab = grouping.tabs[tabIndex]!;
      if (tab.browserTabId !== undefined) {
        result = { forgotten: false, reason: "record-is-open" };
        return;
      }

      grouping.tabs.splice(tabIndex, 1);
      if (grouping.tabs.length === 0) {
        set.windows.splice(groupingIndex, 1);
      }
      result = { forgotten: true };
    });

    return result;
  }

  async forgetWindowGrouping(
    groupingId: string,
  ): Promise<ForgetWindowGroupingResult> {
    let result: ForgetWindowGroupingResult = {
      forgotten: false,
      reason: "grouping-not-found",
    };

    await this.update((set) => {
      const groupingIndex = set.windows.findIndex(
        (grouping) => grouping.groupingId === groupingId,
      );
      if (groupingIndex === -1) {
        return;
      }

      const grouping = set.windows[groupingIndex]!;
      if (grouping.tabs.some((tab) => tab.browserTabId !== undefined)) {
        result = { forgotten: false, reason: "grouping-has-open-records" };
        return;
      }

      set.windows.splice(groupingIndex, 1);
      result = { forgotten: true };
    });

    return result;
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

export function migrateRecoverySet(storedSet: StoredRecoverySet | undefined): {
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
  const droppedRecordIds: string[] = [];
  let storedWindows: StoredWindowGrouping[] = [];
  if (Array.isArray(storedSet.windows)) {
    storedWindows = storedSet.windows;
  } else {
    migrated = true;
  }

  const windows = storedWindows.flatMap((window): WindowGrouping[] => {
    let storedTabs: StoredTrackedTab[] = [];
    if (Array.isArray(window?.tabs)) {
      storedTabs = window.tabs;
    } else {
      migrated = true;
    }
    if (!window) {
      return [];
    }

    const groupingId = window.groupingId ?? createDurableId();
    const browserWindowId = window.browserWindowId ?? window.windowId;
    migrated ||=
      window.groupingId === undefined ||
      window.windowId !== undefined;

    const tabs = storedTabs.flatMap((tab): TrackedTab[] => {
      // Stored Recovery Data is the only input this extension does not produce
      // itself, and Manual Recovery hands the address straight to tabs.create.
      if (typeof tab?.url !== "string" || !isWebAddress(tab.url)) {
        migrated = true;
        droppedRecordIds.push(String(tab?.recordId ?? "<no recordId>"));
        return [];
      }

      const storedIndex = Number(tab.placement?.index);
      const hasIndex = Number.isFinite(storedIndex);
      let index = 0;
      if (hasIndex) {
        index = storedIndex;
      }
      let title = tab.url;
      if (typeof tab.title === "string") {
        title = tab.title;
      }
      // A record carrying a non-numeric browserTabId would read as open for
      // good: never restorable, and forgetTab refuses it as record-is-open.
      let browserTabId: number | undefined;
      if (typeof tab.browserTabId === "number" && Number.isInteger(tab.browserTabId)) {
        browserTabId = tab.browserTabId;
      }
      const hasBrowserTabId =
        tab.browserTabId === undefined || browserTabId !== undefined;
      const hasMissingReason =
        tab.missingReason === undefined ||
        tab.missingReason === "startup" ||
        tab.missingReason === "window-closure";
      migrated ||=
        typeof tab.recordId !== "string" ||
        tab.placement?.windowId !== undefined ||
        !hasIndex ||
        !hasBrowserTabId ||
        !hasMissingReason ||
        typeof tab.placement?.pinned !== "boolean" ||
        typeof tab.title !== "string";

      let recordId = createDurableId();
      if (typeof tab.recordId === "string") {
        recordId = tab.recordId;
      }

      return [
        {
          recordId,
          browserTabId,
          ...(hasMissingReason && tab.missingReason !== undefined
            ? { missingReason: tab.missingReason }
            : {}),
          title,
          url: tab.url,
          placement: { index, pinned: tab.placement?.pinned === true },
        },
      ];
    });

    return [{ groupingId, browserWindowId, tabs }];
  });

  if (droppedRecordIds.length > 0) {
    console.warn(
      `Dropped ${droppedRecordIds.length} stored record(s) outside the Web Tab boundary`,
      droppedRecordIds,
    );
  }

  return {
    set: { version: 1, windows },
    migrated,
  };
}
