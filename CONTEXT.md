# Tab Recovery

Tab Recovery preserves a trustworthy record of the user's browsing state so tabs can be reopened after that state is unexpectedly lost.

## Language

**Recovery Set**:
The latest collection of tabs that should be available for recovery. An individually closed tab leaves the Recovery Set, while tabs preserved by a whole-window closure remain in it; older versions are not retained as history.
_Avoid_: Tab list, backup list

**Individual Tab Closure**:
The deliberate closing of one tab while its containing browser window remains open. It removes that tab from the Recovery Set.
_Avoid_: Tab removal

**Window Closure**:
The closing of a browser window and all tabs it contains, whether intentional or caused by restart, update, or failure. It preserves those tabs in the Recovery Set.
_Avoid_: Bulk tab closure

**Manual Recovery**:
A user-initiated action that repairs a partially missing Window Grouping or recreates one or all entirely missing Window Groupings from the Recovery Set. Recovery never begins automatically when the browser starts.
_Avoid_: Automatic restore, startup restore

**Window Grouping**:
The membership and ordering of tabs within separate browser windows. Manual Recovery preserves this structure.
_Avoid_: Tab grouping, merged window

**Missing Tab**:
A tab in the Recovery Set that is not currently open in its expected Window Grouping. Tabs with the same address remain distinct when they originated as separate open tabs.
_Avoid_: Unique URL, deduplicated tab

**Browser Profile**:
The boundary of one independent Recovery Set. Recovery state is never merged or synchronized with another browser profile or installation.
_Avoid_: Account, device, browser family

**Recovery Data**:
The persistent record of a Browser Profile's Recovery Set. It is expected to survive browser restarts, crashes, browser updates, and extension updates, but not extension uninstall or Browser Profile deletion.
_Avoid_: Cloud backup, permanent archive

**Forget Window**:
An explicit user action that permanently removes one preserved window and all of its tabs from the Recovery Set.
_Avoid_: Close window, delete tabs

**Forget Tab**:
An explicit user action that permanently removes one Missing Tab while preserving the rest of its Window Grouping.
_Avoid_: Close tab, dismiss tab

**Failed Recovery**:
A Manual Recovery attempt that did not reopen a Missing Tab. The tab remains in the Recovery Set and can be retried or explicitly forgotten.
_Avoid_: Consumed tab, deleted recovery

**Tracked Tab**:
One recoverable tab represented by its current page title, address, and position within a Window Grouping. Navigating replaces its previous page rather than creating browsing history.
_Avoid_: History entry, visited page

**Recoverable Window**:
A normal browser window whose tabs belong in the Recovery Set. Incognito and private windows are outside the recovery boundary.
_Avoid_: Private window, incognito session

**Web Tab**:
A Tracked Tab whose current page uses an HTTP or HTTPS address. Browser-internal, extension, developer-tool, new-tab, temporary, and local-file pages are outside the Recovery Set.
_Avoid_: Special page, local tab

**Tab Placement**:
A Web Tab's Window Grouping, position within that window, and pinned or unpinned state. Manual Recovery preserves this state but not richer browser or page state.
_Avoid_: Tab state, page state

**Recovery Popup**:
The toolbar popup where the user inspects missing windows, starts Manual Recovery, and uses Forget Window. It omits currently open tabs except for a protected-tab count.
_Avoid_: Dashboard, recovery page
