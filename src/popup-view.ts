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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function renderEmptyState(): HTMLElement {
  const section = requiredElement("section", "empty-state");
  const heading = requiredElement("h2");
  heading.textContent = "All tabs are available";
  const copy = requiredElement("p");
  copy.textContent = "Nothing needs recovery right now.";
  section.append(heading, copy);
  return section;
}

function renderSummary(summary: RecoverySummary, actions: PopupActions): HTMLElement {
  const section = requiredElement("section", "recovery-summary");
  const text = requiredElement("div", "recovery-summary-copy");
  const missingTabs = requiredElement("strong");
  missingTabs.textContent = `${summary.missingTabCount} ${plural(summary.missingTabCount, "tab")} missing`;
  const windows = requiredElement("span");
  windows.textContent = `${summary.missingWindowGroupings.length} missing ${plural(summary.missingWindowGroupings.length, "window")}`;
  text.append(missingTabs, windows);

  const restoreAll = requiredElement("button", "button button-primary");
  restoreAll.type = "button";
  restoreAll.textContent = "Restore All";
  restoreAll.addEventListener("click", async () => {
    restoreAll.disabled = true;
    try {
      await actions.restoreAll();
      await actions.refresh();
    } catch (error: unknown) {
      restoreAll.disabled = false;
      console.error("Failed to restore all Missing Tabs", error);
    }
  });
  section.append(text, restoreAll);
  return section;
}

async function sendForgetRequest(request: () => Promise<ForgetResult>, actions: PopupActions): Promise<void> {
  const result = await request();
  if (!result.forgotten) {
    throw new Error(`Recovery Data was not forgotten: ${result.reason ?? "unknown"}`);
  }
  await actions.refresh();
}

function renderWindowGrouping(
  grouping: WindowGroupingSummary,
  index: number,
  actions: PopupActions,
): HTMLElement {
  const section = requiredElement("section", "missing-window-grouping");
  section.setAttribute("aria-label", "Missing Window Grouping");

  const header = requiredElement("div", "window-header");
  const heading = requiredElement("h2");
  heading.textContent = `Window ${index + 1}`;
  heading.setAttribute("aria-label", "Missing Window Grouping");
  header.append(heading);
  section.append(header);

  for (const tab of grouping.tabs) {
    const row = requiredElement("div", "tab-row");
    const tabCopy = requiredElement("div", "tab-copy");
    const link = requiredElement("a", "tab-title");
    link.href = tab.url;
    link.title = tab.url;
    link.textContent = tab.title;
    const host = requiredElement("span", "tab-hostname");
    host.textContent = hostname(tab.url);
    tabCopy.append(link, host);

    const tabActions = requiredElement("div", "tab-actions");
    const restoreTabButton = requiredElement("button", "button restore-tab");
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

    const forgetTabButton = requiredElement("button", "button button-ghost forget-tab");
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
    row.append(tabCopy, tabActions);
    section.append(row);
  }

  const footer = requiredElement("div", "window-footer");
  const restoreButton = requiredElement("button", "button button-primary restore-window");
  restoreButton.type = "button";
  restoreButton.dataset.groupingId = grouping.groupingId;
  restoreButton.textContent = "Restore Window";
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
  footer.append(restoreButton);

  if (grouping.entirelyMissing) {
    const forgetWindowButton = requiredElement("button", "button button-ghost button-danger forget-window");
    forgetWindowButton.type = "button";
    forgetWindowButton.textContent = "Forget Window";
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
    footer.append(forgetWindowButton);
  }
  section.append(footer);
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
    protectedCount.textContent = `${summary.protectedTabCount} open protected ${plural(summary.protectedTabCount, "tab")}`;
  }

  if (summary.missingWindowGroupings.length === 0) {
    root.replaceChildren(renderEmptyState());
    return;
  }

  const groupings = requiredElement("div");
  groupings.id = "missing-window-groupings";
  for (const [index, grouping] of summary.missingWindowGroupings.entries()) {
    groupings.append(renderWindowGrouping(grouping, index, actions));
  }
  root.replaceChildren(renderSummary(summary, actions), groupings);
  void notice;
}
