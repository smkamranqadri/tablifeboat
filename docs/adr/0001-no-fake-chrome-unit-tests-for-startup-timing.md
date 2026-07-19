---
status: accepted
---

# No fake-chrome unit tests for the startup/settling timing logic (Tier 2 declined)

The [pure-logic unit test spec](../superpowers/specs/2026-07-19-pure-logic-unit-tests-design.md)
shipped Tier 1 (fast Vitest tests over the pure reconciliation math) and left
"Tier 2" — a fake-timer + fake-`chrome` unit layer over the two timing state
machines (`scheduleStartupReconciliation`'s startup-settle / session-state /
late-restoration machine, and the tab-tracking 100 ms Window-Closure settling
race) — as an open "worth it?" question. **We are declining Tier 2.**

The deciding reason is coverage duplication, not that the code is stable. The
riskiest paths (worker-restart mid-settle, late native-restoration retry,
notification-claim idempotency, and the last-tab-removed-before-window-removed
race) are **already driven deterministically by the Playwright suite** via the
`isAutomatedTestBuild` control hooks (`simulateStartupForTest`,
`reconcileAfterStartupSettlingForTest`) — at real Chromium fidelity. A
fake-`chrome` unit layer would re-cover those same paths at *lower* fidelity,
against our own assumption of Chromium's event ordering rather than Chromium
itself. The only thing it would buy is sub-second feedback speed on logic no one
iterates on rapidly, which does not justify building and maintaining the
fake-`chrome` harness.

## Considered and rejected

- **Build the fake-`chrome` + `vi.useFakeTimers()` unit layer.** Cheaper than the
  spec feared (`scheduleStartupReconciliation` already takes its effects as
  injected callbacks, so no production DI/gateway refactor is needed — only a
  hand-rolled fake `chrome` global). Rejected anyway: the fixed cost of the fake
  buys duplicate, lower-fidelity coverage of paths the browser suite already
  reaches.

## Note for anyone reopening this

This is a coverage-duplication call, **not** a "this code never changes" call —
`git log` shows both timer machines still take direct bug fixes
(`fix: harden startup reconciliation`, `fix: settle ambiguous tab closures`).
The decision is contingent on the Playwright control hooks continuing to cover
these paths. **If those hooks are ever removed or the browser suite stops
exercising the startup/settling paths deterministically, reopen this** — at that
point a fast unit layer becomes the cheapest way to keep the coverage, and the
low harness cost noted above tips it back to worth-it.
