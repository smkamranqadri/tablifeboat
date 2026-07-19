# Tab Recovery

Tab Recovery is a local Manifest V3 extension for Helium. It maintains one
Browser Profile's latest Recovery Set, preserves Web Tabs lost through Window
Closure, and lets the user start Manual Recovery from the Recovery Popup.

## Privacy

Tab Recovery operates entirely on-device: all Recovery Data stays local to your
Browser Profile, with zero network requests, no analytics, no third parties, and
no sale of data, ever. The extension holds the `tabs` permission to record tab
titles and addresses but sends nothing to any server. Because this repository is
public, you can verify this guarantee against the source code.

## Build

Requirements:

- Node.js and npm
- Helium desktop

Install the pinned development dependencies and build the unpacked extension:

```sh
npm ci
npm run build
```

The installable extension is generated in `dist/`. Re-run `npm run build` after
changing source files.

## Install

Tab Recovery is distributed as a built `.zip` on [GitHub Releases](https://github.com/smkamranqadri/tab-recovery/releases)
and installs on Chromium-based browsers (Helium, Chrome, Edge, and others) via
Load unpacked:

1. Download the `.zip` from Releases and extract it.
2. Open the browser's extension-management page from the menu or by visiting
   `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the extracted `dist/` directory, not `src/` or the repository root.
6. Pin **Tab Recovery** to the toolbar if you want the Recovery Popup readily
   available.

After rebuilding or reloading, use **Reload** on the extension's card. Do not
remove and re-add the extension as an update procedure: uninstall is outside the
Recovery Data durability boundary.

For Helium users, follow the complete [Helium smoke test](docs/helium-smoke-test.md)
before relying on a completed build.

## Verification

```sh
npm run typecheck
npm run test:unit
npm run test:browser
npm run test:durability
npm test
```

The automated browser suite uses the bundled Playwright Chromium. The Helium
smoke test remains necessary for Helium-specific compatibility and the
Developer-mode Load unpacked flow.

## Recovery Data boundary

Recovery Data is local to one Browser Profile. Completed persistent writes are
expected to survive service-worker restarts, browser restarts, browser updates,
and extension updates. There is no durability guarantee after extension
uninstall, Browser Profile deletion, storage corruption, or device loss.
