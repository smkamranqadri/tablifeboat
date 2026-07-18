export interface TrackedTabSummary {
  recordId: string;
  title: string;
  url: string;
}

export interface WindowGroupingSummary {
  groupingId: string;
  tabs: TrackedTabSummary[];
  entirelyMissing: boolean;
}

export interface RecoverySummary {
  protectedTabCount: number;
  missingTabCount: number;
  missingWindowGroupings: WindowGroupingSummary[];
}

export interface RestoreResult {
  restoredRecordIds: string[];
  failedRecordIds: string[];
}

export interface ForgetResult {
  forgotten: boolean;
  reason?: string;
}

export type RecoveryNotice =
  | { scope: "summary"; message: string }
  | { scope: "grouping"; groupingId: string; message: string }
  | { scope: "tab"; recordId: string; message: string };

export interface PopupActions {
  restoreAll(): Promise<RestoreResult>;
  restoreWindow(groupingId: string): Promise<RestoreResult>;
  restoreTab(recordId: string): Promise<RestoreResult>;
  forgetWindow(groupingId: string): Promise<ForgetResult>;
  forgetTab(recordId: string): Promise<ForgetResult>;
  refresh(notice?: RecoveryNotice): Promise<void>;
}

function requiredElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function renderProtectedCount(count: number): HTMLParagraphElement {
  const paragraph = requiredElement("p", "protected-count");
  paragraph.id = "protected-count";
  paragraph.textContent = `${count} open protected ${count === 1 ? "tab" : "tabs"}`;
  return paragraph;
}

async function sendForgetRequest(request: () => Promise<ForgetResult>, actions: PopupActions): Promise<void> {
  const result = await request();
  if (!result.forgotten) {
    throw new Error(`Recovery Data was not forgotten: ${result.reason ?? "unknown"}`);
  }
  await actions.refresh();
}

function renderLegacyWindowGrouping(
  grouping: WindowGroupingSummary,
  actions: PopupActions,
): HTMLElement {
  const section = requiredElement("section", "missing-window-grouping");
  section.setAttribute("aria-label", "Missing Window Grouping");

  const heading = requiredElement("h2");
  heading.textContent = "Missing Window Grouping";
  section.append(heading);

  const list = requiredElement("ul");
  for (const tab of grouping.tabs) {
    const item = requiredElement("li");
    const tabDetails = requiredElement("span", "tab-details");
    const link = requiredElement("a");
    link.href = tab.url;
    link.textContent = tab.title;
    link.title = tab.url;
    tabDetails.append(link);

    const tabActions = requiredElement("div", "tab-actions");

    const restoreTabButton = requiredElement("button", "restore-tab");
    restoreTabButton.type = "button";
    restoreTabButton.textContent = "Restore Tab";
    restoreTabButton.setAttribute("aria-label", `Restore Tab: ${tab.title}`);
    restoreTabButton.addEventListener("click", async () => {
      restoreTabButton.disabled = true;
      try {
        const result = await actions.restoreTab(tab.recordId);
        if (!result.restoredRecordIds.includes(tab.recordId)) {
          throw new Error("Missing Tab was not restored");
        }
        await actions.refresh();
      } catch (error: unknown) {
        restoreTabButton.disabled = false;
        console.error("Failed to restore Missing Tab", error);
      }
    });

    const forgetTabButton = requiredElement("button", "forget-tab");
    forgetTabButton.type = "button";
    forgetTabButton.textContent = "Forget Tab";
    forgetTabButton.setAttribute("aria-label", `Forget Tab: ${tab.title}`);
    forgetTabButton.addEventListener("click", async () => {
      forgetTabButton.disabled = true;
      try {
        await sendForgetRequest(() => actions.forgetTab(tab.recordId), actions);
      } catch (error: unknown) {
        forgetTabButton.disabled = false;
        console.error("Failed to forget Missing Tab", error);
      }
    });

    tabActions.append(restoreTabButton, forgetTabButton);
    item.append(tabDetails, tabActions);
    list.append(item);
  }
  section.append(list);

  const windowActions = requiredElement("div", "window-actions");

  const restoreButton = requiredElement("button", "restore-window");
  restoreButton.type = "button";
  restoreButton.dataset.groupingId = grouping.groupingId;
  restoreButton.textContent = "Restore Window";
  restoreButton.setAttribute("aria-label", "Restore Window Grouping");
  restoreButton.addEventListener("click", async () => {
    restoreButton.disabled = true;
    try {
      await actions.restoreWindow(grouping.groupingId);
      await actions.refresh();
    } catch (error: unknown) {
      restoreButton.disabled = false;
      console.error("Failed to restore Window Grouping", error);
    }
  });
  windowActions.append(restoreButton);

  if (grouping.entirelyMissing) {
    const forgetWindowButton = requiredElement("button", "forget-window");
    forgetWindowButton.type = "button";
    forgetWindowButton.textContent = "Forget Window";
    forgetWindowButton.setAttribute("aria-label", "Forget Window Grouping");
    forgetWindowButton.addEventListener("click", async () => {
      if (!window.confirm("Permanently forget this Window Grouping and all of its tabs?")) {
        return;
      }

      forgetWindowButton.disabled = true;
      try {
        await sendForgetRequest(() => actions.forgetWindow(grouping.groupingId), actions);
      } catch (error: unknown) {
        forgetWindowButton.disabled = false;
        console.error("Failed to forget Window Grouping", error);
      }
    });
    windowActions.append(forgetWindowButton);
  }
  section.append(windowActions);
  return section;
}

export function renderRecoveryPopup(
  root: HTMLElement,
  summary: RecoverySummary,
  actions: PopupActions,
  notice?: RecoveryNotice,
): void {
  const protectedCount = document.querySelector<HTMLParagraphElement>("#protected-count");
  if (protectedCount) {
    const noun = summary.protectedTabCount === 1 ? "tab" : "tabs";
    protectedCount.textContent = `${summary.protectedTabCount} open protected ${noun}`;
  }

  const restoreAll = requiredElement("button");
  restoreAll.id = "restore-all";
  restoreAll.type = "button";
  restoreAll.textContent = "Restore All";
  restoreAll.hidden = summary.missingWindowGroupings.length === 0;
  restoreAll.addEventListener("click", async () => {
    restoreAll.disabled = true;
    try {
      await actions.restoreAll();
      await actions.refresh();
    } catch (error: unknown) {
      console.error("Failed to restore all Missing Tabs", error);
    } finally {
      restoreAll.disabled = false;
    }
  });

  const groupings = requiredElement("div");
  groupings.id = "missing-window-groupings";
  groupings.setAttribute("aria-live", "polite");
  for (const grouping of summary.missingWindowGroupings) {
    groupings.append(renderLegacyWindowGrouping(grouping, actions));
  }
  root.replaceChildren(restoreAll, groupings);
  void notice;
}
