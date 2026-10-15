---
status: accepted
---

# Unit-test the pure migration logic; decline the rest of Tier 3

The pure-logic unit test design (2026-07-19)
parked four things under "Tier 3": `recovery-store`, `manual-recovery`,
`background.ts`, and a popup view-model extraction. Evaluated one by one, only
one is worth doing — and it isn't Tier-3-shaped.

**Adopt: pure Vitest tests for `migrateRecoverySet`** (in `recovery-store.ts`).
It is already pure (no `chrome.*`), runs on every read and write, and a bug in
it silently corrupts every persisted Recovery Set — the product's core promise.
Its edge cases (legacy `windowId`, missing `recordId`/`groupingId`,
`placement.windowId` cleanup, empty/absent stored set) are awkward and slow to
stage in a browser (write crafted legacy JSON into `storage.local`, then reload).
This is the same cheap, near-zero-risk pattern as Tier 1 — export the function
and cover it with hand-built fixtures; no fake `chrome`, no DI. It was filed
under Tier 3 only because it lives in `recovery-store.ts`, not because it needs
Tier-3 machinery.

**Decline the rest:**

- **popup view-model** — extracting a pure view-model is a real refactor
  (indirection cost) for UI-shaped, lower-consequence risk already covered by
  `recovery-popup-ui.spec.ts`.
- **`manual-recovery`** — its value is whether restore recreates the right
  windows/placement, which is *real* tab/window creation; a fake-`chrome` unit
  test asserts against our model of tab creation, not Chromium (the same
  fidelity limit as [ADR-0001](0001-no-fake-chrome-unit-tests-for-startup-timing.md)).
  Already covered by the `recover-*` browser specs.
- **`background.ts`** — thin message-router wiring; integration-shaped, low unit
  value.

## Consequence

`migrateRecoverySet` must be exported from `recovery-store.ts` (a one-line
surface widening, as Tier 1 did for the reconciliation helpers). No other
production change. The browser `recovery-store.spec.ts` stays as the
end-to-end persistence check.
