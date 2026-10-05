# Browser Tabs

Browser Tabs makes a person's browser available as a standalone automation
target: first to read, summarize, and organize the tabs, pages, and history
that already belong to them. It is local-first. The browser is not an agent
tool in the abstract; it is a source of personal working context.

The core idea is modest. A WebExtension exposes browser state through a
small, typed interface. A lightweight service, running as the same local user,
connects that interface to programs and agents. The service keeps useful state
outside the browser: captures, summaries, collections, provenance, and
proposed organization. The browser remains the place where the person
browses.

## Direction

The project should work on the Mac now and carry cleanly to a future Linux
desktop. That favors standard WebExtension APIs and a replaceable local bridge
over Chromium-only DevTools attachment or a custom browser.

The intended shape is:

```text
local programs and agents
        <-> user service <-> WebSocket <-> WebExtension <-> browser
                    |
                    +-> SQLite derived store
                    +-> local review UI
```

The extension maintains the browser-side connection. Programs make ordinary,
versioned requests to the service. The service hosts the review UI and owns
all state that does not belong in the browser. A later remote mode can tunnel
or otherwise authenticate the service without changing the extension
protocol. Remote access is not a Phase 1 requirement.

## Implementation defaults

These choices keep the first implementation small and can be revisited at the
named checkpoints:

- Use Node.js and JavaScript for the service and shared protocol. Prefer JSON
  Schema and runtime validation over adding a compilation step.
- Keep model reasoning outside Browser Tabs. Agents read through the API and
  write derived records and proposals back through explicit operations.
- Serve a small local web UI from the service for review and approval.
- Complete the first vertical slice in Chromium, then require Firefox parity
  before declaring Phase 1 complete.
- Use SQLite for service-owned state. Prefer the runtime's built-in SQLite
  support when the chosen minimum Node.js version provides it reliably.
- Support one local user and one connected browser profile first. Add
  multi-profile routing only after a concrete need appears.

## Trust model

The local service is a trusted, same-user component. Its API may be powerful;
early limits are principally for clarity, privacy, and implementation scope.
It binds only to loopback, stores its local credential with user-only file
permissions, and does not expose browser data to a remote network by default.
Loopback alone is not authentication: browser pages can issue requests to
localhost, so API and WebSocket requests must authenticate and reject
untrusted origins where origin checks apply.

The browser is different. Every title, URL, page body, DOM label, history
entry, console message, and network artifact is untrusted input. The system
must carry that provenance through extraction and present it to an LLM as
evidence, never as instructions or authority. Browser content cannot expand
the available API, alter policy, or approve an action.

Derived records must retain links to their sources and identify who or what
created them. A summary or proposed collection is not browser fact. The UI and
API must preserve that distinction.

This is a semantic boundary, not a claim that a local extension or service is
a security sandbox.

## Protocol rules

The extension protocol and the public service API may use different
transports, but they share the same rules:

- Every request carries a protocol version. Named-method requests also carry
  a request ID and validated parameters; health, control, auth, and
  heartbeat envelopes do not require a request ID.
- Every response to a named-method request repeats that request ID and
  contains either a typed result or a stable error code with optional
  diagnostic detail.
- Browser records include a browser-session identifier, capture time, source
  operation, and capture status.
- Window, tab, and group IDs are browser-session handles, not durable database
  identities and not array positions.
- Lists and text payloads are bounded. Large history queries are paginated.
- Unsupported, permission-denied, not-ready, disconnected, stale-handle, and
  internal-error outcomes remain distinguishable.
- Unknown fields are tolerated within a protocol version; incompatible changes
  require a new version.
- No API accepts arbitrary page JavaScript, exported cookies, or raw debugger
  commands.

## Phase 1: local read-and-organize loop

Phase 1 ends when a local program can inspect browser context, add derived
organization, and let the user review it with clear provenance. Browser
mutation is not required.

### Stage 0 — Stabilize the inspector

The present extension is the base, but the base must work in a real browser
before service work begins. In particular, an injected function cannot depend
on module lexical scope; the current text-limit constant must be passed into
the function or defined inside it.

Implementation:

- [x] Fix page snapshot injection so it runs in the target tab.
- [x] Test successful snapshots, missing bodies, CRLF normalization,
  character counts, and truncation at the configured limit.
- [x] Test `readTab` success, empty injection results, and rejected injection.
- [x] Validate message parameters before calling browser APIs.
- [x] Return stable error codes while retaining browser error text only as
  diagnostic detail.
- [x] Add a Chromium smoke test that loads the unpacked extension and exercises
  window listing, tab listing, a readable page, and a protected page.
- [x] Make the README's support claims match what the smoke tests establish.

Exit criteria:

- [x] `npm test` passes from a clean checkout. (29/29 passing for Stage 0's
  own test files, last verified before Stage 1 work began; `npm test` now
  also runs Stage 1's test files, so this count is no longer the total —
  see "Current repository state" below.)
- [x] The smoke test proves all three README operations in Chromium. (Passed
  against a real Chrome for Testing browser, via the extension's actual
  `runtime.onMessage` listener.)
- [x] A protected page produces an explicit unsupported or permission-denied
  result rather than empty content. (`status: "unsupported"`,
  `code: "injection_rejected"`, verified in the smoke test.)
- [x] No operation creates, closes, moves, groups, or navigates a tab.

### Stage 1 — Prove the local bridge

Build the narrowest end-to-end path before designing the complete API. The
service starts on loopback, the extension connects outward by WebSocket, and a
local client asks the service to list windows.

Implementation:

- [x] Add a service entry point with explicit `start`, `status`, and `stop`
  behavior suitable for development.
- [x] Bind HTTP and WebSocket listeners to loopback only.
- [x] Generate a local service credential and store it with user-only
  permissions.
- [x] Pair the extension with the service without embedding a credential in
  source control or the extension package.
- [x] Authenticate the extension WebSocket and local API requests.
- [x] Implement connection state, request correlation, timeouts, and bounded
  reconnect backoff.
- [x] Route `browser.list_windows` from an HTTP client through the service and
  extension, then return the typed result.
- [x] Expose a health endpoint that reports service and extension connectivity
  without exposing browser content.
- [x] Document local setup and recovery when the extension or service is
  unavailable.

Checkpoint:

Manifest V3 background lifetimes differ between browsers. If a quiet
WebSocket cannot remain reliable without artificial keepalive traffic, keep
the service API and protocol but replace the extension bridge with the
smallest reliable platform-supported transport. Do not build both transports
in advance.

Chosen resolution: keep the WebSocket transport, and send an authenticated
`ping`/`pong` heartbeat no more than 20 seconds apart once connected —
Chrome's own documented keepalive pattern for a long-lived service-worker
WebSocket. See `extension/service-client.js`, `service/server.mjs`, and
`HEARTBEAT_INTERVAL_MS` in `extension/protocol.js`. This rationale has been
exercised repeatedly against a real Chrome for Testing browser via
`test/smoke/stage1-bridge-smoke.mjs` — including the addendum below, found
via that real-browser testing — and that smoke test passes on the current
revision; see README.md's "Verification status" for the full evidence.

