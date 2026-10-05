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

- [ ] Publish a compact client contract for listing sources, reading captures,
  and writing summaries and proposals.
- [ ] Provide one small reference client or CLI flow using the same public API
  as other callers.
- [ ] Require source IDs on summaries and proposals.
- [ ] Preserve caller-supplied model and prompt metadata without treating it as
  trusted browser evidence.
- [ ] Prevent proposals from invoking extension methods or changing approval
  policy.
- [ ] Add an end-to-end example: capture selected tabs, attach summaries, and
  propose collections without changing the browser.

Exit criteria:

- [ ] A caller can complete the example using only documented API operations.
- [ ] The resulting records identify browser facts, derived text, provenance,
  and proposal state separately.
- [ ] Malicious instructions inside captured page text cannot create a new API
  method or mark a proposal approved.

### Stage 5 — Local review UI

The service hosts a small web interface. It is a review surface, not a second
browser or a general agent console.

Implementation:

- [ ] Show service and extension connection state.
- [ ] Show windows, tabs, groups, and capture status without polling unbounded
  browser state.
- [ ] Let the user choose which tabs to capture.
- [ ] Show captured text with URL, timestamp, truncation, and unsupported-state
  details.
- [ ] Show summaries, tags, queues, and collections alongside their sources.
- [ ] Show proposals as proposals, including creator, rationale, evidence, and
  pending/rejected/accepted state.
- [ ] Allow editing or deleting derived records and clearing stored captures.
- [ ] Meet basic keyboard, focus, contrast, labeling, and reduced-motion
  accessibility requirements.
- [ ] Escape untrusted text and use a restrictive Content Security Policy.

Exit criteria:

- [ ] A user can tell what came from the browser, what was inferred, and by
  whom.
- [ ] The primary capture-and-review flow works with keyboard navigation.
- [ ] Rendering captured page text cannot execute markup or script.
- [ ] Accepting a Phase 1 proposal changes only derived service data.

### Stage 6 — Firefox parity and local release

Chromium establishes the vertical slice; Firefox parity closes Phase 1.
Browser-specific code should remain at the extension API boundary.

Implementation:

- [ ] Run the read API and review workflow in current Chrome and Firefox.
- [ ] Test at least one additional Chromium browser without adding a separate
  implementation for its brand.
- [ ] Isolate tab-group differences behind capability reporting.
- [ ] Document installation, pairing, startup, upgrade, backup, reset, and
  uninstall behavior on macOS.
- [ ] Verify that the service runs on Linux even if desktop packaging remains
  a later task.
- [ ] Add continuous unit tests and repeatable browser smoke-test commands.
- [ ] Version the extension, service, API, and database schema deliberately.
- [ ] Produce checksummed local release artifacts.

Phase 1 completion checklist:

- [ ] A clean Mac installation reaches the review UI using documented steps.
- [ ] Chromium and Firefox can list supported browser state and capture pages.
- [ ] History, captures, derived records, and proposals retain provenance.
- [ ] All payloads and queries have tested bounds.
- [ ] Authentication and origin checks protect the loopback service.
- [ ] The user can inspect and erase locally retained data.
- [ ] No browser mutation API is exposed.
- [ ] Automated tests pass and the manual release checklist is recorded.

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

- [ ] Define preconditions, preview data, approval state, and result data for
  the first action.
- [ ] Require an explicit user decision immediately before execution.
- [ ] Revalidate browser-session and tab handles after approval.
- [ ] Report partial failure and the exact observed final state.
- [ ] Keep an append-only local action audit record.
- [ ] Add one action at a time with browser integration tests.
- [ ] Do not add arbitrary navigation, page evaluation, cookie export, or
  debugger access as shortcuts.

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
