import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";

export interface ExtensionProfile {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  openPopup: () => Promise<Page>;
  close: () => Promise<void>;
}

interface ExtensionProfileOptions {
  profileDirectory?: string;
  restoreLastSession?: boolean;
}

export async function launchExtensionProfile(
  options: ExtensionProfileOptions = {},
): Promise<ExtensionProfile> {
  const profileDirectory =
    options.profileDirectory ??
    (await mkdtemp(path.join(tmpdir(), "tab-recovery-profile-")));
  const extensionDirectory = path.resolve("dist");
  let context: BrowserContext | undefined;

  try {
    context = await chromium.launchPersistentContext(profileDirectory, {
      headless: true,
      channel: "chromium",
      args: [
        `--disable-extensions-except=${extensionDirectory}`,
        `--load-extension=${extensionDirectory}`,
        ...(options.restoreLastSession ? ["--restore-last-session"] : []),
      ],
    });

    const serviceWorker =
      context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(serviceWorker.url()).hostname;

    return {
      context,
      serviceWorker,
      extensionId,
      openPopup: async () => {
        const popup = await context!.newPage();
        await popup.goto(`chrome-extension://${extensionId}/popup.html`);
        return popup;
      },
      close: async () => {
        await context?.close();
        context = undefined;
        await rm(profileDirectory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await context?.close();
    await rm(profileDirectory, { recursive: true, force: true });
    throw error;
  }
}