Addendum, found via real-browser testing: the heartbeat alone only keeps
the worker alive while a connection exists to reset its idle timer against.
While the *service* itself is unavailable (e.g. mid-restart) there is no
connection, and the `setTimeout`-based retry used in that gap cannot wake a
worker Chrome has already terminated — a `setTimeout` scheduled before
termination simply never fires. Added a `chrome.alarms`-based backstop
(`alarms` permission; `RECONNECT_ALARM_NAME`/`RECONNECT_ALARM_DELAY_MINUTES`
in `extension/protocol.js`): a persistent top-level `chrome.alarms.onAlarm`
listener is one of the mechanisms Chrome guarantees will wake a terminated
worker — but only if the alarm was actually armed before termination, and a
WebSocket `close` event is not a reliable place to arm it (Chrome need not
run `close` before terminating). The alarm is therefore armed as soon as a
pairing token is read (startup and token changes) and kept armed for as
long as a token exists, including while connected (`onAlarm` already
no-ops when a connection is in progress or established, so this is never a
duplicate connection); it is cleared only when the token is removed or the
client is explicitly stopped — not on successful auth. Chrome's current
documented minimum alarm frequency is 0.5 minutes, and
`RECONNECT_ALARM_DELAY_MINUTES` requests that floor directly — but this is
Chrome's floor, not a worst-case guarantee (Chrome may delay delivery
further), so it bounds typical service-restart recovery time to roughly
that order of magnitude without being a hard product SLA; the existing
`setTimeout` fast path (seconds) still applies whenever the worker was
never actually terminated. `test/smoke/stage1-bridge-smoke.mjs` proves this
by deliberately leaving the service down past the worker idle window
before restarting it, so the fast path cannot mask the alarm path. See
README.md's "Fixed loopback target and keepalive" section for the full
explanation.

Exit criteria:

- [x] A fresh local client can discover whether the service and extension are
  ready.
- [x] An authenticated request completes across the full path.
- [x] Missing credentials, bad origins, timeouts, and disconnects fail
  explicitly.
- [x] Service restart and extension restart recover without reinstalling or
  losing the pairing.

### Stage 2 — Complete the read API

Once the bridge is proven, expose the browser information needed by the first
useful workflow.

Implementation:

- [x] Enumerate windows with focused state, type, state, and tab count.
- [x] Enumerate tabs with window ID, index, active, pinned, audible, discarded,
  loading status, title, and URL.
- [x] Enumerate tab groups where the browser supports them and report the
  capability where it does not.
- [x] Read bounded rendered-text snapshots from the main frame.
- [x] Include URL, title, document readiness, capture time, full character
  count, returned character count, truncation, and capture status.
- [x] Query browsing-history metadata separately from open tabs with explicit
  time ranges, result limits, and pagination.
- [x] Add a capability response so clients do not infer browser features from
  brand names.
- [x] Reject stale tab and window handles rather than silently targeting a
  replacement.
- [x] Apply conservative response-size and request-rate bounds at the service
  boundary.

Exit criteria:

- [x] A client can distinguish open tabs, historical visits, and captured page
  text.
- [x] Every returned browser-derived value carries capture provenance.
- [x] Protected, discarded, loading, closed, and ordinary pages have tested
  outcomes. (Discarded's observed outcome depends on whether the browser has
  actually unloaded the tab at test time; `status: "ok"` is also a valid
  outcome if the browser chose not to discard it — see README.md's Stage 2
  verification notes.)
- [x] No API response is unbounded.

### Stage 3 — Add the derived store

The service owns interpretation and organization; the extension remains a
browser adapter. SQLite stores captures and derived records with small,
forward-only migrations.

Initial records:

- Capture: source browser/session handles, URL, title, capture time, status,
  text metadata, and bounded captured text.
- Summary: text, creator, creation time, source capture IDs, and optional model
  metadata supplied by the caller.
- Tag and collection: user-owned labels and ordered membership.
- Queue item: a source or derived record with a user-defined workflow state.
- Proposal: a caller's suggested tags, collections, queue changes, or future
  browser actions, with rationale and source IDs.

Implementation:

- [x] Create the SQLite database on first service start.
- [x] Add migration tracking and back up the database before incompatible
  migrations.
- [x] Store source records before accepting derived records that reference
  them.
- [x] Enforce foreign keys and reject references to missing sources.
- [x] Record whether each derived value came from the user, a named local
  client, or an external agent.
- [x] Add explicit create, list, update, and delete operations only for the
  records required by the review workflow.
- [x] Add retention settings and a single operation to clear captured and
  derived data.
- [x] Keep credentials and browser content out of logs by default.

Exit criteria:

- [x] Restarting the service preserves records and provenance.
- [x] Deleting a source has documented, tested behavior for derived records.
- [x] A user can inspect and clear all locally retained browser content.
- [x] Database failures do not corrupt or silently discard existing records.

### Stage 4 — External-agent workflow

Browser Tabs supplies evidence and accepts explicit derived results; it does
not choose or call a model in Phase 1.

Implementation:

- [x] Publish a compact client contract for listing sources, reading captures,
  and writing summaries and proposals.
- [x] Provide one small reference client or CLI flow using the same public API
  as other callers.
- [x] Require source IDs on summaries and proposals.
- [x] Preserve caller-supplied model and prompt metadata without treating it as
  trusted browser evidence.
- [x] Prevent proposals from invoking extension methods or changing approval
  policy.
- [x] Add an end-to-end example: capture selected tabs, attach summaries, and
  propose collections without changing the browser.

Exit criteria:

- [x] A caller can complete the example using only documented API operations.
- [x] The resulting records identify browser facts, derived text, provenance,
  and proposal state separately.
- [x] Malicious instructions inside captured page text cannot create a new API
  method or mark a proposal approved.

### Stage 5 — Local review UI

The service hosts a small web interface. It is a review surface, not a second
browser or a general agent console.

Implementation:

- [x] Show service and extension connection state.
- [x] Show windows, tabs, groups, and capture status without polling unbounded
  browser state.
- [x] Let the user choose which tabs to capture.
- [x] Show captured text with URL, timestamp, truncation, and unsupported-state
  details.
- [x] Show summaries, tags, queues, and collections alongside their sources.
- [x] Show proposals as proposals, including creator, rationale, evidence, and
  pending/rejected/accepted state.
- [x] Allow editing or deleting derived records and clearing stored captures.
- [x] Meet basic keyboard, focus, contrast, labeling, and reduced-motion
  accessibility requirements.
- [x] Escape untrusted text and use a restrictive Content Security Policy.

Exit criteria:

- [x] A user can tell what came from the browser, what was inferred, and by
  whom.
- [x] The primary capture-and-review flow works with keyboard navigation.
- [x] Rendering captured page text cannot execute markup or script.
- [x] Accepting a Phase 1 proposal changes only derived service data.

### Stage 6 — Firefox parity and local release

Chromium establishes the vertical slice; Firefox parity closes Phase 1.
Browser-specific code should remain at the extension API boundary.

Implementation:

- [x] Run the read API and review workflow in current Chrome and Firefox.
- [x] Test at least one additional Chromium browser without adding a separate
  implementation for its brand.
- [x] Isolate tab-group differences behind capability reporting.
- [x] Document installation, pairing, startup, upgrade, backup, reset, and
  uninstall behavior on macOS.
- [x] Verify that the service runs on Linux even if desktop packaging remains
  a later task.
- [x] Add continuous unit tests and repeatable browser smoke-test commands.
- [x] Version the extension, service, API, and database schema deliberately.
- [x] Produce checksummed local release artifacts.

Phase 1 completion checklist:

- [x] A clean Mac installation reaches the review UI using documented steps.
- [x] Chromium and Firefox can list supported browser state and capture pages.
- [x] History, captures, derived records, and proposals retain provenance.
- [x] All payloads and queries have tested bounds.
- [x] Authentication and origin checks protect the loopback service.
- [x] The user can inspect and erase locally retained data.
- [x] No browser mutation API is exposed.
- [x] Automated tests pass and the manual release checklist is recorded.

