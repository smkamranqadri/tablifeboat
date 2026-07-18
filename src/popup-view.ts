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

let openMenuButton: HTMLButtonElement | undefined;

function closeOpenMenu(returnFocus: boolean): void {
  if (!openMenuButton) return;
  const menuId = openMenuButton.getAttribute("aria-controls");
  const menu = menuId ? document.getElementById(menuId) : null;
  openMenuButton.setAttribute("aria-expanded", "false");
  if (menu instanceof HTMLElement) menu.hidden = true;
  const button = openMenuButton;
  openMenuButton = undefined;
  if (returnFocus) button.focus();
}

document.addEventListener("pointerdown", (event) => {
  if (event.target instanceof Element && !event.target.closest(".tab-menu")) {
    closeOpenMenu(false);
  }
});

function requiredElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function setPending(
  button: HTMLButtonElement,
  pending: boolean,
  pendingLabel: "Restoring…" | "Forgetting…",
): void {
  if (pending) {
    button.dataset.idleLabel = button.textContent ?? "";
    button.textContent = pendingLabel;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return;
  }
  button.textContent = button.dataset.idleLabel ?? button.textContent;
  button.disabled = false;
  button.removeAttribute("aria-busy");
}

function showFailure(container: HTMLElement, message: string): void {
  let alert = container.querySelector<HTMLElement>("[role='alert']");
  if (!alert) {
    alert = requiredElement("p", "inline-error");
    alert.role = "alert";
    container.append(alert);
  }
  alert.textContent = message;
}

function announceStatus(message: string): void {
  const status = document.querySelector<HTMLElement>("#popup-status");
  if (status) status.textContent = message;
}

function failedNotice(result: RestoreResult, notice: RecoveryNotice): RecoveryNotice | undefined {
  return result.failedRecordIds.length > 0 ? notice : undefined;
}

async function refreshAndRestoreFocus(
  actions: PopupActions,
  notice: RecoveryNotice | undefined,
  groupingId?: string,
): Promise<void> {
  await actions.refresh(notice);
  if (groupingId) {
    const card = document.querySelector<HTMLElement>(
      `[data-grouping-id="${CSS.escape(groupingId)}"]`,
    );
    const restoreWindow = card?.querySelector<HTMLButtonElement>(".restore-window");
    if (restoreWindow) {
      restoreWindow.focus();
      return;
    }
  }
  const restoreAll = document.querySelector<HTMLButtonElement>("#restore-all:not([hidden])");
  if (restoreAll) {
    restoreAll.focus();
    return;
  }
  const heading = document.querySelector<HTMLElement>("#popup-title");
  if (heading) {
    heading.tabIndex = -1;
    heading.focus();
  }
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
  restoreAll.id = "restore-all";
  restoreAll.type = "button";
  restoreAll.textContent = "Restore All";
  restoreAll.addEventListener("click", async () => {
    const pendingLabel = "Restoring…" as const;
    setPending(restoreAll, true, pendingLabel);
    announceStatus("Restoring all missing tabs");
    try {
      const result = await actions.restoreAll();
      await refreshAndRestoreFocus(
        actions,
        failedNotice(result, { scope: "summary", message: "Could not restore all missing tabs" }),
      );
      announceStatus("Recovery finished");
    } catch (error: unknown) {
      showFailure(section, "Could not restore all missing tabs");
    } finally {
      setPending(restoreAll, false, pendingLabel);
    }
  });
  section.append(text, restoreAll);
  return section;
}

function renderTabMenu(tab: TrackedTabSummary, actions: PopupActions, row: HTMLElement): HTMLElement {
  const wrapper = requiredElement("div", "tab-menu");
  const button = requiredElement("button", "button button-ghost tab-menu-trigger");
  const menu = requiredElement("div", "tab-menu-content");
  const menuId = `tab-menu-${tab.recordId}`;
  button.type = "button";
  button.textContent = "More";
  button.setAttribute("aria-label", `More actions for ${tab.title}`);
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", menuId);
  menu.id = menuId;
  menu.role = "menu";
  menu.hidden = true;

  const forget = requiredElement("button", "tab-menu-item");
  forget.type = "button";
  forget.role = "menuitem";
  forget.textContent = "Forget tab";
  forget.setAttribute("aria-label", `Forget Tab: ${tab.title}`);
  forget.addEventListener("click", async () => {
    const pendingLabel = "Forgetting…" as const;
    setPending(forget, true, pendingLabel);
    announceStatus(`Forgetting ${tab.title}`);
    try {
      const result = await actions.forgetTab(tab.recordId);
      if (!result.forgotten) {
        showFailure(row, "Could not forget this tab");
        return;
      }
      await actions.refresh();
      announceStatus("Tab forgotten");
    } catch (error: unknown) {
      showFailure(row, "Could not forget this tab");
    } finally {
      setPending(forget, false, pendingLabel);
    }
  });

  button.addEventListener("click", () => {
    const opening = button.getAttribute("aria-expanded") === "false";
    closeOpenMenu(false);
    if (opening) {
      button.setAttribute("aria-expanded", "true");
      menu.hidden = false;
      openMenuButton = button;
      forget.focus();
    }
  });
  button.addEventListener("keydown", (event) => {
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      button.click();
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeOpenMenu(true);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      forget.focus();
    }
  });
  wrapper.append(button, menu);
  menu.append(forget);
  return wrapper;
}

