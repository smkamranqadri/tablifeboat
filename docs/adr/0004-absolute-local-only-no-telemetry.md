---
status: accepted
---

# Commit publicly to an absolute local-only, no-telemetry guarantee

The extension holds the `tabs` permission and therefore records browsing-activity
data (tab titles and addresses), yet its architecture keeps all of it on-device —
no host permissions, no `fetch`, no analytics, nothing leaves the machine. Version
2 states this as an explicit public commitment in the README: all data stays
on-device, zero network requests, no analytics, no third parties, no sale of data,
ever. On a recovery tool, this local-only guarantee is the core of the trust story
and a genuine differentiator.

The commitment is voluntary, not compelled: v2 does not publish through a store
(see [ADR-0003](0003-distribute-via-github-releases-chromium-wide.md)), so no
store policy requires a privacy disclosure. We make the statement anyway because
it matches the code exactly and because a public, verifiable repo lets anyone
confirm it.

## Consequences

- Adding crash telemetry or usage metrics later would contradict a public promise
  and require fresh, explicit user consent — not a silent change. We accept that
  trade-off: trust over future observability.
- The guarantee restates, rather than adds to, the existing Recovery Data boundary
  (local to one Browser Profile, never synchronized) and reinforces the
  `Preference State` boundary: even disposable interface state stays on-device.
- Because the public repository is itself the distribution channel, the claim is
  independently auditable — the strongest form the guarantee can take.