## Phase 2: explicit browser actions

Only begin browser mutations after the read-and-review loop is useful. Each
action is a named operation with a preview, an action-time user decision, and
a result describing exactly what changed. Approval is bound to the proposed
operation and current browser state; a stale approval cannot authorize a
changed target.

Candidate order:

1. Open a URL in a new tab.
2. Create, rename, or recolor a tab group.
3. Move selected tabs into an existing or new group.
4. Archive a tab by saving its record and then closing it.

Implementation checklist:

- [x] Define preconditions, preview data, approval state, and result data for
  the first action.
- [x] Require an explicit user decision immediately before execution.
- [x] Revalidate browser-session and tab handles after approval.
- [x] Report partial failure and the exact observed final state.
- [x] Keep an append-only local action audit record.
- [x] Add one action at a time with browser integration tests.
- [x] Do not add arbitrary navigation, page evaluation, cookie export, or
  debugger access as shortcuts.

### Action 1 (open a URL in a new tab): complete

Action 1 is covered by unit, integration, process-restart, and end-to-end
tests. The real Chrome for Testing bridge smoke verified preview, approval,
rejection, exact one-tab creation, stale-session refusal, and audit recording.
Independent Terra review passed after clear/restart, audit-content, and
single-service race findings were remediated. Firefox packaging still builds
with protocol version 3; this mutation checkpoint's required real-browser
proof used Chrome. The decisions later actions should reuse rather than
reinvent:

- **Preview, then one terminal decision by stored id alone.** Preview binds
  the exact normalized URL, the browser session learned from the extension
  (never from the caller), and a timestamp. Approve/reject take only the
  action id — no body, no other parameter. The decision is one conditional
  `UPDATE ... WHERE state = 'previewed'`, so of any number of concurrent
  decisions exactly one wins and only an approval's winner executes.
- **Owner-only.** The agent credential is refused on every action route and
  the extension method has no HTTP route; the extension dispatches the
  mutating method only from the authenticated service connection, never from
  `runtime.onMessage`.
- **The extension revalidates.** `browser.open_tab` re-checks the session
  inside the operation with no `await` before the single `tabs.create`
  (stale = no mutation), re-validates the URL, and reports the tab as read
  back with `tabs.get`; create-succeeded-but-reread-failed is the explicit
  `incomplete`/`observe_failed` partial outcome. A decided action is never
  retried.
- **Protocol bumped to 3.** The first mutating request must not be sendable
  to a peer that predates its contract; every non-`ok` result must state
  `created` consistently.
- **Append-only audit.** `action_audit` (migration v3, trigger-enforced, no
  update/delete route or function) records preview/decision/result in the same
  transaction as each state change, holds only server-controlled enum values
  (kind, decision, result state/mutation) — never a URL, hash, session id,
  handle, or any extension-supplied code/detail, so even a compromised
  extension cannot put content in it — and is bounded (it refuses new
  previews when full rather than dropping events). The `actions` table, which
  does hold the URL and the observed untrusted tab text, is cleared by
  `store.clear`; the audit log is not.
- **Honest outcomes.** `executed`, `partial`, `stale`, and `failed` with
  `mutation` `none` or `unknown` (request sent, answer lost or unusable).
- **In-flight safety.** `store.clear` is refused (409, nothing deleted) while
  any action is `approved` and awaiting its result; a clear that commits first
  makes a later approval a 404 that mutates nothing. An action found
  `approved` at service start (the service died mid-execution) is reconciled
  to terminal `failed`/`unknown` (`interrupted_by_restart`) with an audit
  result event. Reconciliation runs only in the service that holds the
  data-directory lock (`service.lock`, exclusive `wx` creation with the
  owner's pid, taken by `start` before anything is opened, reconciled, or
  listened on, so a different port cannot bypass it; stale locks of dead
  owners are reclaimed), never on a bare store open.
- **Personal-tool limitations (accepted, documented in README):** one service
  process per data directory; the 10,000-event audit log is finite and
  continuing means a fresh data directory or manual archival; the audit log
  is not cryptographically tamper-evident; previews have no wall-clock expiry
  (a browser-session restart is the staleness boundary); a crash or lost
  answer may end as `failed` with an unknown mutation.

See README.md's "Phase 2, Action 1: open a URL in a new tab" for the full
contract, the UI behavior, and the verification status to update.

### Action 2 (create, rename, or recolor a tab group): complete

Action 2 reuses Action 1's decisions rather than reinventing them: the same
owner-only preview → decide-by-id-alone → execute-once → recorded, audited
result, in the same action store, state machine, and append-only audit log
(`kind` is now `open_tab` or `configure_group`; the audit still holds only
fixed server enums). It supports (1) a new group around exactly one chosen,
existing, ungrouped tab, optionally titled/colored, and (2) renaming and/or
recoloring an existing group; moving arbitrary selected tabs (Action 3) is not
offered. What is specific to it:

- **The preview binds the browser's own state.** The caller supplies an
  operation, one exact handle, and the requested title/color — never a
  session. The service asks the extension (read-only
  `browser.inspect_group_target`, no HTTP route) and binds the session from that
  answer plus the current state: the tab's window and that it is ungrouped and
  unpinned, or
  the group's window, title, and color. An update must actually change the title
  or color; `""` is the explicit clear-title value; colors are Chrome's native
  enum; titles are bounded plain text.
- **The extension revalidates immediately before mutating**
  (`browser.configure_group`): session, request shape, the bound state (no
  `await` between the re-read and the call), `tabs.group` and
  `tabGroups.update` at most once each, then the group is reported as read
  back. Vanished handle / moved state → `stale`, no mutation. A browser without
  `tabGroups`/`tabs.group` answers `unsupported_feature` without reading or
  changing anything (this is how the Firefox build behaves).
- **Honest outcomes**, same four states, with `mutation` now `none`,
  `created`, `updated`, or `unknown`: a partial outcome is a change that was
  made but whose title/color update or observation failed; a lost answer is
  `failed`/`unknown`; nothing is retried.
- **Protocol bumped to 4** (a version-3 peer lacks the method), database schema
  to 4 (migration v4 rebuilds `actions` to widen its constraints, keeping rows,
  ids, and the audit log).

Independent review found four issues, all fixed with regression coverage: the
create did not pass the tab's window to `tabs.group` (so a tab could move to the
current window — `createProperties.windowId` is now passed, and the smoke checks
a tab in a non-current second window stays put); pinned tabs were not refused
(now refused at preview and again at action time, since grouping could unpin or
reorder them); the review UI's chosen group target survived a replaced browser
session discovered by "Load windows" (now cleared, only on a real replacement);
and partial results were accepted with unrelated handles (a partial create must
name the preview's tab and window, a partial update its group and window and no
tab, else `failed`/`unknown`). The final gate passed `npm test` (587/587), a
clean dependency audit, version/build/lifecycle checks, the real Chrome for
Testing bridge smoke including the new two-window and pinned-tab cases, the
real Firefox smoke (tab groups cleanly unsupported), and Terra re-review with
no remaining blocker. See README.md's "Phase 2, Action 2: create, rename, or
recolor a tab group" for the contract, UI, assumptions, and limitations.

### Action 3 (move selected tabs into a group): complete

