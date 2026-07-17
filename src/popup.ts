interface RecoverySummary {
  protectedTabCount: number;
}

async function renderRecoverySummary(): Promise<void> {
  const count = document.querySelector<HTMLParagraphElement>("#protected-count");

  if (!count) {
    return;
  }

  const { protectedTabCount } = (await chrome.runtime.sendMessage({
    type: "getRecoverySummary",
  })) as RecoverySummary;
  const noun = protectedTabCount === 1 ? "tab" : "tabs";
  count.textContent = `${protectedTabCount} open protected ${noun}`;
}

void renderRecoverySummary();
