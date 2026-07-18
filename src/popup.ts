interface TrackedTabSummary {
  recordId: string;
  title: string;
  url: string;
}

interface WindowGroupingSummary {
  groupingId: string;
  tabs: TrackedTabSummary[];
  entirelyMissing: boolean;
}

interface RecoverySummary {
  protectedTabCount: number;
  missingTabCount: number;
  missingWindowGroupings: WindowGroupingSummary[];
}

interface ForgetResult {
  forgotten: boolean;
  reason?: string;
}

interface RestoreResult {
  restoredRecordIds: string[];
  failedRecordIds: string[];
}

async function sendForgetRequest(message: object): Promise<void> {
  const result = (await chrome.runtime.sendMessage(message)) as ForgetResult;
  if (!result.forgotten) {
    throw new Error(`Recovery Data was not forgotten: ${result.reason ?? "unknown"}`);
  }
  await renderRecoverySummary();
}

async function renderRecoverySummary(): Promise<void> {
  const count = document.querySelector<HTMLParagraphElement>("#protected-count");
  const restoreAllButton = document.querySelector<HTMLButtonElement>("#restore-all");
  const missingWindowGroupingsContainer = document.querySelector<HTMLDivElement>(
    "#missing-window-groupings",
  );

  if (!count || !restoreAllButton || !missingWindowGroupingsContainer) {
    return;
  }

  const { protectedTabCount, missingWindowGroupings } = (await chrome.runtime.sendMessage({
    type: "getRecoverySummary",
  })) as RecoverySummary;
  const noun = protectedTabCount === 1 ? "tab" : "tabs";
  count.textContent = `${protectedTabCount} open protected ${noun}`;
  restoreAllButton.hidden = missingWindowGroupings.length === 0;

  missingWindowGroupingsContainer.replaceChildren(
    ...missingWindowGroupings.map((grouping) => {
      const section = document.createElement("section");
      section.className = "missing-window-grouping";
      section.setAttribute("aria-label", "Missing Window Grouping");

      const heading = document.createElement("h2");
      heading.textContent = "Missing Window Grouping";
      section.append(heading);

      const list = document.createElement("ul");
      for (const tab of grouping.tabs) {
        const item = document.createElement("li");
        const tabDetails = document.createElement("span");
        tabDetails.className = "tab-details";
        const link = document.createElement("a");
        link.href = tab.url;
        link.textContent = tab.title;
        link.title = tab.url;
        tabDetails.append(link);

        const tabActions = document.createElement("div");
        tabActions.className = "tab-actions";

        const restoreTabButton = document.createElement("button");
        restoreTabButton.type = "button";
        restoreTabButton.className = "restore-tab";
        restoreTabButton.textContent = "Restore Tab";
        restoreTabButton.setAttribute("aria-label", `Restore Tab: ${tab.title}`);
        restoreTabButton.addEventListener("click", async () => {
          restoreTabButton.disabled = true;
          try {
            const result = (await chrome.runtime.sendMessage({
              type: "restoreTab",
              recordId: tab.recordId,
            })) as RestoreResult;
            if (!result.restoredRecordIds.includes(tab.recordId)) {
              throw new Error("Missing Tab was not restored");
            }
            await renderRecoverySummary();
          } catch (error: unknown) {
            restoreTabButton.disabled = false;
            console.error("Failed to restore Missing Tab", error);
          }
        });

        const forgetTabButton = document.createElement("button");
        forgetTabButton.type = "button";
        forgetTabButton.className = "forget-tab";
        forgetTabButton.textContent = "Forget Tab";
        forgetTabButton.setAttribute("aria-label", `Forget Tab: ${tab.title}`);
        forgetTabButton.addEventListener("click", async () => {
          forgetTabButton.disabled = true;
          try {
            await sendForgetRequest({ type: "forgetTab", recordId: tab.recordId });
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

      const actions = document.createElement("div");
      actions.className = "window-actions";

      const restoreButton = document.createElement("button");
      restoreButton.type = "button";
      restoreButton.className = "restore-window";
      restoreButton.dataset.groupingId = grouping.groupingId;
      restoreButton.textContent = "Restore Window";
      restoreButton.setAttribute("aria-label", "Restore Window Grouping");
      restoreButton.addEventListener("click", async () => {
        restoreButton.disabled = true;
        try {
          await chrome.runtime.sendMessage({
            type: "restoreWindowGrouping",
            groupingId: grouping.groupingId,
          });
          await renderRecoverySummary();
        } catch (error: unknown) {
          restoreButton.disabled = false;
          console.error("Failed to restore Window Grouping", error);
        }
      });
      actions.append(restoreButton);

      if (grouping.entirelyMissing) {
        const forgetWindowButton = document.createElement("button");
        forgetWindowButton.type = "button";
        forgetWindowButton.className = "forget-window";
        forgetWindowButton.textContent = "Forget Window";
        forgetWindowButton.setAttribute("aria-label", "Forget Window Grouping");
        forgetWindowButton.addEventListener("click", async () => {
          if (
            !window.confirm(
              "Permanently forget this Window Grouping and all of its tabs?",
            )
          ) {
            return;
          }

          forgetWindowButton.disabled = true;
          try {
            await sendForgetRequest({
              type: "forgetWindowGrouping",
              groupingId: grouping.groupingId,
            });
          } catch (error: unknown) {
            forgetWindowButton.disabled = false;
            console.error("Failed to forget Window Grouping", error);
          }
        });
        actions.append(forgetWindowButton);
      }
      section.append(actions);
      return section;
    }),
  );
}

const restoreAllButton = document.querySelector<HTMLButtonElement>("#restore-all");
restoreAllButton?.addEventListener("click", async () => {
  restoreAllButton.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "restoreAll" });
    await renderRecoverySummary();
  } catch (error: unknown) {
    console.error("Failed to restore all Missing Tabs", error);
  } finally {
    restoreAllButton.disabled = false;
  }
});

void renderRecoverySummary();