Action 3 again reuses the earlier actions' decisions: the same owner-only
preview → decide-by-id-alone → execute-once → recorded, audited result, in the
same action store, state machine, and append-only audit log (`kind` is now
`open_tab`, `configure_group`, or `move_tabs`; the audit still holds only fixed
server enums, with `moved` added to the result `mutation` values). The owner
selects 1–100 current, unpinned tabs in one window and moves them into one
existing group in that window or one new group (optionally titled/colored).
Renaming or recoloring a group stays Action 2's job; there is no archive or close
(Action 4). What is specific to it:

- **The preview binds the browser's own state for every tab.** The caller
  supplies exact tab ids and a destination — never a session, window, or current
  state. The service asks the extension (read-only `browser.inspect_move_target`,
  no HTTP route) and binds the session from that answer plus each tab's window,
  group membership, and pinned state (and an existing destination's window,
  title, and color). Pinned tabs, tabs in two windows, a destination in another
  window, missing handles, duplicates, out-of-bound lists, and a move that
  changes nothing are refused up front. The stored binding is only that bound
  state — tab ids and the group each is in, never a title or address — and each
  tab's source group is shown in the preview; a source group emptied by the move
  disappearing is the browser's own behavior, documented rather than reported as
  a change.
- **The extension revalidates every handle immediately before mutating**
  (`browser.move_tabs`): session, request shape, each tab's window/membership/
  pinned state, the destination group, then one `tabs.group` with the whole list
  (existing: `{groupId, tabIds}`; new: `{tabIds, createProperties: {windowId}}`)
  and, for a new group with a title/color, one `tabGroups.update`. Nothing is
  retried, and the group and each tab are read back. The browser has no atomic
  check-and-move, so that window is documented, not closed.
- **Truthful about what is known.** If the one `tabs.group` call rejects, or a
  new-group call resolves with no usable group id, the extension answers
  `changed: null` and the action is `failed` with mutation `unknown` — never
  `none` (it may have applied) and never `moved`. Once the call resolves with a
  usable group a move is known, and a partial result's `tabIds` says only which
  tabs were *observed* in the destination (null, or the ordered subset actually
  seen); only a full ok result says every tab was.
- **The service compares every returned handle with the binding.** An `ok` or
  `partial` answer naming other tabs (a partial's ids must be null or an ordered
  subset of the bound ones), another window, another group (for an existing
  destination), or another session is recorded `failed`/`unknown`.
- **Protocol bumped to 5** (a version-4 peer lacks the method), database schema to
  5 (migration v5 widens `actions` again, keeping rows, bindings, ids, and the
  audit log).

Terra's first review found three issues, all fixed with regression coverage: an
unknown effect was reported as "nothing changed" or "all moved" (now `changed:
null` → `failed`/`unknown`, and partial ids name only the observed subset);
display-only tab titles/addresses were persisted in move previews, which could
make 50 pending previews too large to list (now omitted from the stored
binding, with the maximum list tested under the response cap); and a per-list
UI refresh left a stale move selection (now "Load tabs" clears selection and
destination, while "Load groups" clears only the destination). The final gate
passed `npm test` (690/690), a clean dependency audit, version/build/lifecycle
checks, the real Chrome for Testing bridge smoke including Action 3, the real
Firefox smoke (tab groups cleanly unsupported), and Terra re-review with no
remaining blocker. See README.md's "Phase 2, Action 3: move selected tabs into
a group" for the contract, UI, assumptions, and limitations.

### Action 4 (archive a tab): complete

Action 4 again reuses the earlier actions' decisions: the same owner-only
preview → decide-by-id-alone → execute-once → recorded, audited result, in the
same action store, state machine, and append-only audit log (`kind` is now also
`archive_tab`; the audit still holds only fixed server enums, with `closed`
added to the result `mutation` values — never a URL, title, handle, session,
capture id, or error text). The owner archives exactly one current tab by
**first persisting a capture of it, then closing only that exact, still-matching
tab**. What is specific to it:

- **The preview binds the browser's own state for that one tab.** The body is
  exactly `{tabId}`; the session and everything else come from a read-only
  `browser.inspect_archive_target` (no HTTP route): the tab's window, its
  current address (a tab with none, or one too long to store whole, is refused —
  the close compares it for exact equality), its group, and its pinned state,
  plus its title for recognition only.
- **Capture first.** Approve first obtains a *fresh* `browser.read_tab` and
  requires the bound session, tab, and window (and, for a readable page, the
  bound address). A valid non-ok read — a protected page, a tab still loading,
  an error naming the tab's handles — is a capture of exactly that outcome and
  is saved through the existing capture validator, with no invented content.
  Because a non-ok read carries no address or state, a **final fresh
  `browser.inspect_archive_target`** — made after the read and immediately
  before the capture is saved — must show the tab still exactly as previewed
  (session, tab, window, address, group, pinned). Anything else (stale, moved,
  changed, failed, unusable, unsaveable, or a stale/unsupported/lost/malformed
  final check) ends the action with nothing saved and nothing closed. A change
  landing after that final check is an unavoidable cross-process gap: it is
  caught by the close, which keeps the capture and leaves the tab open.
- **Then one close, only after the capture is durable.** `browser.close_tab`
  carries the bound session, tab, window, address, group, and pinned state; the
  extension re-reads the tab and requires all of it to match — the address being
  the *effective* one, a non-empty `pendingUrl` (a navigation under way: Chrome
  keeps the committed address in `url`) in preference to `url`, used identically
  by inspection and by the close — then calls
  `tabs.remove` exactly once with no `await` between that check and the call.
  A rejected call is `changed: null` — effect unknown, because a rejection can
  follow the browser having closed the tab — recorded `failed` with mutation
  `unknown`; a resolved call is a closed tab (`executed`, mutation `closed`).
  Nothing is retried.
- **A saved capture is never discarded.** If the tab changed between the
  capture and the close (or the close was never sent), the result is `partial`
  with mutation `none` and the capture id, and the tab deliberately stays open;
  a lost or malformed reply after the close was sent is `failed`/`unknown` with
  the capture id. After a crash, reconciliation records `failed`/`unknown` with
  no capture id: the capture may have been saved and the tab may or may not have
  closed, and the review UI says exactly that ("a capture may have been saved")
  rather than "none saved".
- **Protocol bumped to 6** (a version-5 peer lacks the method), database schema
  to 6 (migration v6 widens `actions` again, keeping rows, bindings, ids, and the
  audit log). `tabs.remove` is a standard WebExtension API, so Firefox is not
  marked unsupported for it.

Status: complete. It is covered by deterministic extension, store, HTTP,
end-to-end, and UI tests and the extended real-Chrome bridge smoke (Step 2.11).
Terra's reviews found three blockers, all fixed with regression coverage: a
non-ok capture (no address) could be saved for a tab that changed since the
preview (now guarded by the final fresh inspection); the UI said "none saved"
for a crash-reconciled archive that may have saved a capture (now "unknown");
and Chrome's in-progress `pendingUrl` was ignored in favor of its old committed
URL (the effective address now prefers a non-empty pending URL in both
inspection and close checks). The final gate passed 786/786 automated tests, a
clean dependency audit, version/build/lifecycle checks, the complete real
Chrome for Testing bridge smoke, real Firefox and Brave regression smokes, and
Terra re-review with no remaining blocker. See README.md's "Phase 2, Action 4:
archive a tab" for the contract, UI, assumptions, and limitations. This is the
last action planned for Phase 2.

## Later work

These are intentionally outside the first two phases:

- Remote access, tunneling, and remote identity.
- Multi-user service hosting.
- Multiple simultaneous browser-profile routing.
- A built-in model provider or prompt-management system.
- Full-page DOM archives, screenshots, network capture, or console capture.
- Continuous background capture of every visited page.
- A replacement for the browser's history database or tab UI.

