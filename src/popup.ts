import {
  hideFirstRunExplainer,
  initFirstRunExplainer,
  renderRecoveryPopup,
  type ForgetResult,
  type PopupActions,
  type RecoveryNotice,
  type RecoverySummary,
  type RestoreResult,
} from "./popup-view.js";
import {
  dismissFirstRunExplainer,
  readFirstRunExplainerDismissed,
} from "./preference-state.js";

const root = document.querySelector<HTMLElement>("#popup-content");

async function send<T>(message: object): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

let firstRunExplainerDismissed = false;

async function persistFirstRunExplainerDismissal(): Promise<void> {
  if (firstRunExplainerDismissed) return;
  firstRunExplainerDismissed = true;
  await dismissFirstRunExplainer();
}

async function afterRestore<T extends RestoreResult>(result: T): Promise<T> {
  if (result.restoredRecordIds.length > 0) {
    hideFirstRunExplainer();
    await persistFirstRunExplainerDismissal();
  }
  return result;
}

async function refresh(notice?: RecoveryNotice): Promise<void> {
  if (!root) return;
  const summary = await send<RecoverySummary>({ type: "getRecoverySummary" });
  renderRecoveryPopup(root, summary, actions, notice);
}

const actions: PopupActions = {
  restoreAll: () => send<RestoreResult>({ type: "restoreAll" }).then(afterRestore),
  restoreWindow: (groupingId) =>
    send<RestoreResult>({ type: "restoreWindowGrouping", groupingId }).then(afterRestore),
  restoreTab: (recordId) =>
    send<RestoreResult>({ type: "restoreTab", recordId }).then(afterRestore),
  forgetWindow: (groupingId) =>
    send<ForgetResult>({ type: "forgetWindowGrouping", groupingId }),
  forgetTab: (recordId) => send<ForgetResult>({ type: "forgetTab", recordId }),
  refresh,
};

async function init(): Promise<void> {
  firstRunExplainerDismissed = await readFirstRunExplainerDismissed();
  initFirstRunExplainer(firstRunExplainerDismissed, () => {
    void persistFirstRunExplainerDismissal();
  });
  await refresh();
}

void init();
