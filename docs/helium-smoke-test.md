# Helium smoke test

Use this checklist against the completed `dist/` build in a dedicated Helium
Browser Profile. The steps intentionally close and recreate windows, so do not
run them against browsing state you cannot afford to change.

Ticket 01 previously established evidence that the unpacked extension loaded in
Helium and its installation smoke passed. That evidence predates the completed
Version 1 build. The full checklist below is deliberately left for the user to
execute on the completed build; it is not recorded as completed by automation.

## Prepare and install

- [ ] Run `npm ci` and `npm run build` from the repository root.
- [ ] Confirm `dist/manifest.json`, `dist/background.js`, and
      `dist/popup.html` exist.
- [ ] Create or select a dedicated Helium Browser Profile.
- [ ] Before installation, open one normal window with two HTTP(S) Web Tabs.
- [ ] Open `chrome://extensions`, enable **Developer mode**, choose
      **Load unpacked**, and select `dist/`.
- [ ] Confirm Helium shows **Tab Lifeboat** without an extension error.

Expected: protection begins on installation. Browser-internal pages such as a
new-tab page do not enter the Recovery Set.

## Initial protection and Recovery Popup

- [ ] Open the Tab Lifeboat toolbar action.
- [ ] Confirm the Recovery Popup is headed **Tab Lifeboat**.
- [ ] Confirm it reports the expected number of open protected tabs.
- [ ] Confirm it does not list currently open tabs as Missing Tabs.

Expected: the Recovery Popup reports open protection separately and lists only
missing Window Groupings. Equal addresses remain separate Tracked Tabs if two
separate tabs were opened.

## Window Closure and restart durability

- [ ] In a second normal window, open two recognizable HTTP(S) Web Tabs.
- [ ] Close that whole window, rather than closing its tabs one by one.
- [ ] Confirm the toolbar badge becomes `2`.
- [ ] Open the Recovery Popup and confirm one missing Window Grouping contains
      both Missing Tabs in their saved order.
- [ ] Quit Helium normally, reopen the same Browser Profile, and wait at least
      five seconds for native restoration and reconciliation to settle.
- [ ] Open the Recovery Popup again.

Expected: Window Closure preserves both tabs in the Recovery Set. After restart,
tabs Helium restored natively are no longer missing; any tabs Helium did not
restore remain visible in the same Window Grouping. The extension does not open
tabs automatically. If Missing Tabs remain after startup, one notification may
announce that Manual Recovery is available.

## Manual Recovery

- [ ] If Helium restored every test tab natively, close the two-tab test window
      again so the Window Grouping is missing.
- [ ] In the Recovery Popup, choose **Restore Window** for the test Window
      Grouping.
- [ ] Confirm a normal window contains the recovered tabs in their saved order
      and pinned/unpinned state.
- [ ] Reopen the Recovery Popup.

Expected: Manual Recovery starts only after the button is chosen, creates no
duplicate for a tab already open in the matching Window Grouping, and removes
successfully reopened tabs from the Missing Tabs list. The protected-tab count
increases and the badge clears when nothing remains missing.

## Developer reload check

- [ ] With at least one preserved missing Window Grouping, run `npm run build`.
- [ ] On `chrome://extensions`, choose **Reload** for Tab Lifeboat without
      removing it.
- [ ] Reopen the Recovery Popup.

Expected: the same Recovery Set remains available after the extension reload.

## Durability boundary

Recovery Data belongs to one Browser Profile and is not synchronized or merged.
This Version 1 makes no durability guarantee after:

- extension uninstall;
- Browser Profile deletion;
- storage corruption; or
- device loss.

Removing and re-adding the extension is therefore not a supported update path.

## Automated coverage and exact gaps

`npm run test:durability` uses a persistent Browser Profile across two Chromium
processes. It verifies that the last completed persistent write survives the
browser restart (which also terminates and restarts the Manifest V3 service
worker), then verifies reconciliation from persisted Recovery Data.

An isolated forced-worker restart is not stable in the current Playwright
harness: `chrome.runtime.reload()` closes the entire persistent browser context,
while stopping the worker through `chrome://serviceworker-internals` closes the
observed worker target but Playwright does not expose a reliably wakeable
replacement target. Browser restart is retained as the deterministic lifecycle
scenario.

Helium/browser binary updates are not automated because the harness does not
install or switch Helium versions. A packaged extension-update scenario is also
not automated because command-line unpacked loading does not reproduce the
browser's signed extension-update mechanism. The Developer reload checklist
above covers the locally installable workflow manually.