Each should begin with a concrete user need and its own privacy and threat
review.

## Current repository state

Phase 2 Actions 1–4 are complete on top of the completed Phase 1 described
below. Action 4's final gate passed 786/786 automated tests, a clean dependency
audit, version/build/lifecycle checks, the complete real Chrome bridge smoke,
real Firefox and Brave regression smokes, and independent Terra re-review after
all three findings were fixed; see "Action 4" above.
These are the only four browser mutations in the repository; the Phase 1
statements below that no mutation exists describe Phase 1 as it was completed
and are otherwise unchanged. `PROTOCOL_VERSION` is now `6` and the database
schema version `6`.

The repository contains a stabilized Manifest V3 inspector (Stage 0, below)
and an implemented Stage 1 local bridge: a Node.js service (`service/`)
bound to loopback, an extension-owned WebSocket connection authenticated
with a locally-generated credential, an authenticated ping/pong heartbeat
plus a `chrome.alarms` backstop for waking a terminated worker, and one
authenticated HTTP route (`browser.list_windows`), since extended by Stage 2
(below) into a complete bounded read API covering windows, tabs, tab
groups, page-text snapshots, browsing history, and capabilities. There is
still no review UI or browser mutation (Stage 4+); a derived store has
since been added by Stage 3, documented just below. Stage 1
has been exercised repeatedly against
a real Chrome for Testing browser via `test/smoke/stage1-bridge-smoke.mjs`,
with real defects found and fixed as a direct result (see git history), and
that smoke test passes on the current revision — see "Verification status"
in the Stage 1 section of README.md for the full evidence.

Stage 3 (the derived store) has been implemented against this revision:
`service/store.mjs` adds a service-owned SQLite database (Node's built-in
`node:sqlite`, no ORM) created on first start and migrated forward via a
tracked `schema_migrations` table, with `foreign_keys`, `journal_mode`, and
`secure_delete` all explicitly set *and verified by reading them back* on
every connection. `service/validation.mjs` deeply validates every
trust-boundary input before it reaches a SQL statement — captures
specifically reuse `extension/protocol.js`'s own `validateMethodResult`, so
a capture is a validated Stage 2 `browser.read_tab` result, never a
caller-invented shape. `service/store-errors.mjs` normalizes database-layer
failures into a small set of stable codes, always after an explicit
transaction rollback. `service/store-routes.mjs` and routing in
`service/server.mjs` expose explicit, authenticated, protocol-versioned,
response-size-bounded `store.*` CRUD routes (captures, summaries, tags,
collections with ordered membership, queue items, proposals, retention
settings/cleanup, and a single clear-everything operation that also removes
backup files and uses `secure_delete` plus `VACUUM` to remove cleared
content from its managed live database file) — see README.md's "Stage 3: the derived
store" section for the full route table, deletion-semantics documentation,
and decision-provenance documentation. `service/cli.mjs` opens the store on
`start` and runs retention cleanup once automatically, as two independently
try/caught steps (a cleanup failure is never misreported as "store
unavailable"); opening the store is deliberately best-effort — a Node.js
runtime without `node:sqlite` still runs the unaffected Stage 1/2 bridge.
No extension/protocol.js, service-worker.js, or service-client.js changes
were needed; the extension remains a browser adapter only, unaware this
store exists.

An independent review of the first Stage 3 implementation found eight
concrete issues (captures accepting caller-invented shapes; cascade/
retention deletion ordering failing on a capture→summary→proposal chain;
`store.clear` not performing a secure delete or removing backups; WAL
risking an incomplete backup; two NULL-distinct-prone uniqueness indexes;
a reorder temporary-position collision risk; a silently-coerced `cascade`
boolean; an unbounded queue-state filter; proposal decisions recording no
decider; and store responses not being size-bounded) — all addressed in
this revision, each with a regression test; see README.md's "Known-fixed
issues" subsection for the itemized list and `test/store.test.mjs`/
`test/store-routes.test.mjs` for the tests, which also now cover the real
breaking-migration backup path (against the production migration list, via
a narrow test-only parameter on the exported `runMigrations`), a
WAL-origin backup-completeness regression, nested/overlapping cascade
deletion, a log-leakage check, and a real separate-process restart
persistence test (`service/cli.mjs` start/stop), not only an in-process
close/reopen. `package.json` now declares `engines.node: ">=24.0.0"` and
no script passes `--experimental-sqlite`, removing the previous
inconsistency between `npm test` and `npm run test:store`.

A second, independent review found seven more concrete issues (`store.clear`
not running `VACUUM`, so content deleted under an earlier secure_delete-OFF
connection could still be physically present in the live file; migration
v2 only ever remediating today's already-corrected v1 schema in its own
test rather than the actual pre-remediation legacy one; `store.captures.create`
returning a capture's full, unbounded `text`, risking a commit-then-
response_too_large outcome on a pathological maximum-length input; a
non-"ok" capture accepting and persisting invented "ok"-only fields; no
route to inspect a capture's full text after its one-time create response;
and tag-assignment listing accepting a partial recordType/recordId filter)
— all addressed in this revision, each with a regression test; see
README.md's "Known-fixed issues" subsection for the itemized list. This
pass also corrected the erasure claim itself: `store.clear` (and this
project's documentation of it) is now explicit that it erases content only
from this application's own managed database and backup files, not a
guarantee against physical-machine forensic recovery. `package-lock.json`'s
root `engines` field was updated by hand to match `package.json`'s
`>=24.0.0`; the orchestrator regenerated it with `npm install
--package-lock-only`.

A third, independent review found three more concrete issues
(`store.captures.delete`/`store.summaries.delete` with `cascade=true` and
`store.clear` returning unbounded cascaded-id/removed-backup-filename
arrays rather than bounded counts, risking a commit-then-
`response_too_large` outcome on a capture or summary with many real
dependents; a non-"ok" capture's "ok"-only-field rejection checking the
normalized value rather than the original request body, so an explicit
`null` on a forbidden field passed unnoticed; and the cascade/retention
dependency computation building an unbounded SQL `IN (...)` placeholder
list sized to however many capture or summary ids were involved) — all
addressed in this revision, each with a regression test, including an
HTTP adversarial regression (many real dependents against a deliberately
tiny `maxResponseBytes`, proving both a `200` response and that the
delete actually committed) and a real, physically reproduced WAL-mode
backup-incompleteness regression; see README.md's "Known-fixed issues"
subsection for the itemized list.

**Stage 3 verification:** the orchestrator ran `npm test` (252/252 passing),
`npm run test:store` (73/73 passing), `npm audit --omit=dev` (no
vulnerabilities), syntax and diff checks, and both real Chrome for Testing
smoke suites against this revision. Independent Terra review passed after
the remediation rounds. The Stage 3 checklist above is complete.

Stage 2 (the read API) has been implemented, remediated against a round of
review findings, and verified against this revision:
`extension/service-worker.js` exposes `browser.list_tab_groups`,
`browser.query_history`, and `browser.get_capabilities` alongside the
existing `browser.list_windows`/`browser.list_tabs`/`browser.read_tab`, all
wrapped in a shared capture-provenance envelope (`schemaVersion`,
`browserSessionId`, `sourceOperation`, `capturedAt`, `status`). The
remediation pass: bumped `PROTOCOL_VERSION` to `2` (a breaking response-shape
and session-requirement change) and added `validateMethodResult` in
`extension/protocol.js`, which `service/server.mjs` uses to reject a legacy
array, a wrong-method, or any other malformed extension response as
`invalid_extension_response` rather than ever forwarding it as trustworthy;
added a `browserSessionId` requirement (persisted via
`chrome.storage.session`, which the browser itself clears on restart, with a
tested non-persisted fallback where that API is absent) that
`list_tabs`/`list_tab_groups`/`read_tab` validate as `stale_session` before
resolving any numeric handle, and re-ordered `list_tab_groups` to validate
the session and window handle *before* its capability check; replaced
`service/server.mjs`'s route object with a `Map` so a method name colliding
with `Object.prototype` (`toString`, `__proto__`, ...) 404s instead of
risking misuse, with parameter extraction and envelope validation both
guarded against throwing; fixed an empty numeric query value (`?windowId=`)
from silently coercing to `0` via `Number("")`; replaced `query_history`'s
lossy timestamp cursor with a bounded offset cursor over a deterministic
sort (tie-broken by the browser's own per-URL id), with an explicit
`incomplete`/`pagination_limit_reached` outcome when its scan ceiling is
reached before a full page can be determined; validated the injected
snapshot result's shape in `readTab` before accessing its fields (a
malformed result is now an explicit `invalid_extension_response`, never a
rejected promise), and added a `.catch` in `extension/service-client.js` so
a `routeMessage` rejection still produces an explicit error response instead
of only a timeout; set the WebSocket server's `maxPayload` consistent with
the response-size boundary, with an explicit `error` handler so an oversized
inbound message cannot crash the service; and corrected several
Firefox-related comments to runtime-capability language rather than a
blanket "Firefox lacks X" claim. See README.md's "Stage 2: the read API"
section for the full route/bounds/provenance/session documentation.
Unit/integration tests were extended accordingly across
`test/protocol.test.mjs`, `test/service-worker.test.mjs`,
`test/service-client.test.mjs`, and `test/bridge.test.mjs`, and
`test/smoke/stage1-bridge-smoke.mjs`/`test/smoke/chromium-smoke.mjs` were
extended for the session requirement and the additional scenarios (a real
harness-created tab group, two-entry paginated history, a deliberately
slow-loading page, a best-effort discarded-tab assertion, and
browserSessionId rotation/rejection across a full browser restart). **All of
this has since been executed**: `npm install`, `npm test`,
`npm run test:smoke`, `npm run test:smoke:bridge`, and `npm audit` have all
been run against this revision — see "Current verification status" below
for the results. Stage 2's checklist is now checked accordingly.

A further remediation pass fixed five remaining issues found while this was
still unverified (since resolved, see below): (1) `query_history`'s offset-cursor redesign itself had a latent
consistency bug — each page requested a *page-size-dependent* amount
(`offset + pageSize + 1`) from `chrome.history.search`, and that API's
tie-breaking for entries sharing the exact same `lastVisitTime` is not
guaranteed stable across differently-sized requests, so two pages could in
principle duplicate or skip a tied entry. Fixed by always re-fetching the
same bounded `MAX_HISTORY_SCAN`-sized set for a given range and sorting that
one set deterministically before slicing, with an explicit
`incomplete`/`pagination_limit_reached` outcome when the browser has at
least that many matching entries and a page's end reaches the scanned
boundary; a new regression test uses three same-timestamp entries returned
by the browser in scrambled order (`[c, b, a]`) and proves three sequential
pages return them as distinct, deterministic entries. The only remaining,
intentionally undocumented-as-a-bug limitation is that history changing
*between* two page requests can still make them inconsistent with each
other — inherent to stateless pagination over a live data source.
(2) `MAX_WS_MESSAGE_BYTES` was previously derived from `MAX_RESPONSE_BYTES`
(2 MiB) plus a small fixed margin, which could reject a fully legitimate,
bounded `browser.read_tab` result at the transport layer before the service
ever got to evaluate and report it as `response_too_large` — worst-case JSON
escaping of `MAX_TEXT_CHARACTERS` (500,000) characters alone can serialize
to roughly 2.9 MB. Changed to an independent, larger constant (8 MiB), with
new tests proving a response above 2 MiB but below 8 MiB still reaches the
service and is reported `response_too_large`, while one above 8 MiB is
rejected at the transport layer instead. (3) `validateMethodResult` was
deepened considerably: `capturedAt` must be non-negative; every list
(`windows`/`tabs`/`groups`/`entries`) now has each of its own records
validated against the corresponding `normalize*` output shape, not merely
"it is an array"; `returnedCount` must equal the actual array length and
`totalCount` must be at least `returnedCount`; `read_tab`'s `url`/`title`
are nullable strings, and its `returnedCharacterCount`/`characterCount`/
`truncated` must be mutually consistent (exact length match, full count
never less than returned, and the truncation flag exactly reflecting
whether any characters were actually cut); `query_history`'s `startTime`/
`endTime`/range and per-entry records are checked; and
`get_capabilities`'s `protocolVersion` and `max*` bound fields are now
required and type/range-checked. (4) The real-browser discard-tab smoke
scenario previously ran its read_tab assertion *inside* the same try/catch
guarding the discard request itself, so a malformed/failed read_tab result
after a confirmed discard was logged as "non-fatal" instead of failing the
smoke; the catch now covers only the request/confirmation of the discard,
and the assertion runs unguarded once a discard is confirmed. (5) A stale
`protocolVersion: 1` example in README.md's "Calling the API" section (left
over from the Stage 2 protocol bump) was corrected to `2`, and the
"Bounds"/"History pagination"/"Verification status" prose was brought in
line with the above; project.md's Stage 2 checklist is now checked (see
below).

