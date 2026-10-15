---
status: accepted
---

# Distribute v2 via public GitHub Releases; support Chromium-based browsers

Version 1 shipped only through Helium's developer-mode Load unpacked flow. Version
2 set out to broaden reach by publishing to the Chrome Web Store — the single pipe
that also serves Helium, which installs Chromium extensions from the Chrome Web
Store. That path requires a Chrome Web Store developer account with a one-time $5
registration fee, and we decided not to register a paid, vendor-linked developer
identity. There is no free path to a Chrome Web Store (or Chrome/Helium store)
listing.

So v2 distributes as a built `.zip` published on **public GitHub Releases**, with
Load-unpacked installation documented in the README. The supported target is
**Chromium-based browsers** generally: standard Manifest V3 with no host
permissions runs unchanged on any Chromium engine, the automated Playwright suite
covers bundled Chromium, and Helium remains the manual smoke-test target.

## Considered Options

- **Chrome Web Store ($5 account)** — the only route to one-click store reach for
  Helium and Chrome users; rejected because we declined the paid vendor-linked
  developer identity. Kept available if that stance changes.
- **Microsoft Edge Add-ons (free)** — a free, real store listing, but it reaches
  only Edge users (not Helium or Chrome) and still hands a vendor the developer
  identity we declined to Google. Wrong audience for a Helium-first tool.
- **Self-hosted `.crx` with an update URL** — Chromium blocks self-hosted
  extension installs for ordinary users (enterprise policy only), so it does not
  reach the public.
- **Public GitHub Releases + Load unpacked (chosen)** — free, privacy-consistent
  (no vendor developer identity), and a natural home now that the repo is public.

## Consequences

- This narrows the goal from "broaden reach" to "make it publicly available":
  reach is limited to users willing to sideload via Load unpacked, essentially
  Version 1's install method, now public and polished — not one-click store reach.
- No store review means no store-mandated gates. Icons and a privacy policy
  become voluntary quality/trust choices rather than requirements (see
  [ADR-0004](0004-absolute-local-only-no-telemetry.md)).
- No silent store auto-updates: updates are manual re-download and Reload, so the
  update model reverts to Version 1's. The service-worker-restart and reload
  durability checks still apply; the "auto-update over live Recovery Data" concern
  no longer does.
- The public repository is the distribution channel. A pre-publish audit found no
  personal data in any tracked file (the only personal data is the commit author
  identity in git metadata), and the author chose to leave authorship as-is, so no
  history rewrite is performed; the repository is published as-is under the remote
  `git@github.com:smkamranqadri/tablifeboat.git`.
- First public release is tagged `1.0.0`; the "v1 / v2" labels are product
  milestones, not manifest numbers.