function renderWindowGrouping(
  grouping: WindowGroupingSummary,
  index: number,
  actions: PopupActions,
): HTMLElement {
  const section = requiredElement("section", "missing-window-grouping");
  section.dataset.groupingId = grouping.groupingId;
  section.setAttribute("aria-label", "Missing Window Grouping");

  const header = requiredElement("div", "window-header");
  const heading = requiredElement("h2");
  heading.textContent = `Window ${index + 1}`;
  heading.setAttribute("aria-label", "Missing Window Grouping");
  header.append(heading);
  section.append(header);

  for (const tab of grouping.tabs) {
    const row = requiredElement("div", "tab-row");
    row.dataset.recordId = tab.recordId;
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
      const pendingLabel = "Restoring…" as const;
      setPending(restoreTabButton, true, pendingLabel);
      announceStatus(`Restoring ${tab.title}`);
      try {
        const result = await actions.restoreTab(tab.recordId);
        await refreshAndRestoreFocus(
          actions,
          failedNotice(result, { scope: "tab", recordId: tab.recordId, message: "Could not restore this tab" }),
          grouping.groupingId,
        );
        announceStatus("Tab restored");
      } catch (error: unknown) {
        showFailure(row, "Could not restore this tab");
      } finally {
        setPending(restoreTabButton, false, pendingLabel);
      }
    });

    tabActions.append(restoreTabButton, renderTabMenu(tab, actions, row));
    row.append(tabCopy, tabActions);
    section.append(row);
  }

  const footer = requiredElement("div", "window-footer");
  const restoreButton = requiredElement("button", "button button-primary restore-window");
  restoreButton.type = "button";
  restoreButton.dataset.groupingId = grouping.groupingId;
  restoreButton.textContent = "Restore Window";
  restoreButton.addEventListener("click", async () => {
    const pendingLabel = "Restoring…" as const;
    setPending(restoreButton, true, pendingLabel);
    announceStatus("Restoring window");
    try {
      const result = await actions.restoreWindow(grouping.groupingId);
      await refreshAndRestoreFocus(
        actions,
        failedNotice(result, {
          scope: "grouping",
          groupingId: grouping.groupingId,
          message: "Could not restore this window",
        }),
      );
      announceStatus("Window restored");
    } catch (error: unknown) {
      showFailure(section, "Could not restore this window");
    } finally {
      setPending(restoreButton, false, pendingLabel);
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

      const pendingLabel = "Forgetting…" as const;
      setPending(forgetWindowButton, true, pendingLabel);
      announceStatus("Forgetting window");
      try {
        const result = await actions.forgetWindow(grouping.groupingId);
        if (!result.forgotten) {
          showFailure(section, "Could not forget this window");
          return;
        }
        await actions.refresh();
        announceStatus("Window forgotten");
      } catch (error: unknown) {
        showFailure(section, "Could not forget this window");
      } finally {
        setPending(forgetWindowButton, false, pendingLabel);
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
  renderNotice(root, notice);
}

function renderNotice(root: HTMLElement, notice?: RecoveryNotice): void {
  if (!notice) return;
  const selector =
    notice.scope === "summary"
      ? ".recovery-summary"
      : notice.scope === "grouping"
        ? `[data-grouping-id="${CSS.escape(notice.groupingId)}"]`
        : `[data-record-id="${CSS.escape(notice.recordId)}"]`;
  const scope = root.querySelector<HTMLElement>(selector);
  if (scope) showFailure(scope, notice.message);
}
