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

- Every request has a protocol version, request ID, named method, and validated
  parameters.
- Every response repeats the request ID and contains either a typed result or
  a stable error code with optional diagnostic detail.
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

- [x] `npm test` passes from a clean checkout. (29/29 passing.)
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

- [ ] Add a service entry point with explicit `start`, `status`, and `stop`
  behavior suitable for development.
- [ ] Bind HTTP and WebSocket listeners to loopback only.
- [ ] Generate a local service credential and store it with user-only
  permissions.
- [ ] Pair the extension with the service without embedding a credential in
  source control or the extension package.
- [ ] Authenticate the extension WebSocket and local API requests.
- [ ] Implement connection state, request correlation, timeouts, and bounded
  reconnect backoff.
- [ ] Route `browser.list_windows` from an HTTP client through the service and
  extension, then return the typed result.
- [ ] Expose a health endpoint that reports service and extension connectivity
  without exposing browser content.
- [ ] Document local setup and recovery when the extension or service is
  unavailable.

Checkpoint:

Manifest V3 background lifetimes differ between browsers. If a quiet
WebSocket cannot remain reliable without artificial keepalive traffic, keep
the service API and protocol but replace the extension bridge with the
smallest reliable platform-supported transport. Do not build both transports
in advance.

Exit criteria:

- [ ] A fresh local client can discover whether the service and extension are
  ready.
- [ ] An authenticated request completes across the full path.
- [ ] Missing credentials, bad origins, timeouts, and disconnects fail
  explicitly.
- [ ] Service restart and extension restart recover without reinstalling or
  losing the pairing.

### Stage 2 — Complete the read API

Once the bridge is proven, expose the browser information needed by the first
useful workflow.

Implementation:

- [ ] Enumerate windows with focused state, type, state, and tab count.
- [ ] Enumerate tabs with window ID, index, active, pinned, audible, discarded,
  loading status, title, and URL.
- [ ] Enumerate tab groups where the browser supports them and report the
  capability where it does not.
- [ ] Read bounded rendered-text snapshots from the main frame.
- [ ] Include URL, title, document readiness, capture time, full character
  count, returned character count, truncation, and capture status.
- [ ] Query browsing-history metadata separately from open tabs with explicit
  time ranges, result limits, and pagination.
- [ ] Add a capability response so clients do not infer browser features from
  brand names.
- [ ] Reject stale tab and window handles rather than silently targeting a
  replacement.
- [ ] Apply conservative response-size and request-rate bounds at the service
  boundary.

Exit criteria:

- [ ] A client can distinguish open tabs, historical visits, and captured page
  text.
- [ ] Every returned browser-derived value carries capture provenance.
- [ ] Protected, discarded, loading, closed, and ordinary pages have tested
  outcomes.
- [ ] No API response is unbounded.

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

- [ ] Create the SQLite database on first service start.
- [ ] Add migration tracking and back up the database before incompatible
  migrations.
- [ ] Store source records before accepting derived records that reference
  them.
- [ ] Enforce foreign keys and reject references to missing sources.
- [ ] Record whether each derived value came from the user, a named local
  client, or an external agent.
- [ ] Add explicit create, list, update, and delete operations only for the
  records required by the review workflow.
- [ ] Add retention settings and a single operation to clear captured and
  derived data.
- [ ] Keep credentials and browser content out of logs by default.

Exit criteria:

- [ ] Restarting the service preserves records and provenance.
- [ ] Deleting a source has documented, tested behavior for derived records.
- [ ] A user can inspect and clear all locally retained browser content.
- [ ] Database failures do not corrupt or silently discard existing records.

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

The repository contains a small, stabilized Manifest V3 inspector. It
normalizes extension-visible windows and tabs and reads bounded rendered text
from a tab when script injection is permitted. It has no network service,
derived store, review UI, browser-history query, tab-group support, or browser
mutations.

The injected snapshot function no longer depends on module lexical scope: the
text limit is passed into it as an argument, so it runs correctly once the
browser serializes it into the target tab. Unit tests (29/29 passing) cover
record normalization, page-text extraction (successful snapshots, missing
bodies, CRLF normalization, character counts, truncation), the service
worker's `readTab`/`listTabs`/`listWindows` functions, and the registered
`runtime.onMessage` listener's routing and error responses. A real-browser
smoke test additionally loads the unpacked extension in Chrome for Testing
and, through the extension's actual `runtime.onMessage` entry point, confirms
window listing, tab listing, and reading an ordinary page, plus that a
protected page returns an explicit `unsupported`/`injection_rejected` result
rather than empty content.

Completed foundation:

- [x] Manifest V3 extension skeleton.
- [x] Window and tab normalization helpers.
- [x] Explicit snapshot schema version and status field.
- [x] Bounded-response intent and truncation metadata.
- [x] No browser mutation operations.
- [x] Page-snapshot injection fixed to run correctly in a real browser tab.
- [x] Unit test coverage for page extraction, the service worker, and the
  registered message listener.
- [x] Repeatable Chromium smoke test, verified against Chrome for Testing.
- [x] Dependency-free Node.js unit-test command.

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