The injected snapshot function no longer depends on module lexical scope: the
text limit is passed into it as an argument, so it runs correctly once the
browser serializes it into the target tab. As of the last revision actually
verified (before the Stage 2 work above), `npm test` passed 84/84, covering
Stage 0's record normalization, page-text extraction (successful snapshots,
missing bodies, CRLF normalization, character counts, truncation), the
service worker's `readTab`/`listTabs`/`listWindows` functions, and the
registered `runtime.onMessage` listener's routing and error responses, plus
Stage 1's own test files (`test/credential.test.mjs`,
`test/service-client.test.mjs`, `test/bridge.test.mjs`,
`test/cli.test.mjs`); `npm run test:smoke` and `npm run test:smoke:bridge`
also passed against a real Chrome for Testing browser, and `npm audit`
reported no vulnerabilities. The Stage 2 changes above grew and changed the
shape of every one of those test files' assertions (the envelope fields are
additive but change exact `deepEqual` shapes); `npm test` was
re-run at the Stage 2 publication checkpoint and passed 179/179 (see
"Stage 2 checkpoint verification" below for the full evidence).

### Stage 2 checkpoint verification

Verified at the Stage 2 publication checkpoint:

- `npm test`: 179/179 passing, covering Stage 0 and Stage 1's existing
  coverage plus Stage 2's envelope validation, session handling, history
  pagination, and response-bound regressions described above.
- `npm audit`: no vulnerabilities reported.
- `npm run test:smoke` (Stage 0, Chromium): `SMOKE_PASS`, against a real
  Chrome for Testing browser.
