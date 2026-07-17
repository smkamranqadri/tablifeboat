interface TrackedTabSummary {
  recordId: string;
  title: string;
  url: string;
}

interface WindowGroupingSummary {
  groupingId: string;
  tabs: TrackedTabSummary[];
}

interface RecoverySummary {
  protectedTabCount: number;
  missingTabCount: number;
  missingWindowGroupings: WindowGroupingSummary[];
}

async function renderRecoverySummary(): Promise<void> {
  const count = document.querySelector<HTMLParagraphElement>("#protected-count");
  const restoreAllButton = document.querySelector<HTMLButtonElement>("#restore-all");
  const missingWindows = document.querySelector<HTMLDivElement>("#missing-windows");

  if (!count || !restoreAllButton || !missingWindows) {
    return;
  }

  const { protectedTabCount, missingWindowGroupings } = (await chrome.runtime.sendMessage({
    type: "getRecoverySummary",
  })) as RecoverySummary;
  const noun = protectedTabCount === 1 ? "tab" : "tabs";
  count.textContent = `${protectedTabCount} open protected ${noun}`;
  restoreAllButton.hidden = missingWindowGroupings.length === 0;

  missingWindows.replaceChildren(
    ...missingWindowGroupings.map((grouping) => {
      const section = document.createElement("section");
      section.className = "missing-window";

      const heading = document.createElement("h2");
      heading.textContent = "Missing Window";
      section.append(heading);

      const list = document.createElement("ul");
      for (const tab of grouping.tabs) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = tab.url;
        link.textContent = tab.title;
        link.title = tab.url;
        list.append(item);
        item.append(link);
      }
      section.append(list);

      const restoreButton = document.createElement("button");
      restoreButton.type = "button";
      restoreButton.className = "restore-window";
      restoreButton.dataset.groupingId = grouping.groupingId;
      restoreButton.textContent = "Restore Window";
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
      section.append(restoreButton);
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
