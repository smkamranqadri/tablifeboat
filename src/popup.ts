import {
  renderRecoveryPopup,
  type ForgetResult,
  type PopupActions,
  type RecoveryNotice,
  type RecoverySummary,
  type RestoreResult,
} from "./popup-view.js";

const root = document.querySelector<HTMLElement>("#popup-content");

async function send<T>(message: object): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

async function refresh(notice?: RecoveryNotice): Promise<void> {
  if (!root) return;
  const summary = await send<RecoverySummary>({ type: "getRecoverySummary" });
  renderRecoveryPopup(root, summary, actions, notice);
}

const actions: PopupActions = {
  restoreAll: () => send<RestoreResult>({ type: "restoreAll" }),
  restoreWindow: (groupingId) =>
    send<RestoreResult>({ type: "restoreWindowGrouping", groupingId }),
  restoreTab: (recordId) => send<RestoreResult>({ type: "restoreTab", recordId }),
  forgetWindow: (groupingId) =>
    send<ForgetResult>({ type: "forgetWindowGrouping", groupingId }),
  forgetTab: (recordId) => send<ForgetResult>({ type: "forgetTab", recordId }),
  refresh,
};

void refresh();