- `npm run test:smoke:bridge` (Stage 1 + Stage 2, Chromium), expanded for
  Stage 2: `SMOKE_PASS`, against a real Chrome for Testing browser and a
  real service process, proving `browser.get_capabilities`,
  windows/tabs enumeration, a real harness-created tab group, bounded
  page-snapshot outcomes (`ok`, `unsupported`/protected, `stale_handle`,
  `not_ready`/`tab_loading`, and a best-effort discarded-tab case),
  paginated `browser.query_history`, capture-provenance fields on every
  result, `browserSessionId` rotation across a full browser restart and
  `stale_session` rejection of a pre-restart session id, and the
  service-boundary response-size/rate bounds. No mutation API is exposed by
  any route exercised.

Honest limits that remain, unchanged by this verification pass:

- Firefox parity is still Stage 6, not Stage 2; `tabGroups` support is
  feature-detected, not implemented for Firefox.
- History pagination is only consistent within a single, unchanging history;
  if history mutates between two page requests, those two pages can still be
  inconsistent with each other (see "History pagination" above).
- Reaching `MAX_HISTORY_SCAN` within a page's scan window produces an
  explicit `incomplete`/`pagination_limit_reached` outcome rather than a
  silently wrong page.
- The discarded-tab smoke scenario is best-effort: whether the browser has
  actually discarded the tab by the time it's read depends on the browser's
  own memory-pressure/wake behavior, so a passing run may observe either the
  discarded outcome or `status: "ok"` if the browser chose not to discard it.

Completed foundation (Stage 0):

- [x] Manifest V3 extension skeleton.
- [x] Window and tab normalization helpers.
- [x] Explicit snapshot schema version and status field.
- [x] Bounded-response intent and truncation metadata.
- [x] No browser mutation operations.
- [x] Page-snapshot injection fixed to run correctly in a real browser tab.
- [x] Unit test coverage for page extraction, the service worker, and the
  registered message listener.
