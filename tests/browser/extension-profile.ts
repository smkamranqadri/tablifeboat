import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  automatedTest?: boolean;
  profileDirectory?: string;
  restoreLastSession?: boolean;
}

export async function launchExtensionProfile(
  options: ExtensionProfileOptions = {},
): Promise<ExtensionProfile> {
  const ownsProfileDirectory = options.profileDirectory === undefined;
  const profileDirectory =
    options.profileDirectory ??
    (await mkdtemp(path.join(tmpdir(), "tab-recovery-profile-")));
  let automatedTestExtensionDirectory: string | undefined;
  let extensionDirectory = path.resolve("dist");
  let context: BrowserContext | undefined;

  try {
    if (options.automatedTest) {
      automatedTestExtensionDirectory = await mkdtemp(
        path.join(tmpdir(), "tab-recovery-automated-extension-"),
      );
      await cp(extensionDirectory, automatedTestExtensionDirectory, {
        recursive: true,
      });
      const manifestPath = path.join(
        automatedTestExtensionDirectory,
        "manifest.json",
      );
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      manifest.version_name = "automated-test";
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      extensionDirectory = automatedTestExtensionDirectory;
    }

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
        if (ownsProfileDirectory) {
          await rm(profileDirectory, { recursive: true, force: true });
        }
        if (automatedTestExtensionDirectory) {
          await rm(automatedTestExtensionDirectory, {
            recursive: true,
            force: true,
          });
        }
      },
    };
  } catch (error) {
    await context?.close();
    if (ownsProfileDirectory) {
      await rm(profileDirectory, { recursive: true, force: true });
    }
    if (automatedTestExtensionDirectory) {
      await rm(automatedTestExtensionDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
