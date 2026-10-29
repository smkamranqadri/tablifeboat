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

export interface OpenMissingCount {
  openMissingCount: number;
}

export interface ForgetOpenResult {
  forgottenCount: number;
}

export type RecoveryNotice =
  | { scope: "summary"; message: string; tone?: "info" }
  | { scope: "grouping"; groupingId: string; message: string }
  | { scope: "tab"; recordId: string; message: string };

export interface PopupActions {
  restoreAll(): Promise<RestoreResult>;
  restoreWindow(groupingId: string): Promise<RestoreResult>;
  restoreTab(recordId: string): Promise<RestoreResult>;
  forgetWindow(groupingId: string): Promise<ForgetResult>;
  forgetTab(recordId: string): Promise<ForgetResult>;
  countOpenMissingTabs(): Promise<OpenMissingCount>;
  forgetOpenMissingTabs(): Promise<ForgetOpenResult>;
  refresh(notice?: RecoveryNotice): Promise<void>;
}

function firstRunExplainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>("#first-run-explainer");
}

export function initFirstRunExplainer(dismissed: boolean, onDismiss: () => void): void {
  const explainer = firstRunExplainer();
  if (!explainer) return;
  if (dismissed) {
    explainer.hidden = true;
    return;
  }

  explainer.hidden = false;
  const dismissButton = document.querySelector<HTMLButtonElement>(
    "#dismiss-first-run-explainer",
  );
  dismissButton?.addEventListener("click", () => {
    explainer.hidden = true;
    onDismiss();
    const heading = document.querySelector<HTMLElement>("#popup-title");
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  });
}

export function hideFirstRunExplainer(): void {
  const explainer = firstRunExplainer();
  if (explainer) explainer.hidden = true;
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
  pendingLabel: "Restoring…" | "Forgetting…" | "Checking…",
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

// A native confirm() is drawn by the browser at its own width and the popup
// clips it, so confirmation lives inside the popup document.
function confirmAction(message: string, confirmLabel: string): Promise<boolean> {
  const dialog = requiredElement("dialog", "confirm-dialog");
  const copy = requiredElement("p", "confirm-dialog-message");
  copy.id = "confirm-dialog-message";
  copy.textContent = message;
  dialog.setAttribute("aria-labelledby", copy.id);
  const dialogActions = requiredElement("div", "confirm-dialog-actions");
  const cancel = requiredElement("button", "button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  const confirm = requiredElement("button", "button button-primary");
  confirm.type = "button";
  confirm.textContent = confirmLabel;
  dialogActions.append(cancel, confirm);
  dialog.append(copy, dialogActions);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean): void => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      resolve(confirmed);
    };
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

function showNote(container: HTMLElement, message: string): void {
  const note = requiredElement("p", "inline-note");
  note.role = "status";
  note.textContent = message;
  container.append(note);
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
      const notice = failedNotice(result, {
        scope: "summary",
        message: "Could not restore all missing tabs",
      });
      await refreshAndRestoreFocus(actions, notice);
      announceStatus(notice ? "Recovery needs attention" : "Recovery finished");
    } catch (error: unknown) {
      showFailure(section, "Could not restore all missing tabs");
    } finally {
      setPending(restoreAll, false, pendingLabel);
    }
  });
  const summaryActions = requiredElement("div", "summary-actions");
  summaryActions.append(renderCheckOpenTabs(section, actions), restoreAll);
  section.append(text, summaryActions);
  return section;
}

function renderCheckOpenTabs(section: HTMLElement, actions: PopupActions): HTMLButtonElement {
  const check = requiredElement("button", "button check-open-tabs");
  check.type = "button";
  check.textContent = "Check open tabs";
  check.addEventListener("click", async () => {
    const pendingLabel = "Checking…" as const;
    setPending(check, true, pendingLabel);
    announceStatus("Checking missing tabs against open tabs");
    try {
      const { openMissingCount } = await actions.countOpenMissingTabs();
      if (openMissingCount === 0) {
        await actions.refresh({
          scope: "summary",
          tone: "info",
          message: "None of the missing tabs are open",
        });
        announceStatus("None of the missing tabs are open");
        return;
      }
      const noun = `${openMissingCount} missing ${plural(openMissingCount, "tab")}`;
      const verb = openMissingCount === 1 ? "is" : "are";
      const confirmed = await confirmAction(
        `Forget ${noun} that ${verb} already open in a window?`,
        "Forget",
      );
      if (!confirmed) {
        announceStatus("Nothing was forgotten");
        return;
      }
      const { forgottenCount } = await actions.forgetOpenMissingTabs();
      const message = `Forgot ${forgottenCount} ${plural(forgottenCount, "tab")} already open`;
      await refreshAndRestoreFocus(actions, { scope: "summary", tone: "info", message });
      announceStatus(message);
    } catch (error: unknown) {
      showFailure(section, "Could not check open tabs");
    } finally {
      setPending(check, false, pendingLabel);
    }
  });
  return check;
}

function renderTabMenu(
  tab: TrackedTabSummary,
  groupingId: string,
  actions: PopupActions,
  row: HTMLElement,
): HTMLElement {
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
      await refreshAndRestoreFocus(actions, undefined, groupingId);
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
        const notice = failedNotice(result, {
          scope: "tab",
          recordId: tab.recordId,
          message: "Could not restore this tab",
        });
        await refreshAndRestoreFocus(actions, notice, grouping.groupingId);
        announceStatus(notice ? "Recovery needs attention" : "Tab restored");
      } catch (error: unknown) {
        showFailure(row, "Could not restore this tab");
      } finally {
        setPending(restoreTabButton, false, pendingLabel);
      }
    });

    tabActions.append(restoreTabButton, renderTabMenu(tab, grouping.groupingId, actions, row));
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
      const notice = failedNotice(result, {
        scope: "grouping",
        groupingId: grouping.groupingId,
        message: "Could not restore this window",
      });
      await refreshAndRestoreFocus(actions, notice);
      announceStatus(notice ? "Recovery needs attention" : "Window restored");
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
      const confirmed = await confirmAction(
        "Permanently forget this Window Grouping and all of its tabs?",
        "Forget",
      );
      if (!confirmed) {
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
        await refreshAndRestoreFocus(actions, undefined);
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
  if (!scope) return;
  if (notice.scope === "summary" && notice.tone === "info") {
    showNote(scope, notice.message);
    return;
  }
  showFailure(scope, notice.message);
}