- [x] Repeatable Chromium smoke test, verified against Chrome for Testing.
- [x] Dependency-free Node.js unit-test command for Stage 0's own test
  files. (Stage 1 added the `ws` runtime dependency — see its README
  section — so the *overall* `npm test` now requires `npm install` first;
  Stage 0's own files still need nothing beyond `node:test`.)

Stage 4 (the external-agent workflow) has been implemented against this
revision, including a remediation pass after an independent (Terra) review
found the first implementation was "client-only theater": there was no
real trust-boundary distinction between an "agent" caller and the owner —
a single shared credential granted full access either way, and the
reference client's own generic `call(method, ...)` escape hatch meant any
caller could reach `store.captures.create` (forging arbitrary "evidence")
or `store.proposals.update` (self-approving a proposal) merely by not
using the narrower convenience methods.

The fix is a real, server-side trust boundary:
`service/credential.mjs` manages a second, independently-generated,
`0600`-permissioned credential file (`agent-token`, distinct from the
owner's own `credential` file) via `loadOrCreateAgentCredential`;
`service/server.mjs`'s `createService` accepts it as `agentCredentialToken`
and `authenticate(req)` reports whether a request carries `"owner"` or
`"agent"` scope. Agent scope is restricted to three explicit allowlists
(`AGENT_ALLOWED_BROWSER_METHODS`/`_WORKFLOW_METHODS`/`_STORE_METHODS`),
checked before dispatch; anything else is `403 forbidden_scope`, including
`/control/stop` and every `store.*` mutation route except
`store.summaries.create`/`store.proposals.create`. A new operation,
`workflow.capture_tab`, is the *only* capture-creation path agent scope
can reach: it takes no request body at all — the service performs the
real `browser.read_tab` round trip itself and persists exactly that
result — so an agent caller cannot forge stored browser evidence no
matter what JSON it sends, because there is no route that accepts one.
For every agent-scoped write, the server discards whatever
`creatorType`/`creatorName` the request body claims and substitutes a
fixed, server-controlled external-agent identity, unconditionally.
`client/browser-tabs-client.mjs` was narrowed to match: it now exports
`BrowserTabsAgentClient` with no generic `call()`, no `createCapture`, no
proposal-decision method, no `creatorType`/`creatorName` parameter
anywhere, strict loopback-only `baseUrl` validation, `redirect: "error"`
on every fetch, full response-envelope validation (protocolVersion, exactly
one of result/error, matching request id), and deeply bounded,
finite-integer/plain-object input validation throughout; `client/cli.mjs`
dispatches only through that same method allowlist, reads its (agent)
credential via a bounded `open`/`stat`/`read` sequence rather than
`readFile`'s whole-file read, and reads its request document the same
bounded way.

`test/credential.test.mjs` now also covers the agent credential's
independent lifecycle (distinct file/value, same race-safe/crash-safe/
permission-repairing behavior as the owner's). `test/scoped-auth.test.mjs`
is new: real-HTTP integration tests proving the full allowlist (every
agent-allowed route, a long list of explicitly forbidden ones, a 404 for
an unknown route regardless of scope, the agent token rejected by the
extension's own WebSocket auth, and the creator-identity override).
`test/stage4-e2e.test.mjs` is the deterministic end-to-end example,
rewritten to use `BrowserTabsAgentClient` exclusively for the agent side
(no direct `store.captures.create`/generic calls), with the captured page
text itself embedding an adversarial instruction, and with all
final-state assertions (proposal still pending, no collection exists)
made through the **owner's** own public HTTP API, not a direct store
call. `test/client.test.mjs` was rewritten for the new class's contract
and bounds. `test/smoke/stage1-bridge-smoke.mjs` (the real Chrome for
Testing smoke test) was extended with a new Step 2.6 exercising this same
workflow against a real browser tab and a real, separately-printed agent
credential — see README.md's "Real-browser bridge smoke test" section.

See README.md's "Stage 4: the external-agent workflow" section for the
full contract, allowlist table, threat/provenance documentation, and
usage.

**Stage 4 verification:** the orchestrator ran `npm test` (295/295
passing), the focused client/scope/workflow suite (39/39 passing),
`npm audit --omit=dev` (no vulnerabilities), syntax and diff checks, and
the expanded real Chrome for Testing bridge smoke. The smoke captured a
real page containing an adversarial instruction, created a scoped-agent
summary and pending collection proposal, and verified through the owner's
public API that no collection or browser mutation occurred. Independent
Terra review found the original client-only trust boundary insufficient;
its findings were remediated with the scoped server credential/allowlist,
server-issued capture path, strict client transport, and subsequent
hardening tests. The Stage 4 checklist above is complete.

Stage 5 (the local review UI) is implemented and verified against this
revision; see README.md's "Stage 5: the local review UI" section for the
full description. `service/ui.mjs` serves five exact, fixed paths (`/ui/`,
`/ui/index.html`, `/ui/app.js`, `/ui/lib.mjs`, `/ui/styles.css`) from an
explicit `Map` of path -> file
content read once at module load — never a generic static-file server
walking a caller-supplied path — with a restrictive
`Content-Security-Policy` (`default-src 'none'`, script/style/connect only
`'self'`, `frame-ancestors 'none'`, no `unsafe-inline`/`unsafe-eval`),
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`X-Frame-Options: DENY`, and `Cache-Control: no-store` on every asset
response; `service/server.mjs`'s request handler now resolves the request
URL and serves a matching UI asset *before* its existing
`X-Protocol-Version` check, since ordinary browser navigation never sends
that header, while every other existing route (`/health`, `/control/stop`,
`/api/*`) is unaffected and unmoved. `ui/index.html`/`ui/app.js`/`ui/lib.mjs`/`ui/styles.css` are plain,
dependency-free static files (no build step,
no framework): every browser- or derived-record-owned string (titles,
URLs, captured text, summary text, proposal rationale/payload, tag/
collection names, ...) is rendered via `textContent` only through a small
DOM-builder helper — the file never assigns `innerHTML`/`outerHTML` and
never calls `document.write`/`eval`/`new Function` anywhere, and there is
no inline `<script>` body, inline `<style>` block, or inline
event-handler attribute in the page; every interaction is wired up via
`addEventListener`. The owner token is obtained only via an explicit
password-type input validated against the extension-independent, owner-only
`owner.status` route, held only in an in-page JavaScript variable for as long as the page stays
open (never the URL, `localStorage`, `sessionStorage`, a cookie, or a log
statement), and discarded on reload or an explicit "Disconnect"; the page
explains that Stage 4's separate, more restricted external-agent token
does not work here. No new `store.*`/`browser.*` route was added — every
action the page takes (listing windows/tabs/groups, `workflow.capture_tab`
for an explicitly selected tab, paginated `browser.query_history` with
visible complete/truncated/incomplete status, the existing bounded
`store.captures.read` chunked-text route for capture detail, and the
existing `store.*` list/delete/update routes) already existed from Stage
2–4; only the five static-asset routes and owner-scope probe are new. Proposals show
Accept/Reject buttons only while `state === "pending"`; clicking either
disables both immediately (preventing a double submit), calls the
owner-only `store.proposals.update` with the decision and
`creatorType: "user"` as its own provenance, and then re-fetches the
proposals list from the service rather than optimistically updating the
clicked row locally, so the confirmed state shown is always the server's,
never a local guess — nothing here ever applies a proposal's own
suggested change. `test/ui.test.mjs` is new (route/header/traversal/
no-log-leakage integration tests over a real `createService`, plus static
source scans of the actual shipped UI files for the properties above);
`test/smoke/stage1-bridge-smoke.mjs` gained a new Step 2.7 that seeds a
fresh capture/summary and two fresh pending proposals through the scoped
Stage 4 external-agent credential, opens the real `/ui/` page in Chrome
for Testing, drives it via CDP `Runtime.evaluate` (setting the token
field's value and calling `.click()` on the page's own buttons — the same
technique this harness already uses for every other browser action), and
confirms both an accept and a reject decision through the **owner's**
own public HTTP API plus the seeded tab's continued, unmutated existence.

An independent (Terra) review of that first Stage 5 implementation found
seven concrete issues, all addressed in this revision (see README.md's
"Remediation round (Terra findings)" under "Stage 5: the local review UI"
for the itemized list and full description of each fix): (1) no
Host-header defense against DNS rebinding — `service/server.mjs`'s new
`checkHost` now rejects any request (UI, `/health`, `/control/stop`, every
`/api/*` route, and the extension WebSocket upgrade) whose `Host` header
is not exactly `127.0.0.1:<the port this connection is actually being
served on>`, with a distinct `421 invalid_host`, checked before anything
else; (2) the Connect flow depended on `browser.get_capabilities`, which
round-trips through the extension (failing whenever it is disconnected)
and is agent-allowed, so it neither worked while disconnected nor actually
distinguished an owner token from an agent one — fixed with a new,
extension-independent, owner-only `GET /api/owner.status` route, which
Connect now uses first, with `/health` read immediately afterward as a
separate fact; (3) `browserSessionId` handling was loose about where it
could be adopted from and did not handle staleness explicitly — fixed so
only a fresh `browser.list_windows` result may ever set it, and any
`stale_session` outcome now tears down the entire windows/tabs/groups/
capture-button tree and requires an explicit fresh "Load windows"; (4) no
protection against async races (disconnect-during-request, a superseded
capture-detail selection, an older list refresh overwriting a newer one)
— fixed with `ui/lib.mjs`, a small native-ES-module (no framework, no
build step) set of pure, DOM-free primitives (`createGenerationCounter`,
`createListVersionGuard`, `createDecisionTracker`), deterministically unit
tested with no browser at all in `test/ui-lib.test.mjs`, and threaded
through every async handler in `ui/app.js`; (5) proposal decisions had no
dedicated in-flight/committed tracking outside the rendered row and did
not distinguish a retryable PATCH failure from an already-committed
decision whose confirmation reread then failed — fixed via
`createDecisionTracker`, a manual-refresh lockout while any decision is
submitting, and a `createListVersionGuard`-backed `store.proposals.list`
refresh; (6) tags had no assignment view at all — fixed with a per-tag
"Load assignments" control calling the already-existing (but previously
unused by this UI) `store.tags.assignments.list`; (7) accessibility gaps
— dynamically created per-row status elements were not ARIA live regions,
and no focus was moved on the capture-detail panel appearing or the
proposals list re-rendering — fixed with a shared `role="status"
aria-live="polite"` helper and explicit `.focus()` calls to
`tabindex="-1"` headings. `test/host-defense.test.mjs` and
`test/owner-status.test.mjs` are new; `test/ui.test.mjs` and
`test/smoke/stage1-bridge-smoke.mjs`'s Step 2.7 were both extended
(the latter gained a deterministic, real-browser connect/disconnect race
check — synchronous back-to-back clicks, not timing, make it
deterministic — proving a stale `browser.list_windows` response can never
repopulate the UI after Disconnect).

**Stage 5 verification:** the orchestrator ran `npm test` (331/331
passing), the focused UI/security suite, `npm audit --omit=dev` (no
vulnerabilities), syntax and diff checks, and the expanded real Chrome for
Testing bridge smoke. The smoke drove owner authentication, proposal
acceptance and rejection with confirmed rereads, and a disconnect race
through the shipped UI. Independent Terra review findings were remediated;
the Stage 5 checklist above is complete.

Stage 6 and Phase 1 are complete at this revision. The browser-specific
boundary now produces Chrome and Firefox packages from the shared extension
source. Firefox uses a classic `background.scripts` bundle, omits the
unsupported `tabGroups` permission, allows only the fixed loopback WebSocket
in its extension-page CSP, and reports tab-group support through the existing
capability API. The bridge accepts both Chrome and Firefox extension origins;
all other origins still fail.

The release path now includes deterministic, checksummed Chrome, Firefox, and
source archives; deliberate product/protocol/result/database version checks;
a cross-platform service lifecycle check; and CI jobs for macOS, Linux, and
best-effort browser smoke tests. Release files come from explicit allowlists,
never include local credentials or databases, and are byte-identical for the
same source. Custom output paths are bounded and replace stale output only
after artifact construction succeeds.

Verification completed on this revision: 381/381 unit and integration tests,
`npm audit --omit=dev`, version/build/release checks, macOS and Linux-container
service lifecycle checks, real Firefox read/capture/review workflow, real
Chrome for Testing read and full bridge/restart workflow, and the shared read
smoke (only) in Brave as the additional Chromium-family browser — the long
bridge smoke is canonical on Chrome for Testing and hung under Brave, so
Brave is not claimed to support the full bridge workflow. Firefox-specific
transport and packaging failures found during the first run were fixed: the
default MV3 CSP had upgraded the loopback `ws://` connection, and the options
page needed its imported local modules included in the Firefox package. Terra
review also drove credential-safe failure diagnostics, deterministic dirty-
output replacement, and release-path containment before publication.

## Definition of done for any stage

A stage is complete only when:

- [ ] Its acceptance checks run from a clean checkout.
- [ ] New trust-boundary inputs are validated.
- [ ] Browser-derived values retain provenance and remain untrusted.
- [ ] Failure behavior is explicit and tested.
- [ ] User documentation matches the implemented behavior.
- [ ] No credential, captured page content, or local database is committed.
- [ ] The smallest relevant end-to-end path has been exercised in a real
  browser.
