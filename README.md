# Tab Recovery

Tab Recovery is a local Manifest V3 extension for Helium. It maintains one
Browser Profile's latest Recovery Set, preserves Web Tabs lost through Window
Closure, and lets the user start Manual Recovery from the Recovery Popup.

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

## Load in Helium

1. Open Helium's extension-management page from its menu or by visiting
   `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this repository's `dist/` directory, not `src/` or the repository
   root.
5. Pin **Tab Recovery** to the toolbar if you want the Recovery Popup readily
   available.

After rebuilding an already loaded checkout, use **Reload** on the extension's
card. Do not remove and re-add the extension as an update procedure: uninstall
is outside the Recovery Data durability boundary.

Follow the complete [Helium smoke test](docs/helium-smoke-test.md) before relying
on a completed build.

## Verification

```sh
npm run typecheck
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
