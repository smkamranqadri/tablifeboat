import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";

const run = promisify(execFile);

export interface ExtensionProfile {
  context: BrowserContext;
  serviceWorker: Worker;
  extensionId: string;
  openPopup: () => Promise<Page>;
  close: () => Promise<void>;
  crash: () => Promise<void>;
}

interface ExtensionProfileOptions {
  automatedTest?: boolean;
  profileDirectory?: string;
  restoreLastSession?: boolean;
}

async function chromiumProcessIds(profileDirectory: string): Promise<number[]> {
  // pgrep -f takes an extended regex, and a temp path can hold metacharacters.
  const pattern = `user-data-dir=${profileDirectory}`.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  try {
    const { stdout } = await run("pgrep", ["-f", "--", pattern]);
    return stdout
      .split("\n")
      .flatMap((line) => (line.trim() === "" ? [] : [Number(line.trim())]))
      .filter((processId) => Number.isInteger(processId));
  } catch {
    return [];
  }
}

async function waitForProcessesToExit(profileDirectory: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await chromiumProcessIds(profileDirectory)).length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Chromium did not exit for ${profileDirectory}`);
}

export async function launchExtensionProfile(
  options: ExtensionProfileOptions = {},
): Promise<ExtensionProfile> {
  const ownsProfileDirectory = options.profileDirectory === undefined;
  const profileDirectory =
    options.profileDirectory ??
    (await mkdtemp(path.join(tmpdir(), "tab-recovery-profile-")));
  let extensionDirectory = path.resolve("dist");
  let context: BrowserContext | undefined;

  try {
    if (options.automatedTest) {
      const automatedTestExtensionDirectory = path.join(
        profileDirectory,
        ".tab-recovery-automated-extension",
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
        ...(options.restoreLastSession
          ? ["--restore-last-session", "--hide-crash-restore-bubble"]
          : []),
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
      },
      crash: async () => {
        // SIGKILL stands in for a crash or force quit: Chromium reports neither
        // tabs.onRemoved nor windows.onRemoved, so the persisted Recovery Data
        // keeps the dead session's live associations.
        const processIds = await chromiumProcessIds(profileDirectory);
        if (processIds.length === 0) {
          throw new Error(`No Chromium process is using ${profileDirectory}`);
        }
        for (const processId of processIds) {
          try {
            process.kill(processId, "SIGKILL");
          } catch {
            continue;
          }
        }
        context = undefined;
        await waitForProcessesToExit(profileDirectory);
      },
    };
  } catch (error) {
    await context?.close();
    if (ownsProfileDirectory) {
      await rm(profileDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}
