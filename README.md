# Browser Tabs

A deterministic, local-first browser adapter for inspecting open browser windows, tabs, and page-content snapshots. Model integration is deliberately out of scope.

## Phase-one contract

- Enumerate extension-visible browser windows.
- Enumerate extension-visible tabs in a window.
- Enumerate tab groups in a window, where the browser supports them.
- Read a versioned, bounded text snapshot from a tab that permits script injection.
- Query browsing-history metadata, separately from open tabs, over an explicit time range.
- Report capabilities so a client does not infer browser features from brand.

The extension never rearranges, closes, creates, or navigates tabs in this phase.

`browser.read_tab` returns the document body's rendered text (`innerText`) in
document order, normalizes CRLF to LF, and caps `text` at 500,000 characters.
It reports the full `characterCount`, the `returnedCharacterCount` actually
included, and `truncated: true` when the cap applies.

Every `browser.*` result — success or error — carries a capture-provenance
envelope (`schemaVersion`, `browserSessionId`, `sourceOperation`,
`capturedAt`, `status`): see "Stage 2: the read API" below.

## Support boundary

The code targets Manifest V3 WebExtensions. Today, only Chromium-family
browsers are exercised by the test suite in this repository (see
`test/smoke/chromium-smoke.mjs`); Firefox parity is a planned later milestone
(project.md Stage 6) and is not yet tested. Browsers may refuse content
access to internal pages, extension-store pages, or other protected
contexts. Those cases are returned as explicit `unsupported` outcomes with a
stable error code, never as empty or invented page content.

Within Chromium-family browsers, the automated smoke path has a narrower,
evidence-based requirement: it needs a build that reliably honors
`--load-extension` on the command line. A locally installed, branded Google
Chrome (and, by the same restriction, branded Edge/Brave) is known to
silently ignore `--load-extension` and is **not supported** by the automated
smoke test; it is not auto-detected and is not a recommended `CHROME_PATH`
target. What is proven to work is a Chrome for Testing binary
(https://googlechromelabs.github.io/chrome-for-testing/) pointed to
explicitly via `CHROME_PATH`; Chromium (the open-source build) is also
expected to work and is the only browser this script auto-detects.

## Stage 1: the local bridge

A small Node.js service proves the end-to-end path: a local HTTP/WebSocket
service bound to loopback, an extension-owned WebSocket connection to a
**fixed** loopback URL, and one authenticated route (`browser.list_windows`)
routed through to the extension and back. Every request and response — on
both the HTTP API and the extension WebSocket — carries a protocol version;
a request ID is required on and echoed for named-method requests
(`browser.list_windows` and future methods), not on health, control, auth,
or heartbeat envelopes (project.md's "Protocol rules").

### Setup and pairing

1. Install dependencies once: `npm install`.
2. Start the service in a terminal: `npm run service -- start`. It binds
   `127.0.0.1` only, generates a random pairing credential on first run
   (stored at `~/.browser-tabs/credential` with `0600` permissions, and the
   `~/.browser-tabs` directory itself at `0700` — never committed, never in
   source; both are repaired to those permissions on every start even if
   found looser), and prints the credential once:

   ```text
   Browser Tabs service listening on http://127.0.0.1:8743 (loopback only).
   First run: generated a new pairing credential.
   Pairing token (paste into the extension's options page): <token>
   ```

   `start` runs in the foreground; stop it from another terminal (see
   below) or with Ctrl+C.
3. Load `extension/` as an unpacked extension, open its options page
   (`chrome://extensions` → Details → Extension options), and paste the
   token into "Pairing token". Save. There is no URL field: the extension
   only ever connects to the fixed `ws://127.0.0.1:8743/extension` address
   (see "Fixed loopback target" below) — it cannot be pointed at a remote
   or user-supplied address.
4. The extension's background service worker connects out to the service
   over WebSocket, authenticates with the saved token, and the bridge is
   up. Saving a new or changed token on the options page always takes
   effect immediately (closing any existing connection and reconnecting
   with the new token), rather than waiting for the next reconnect attempt.

If you lose the token, re-display it (it is never logged or printed
automatically after first run) with:

```sh
npm run service -- show-token
```

### Checking status and stopping

From any terminal, independent of how `start` was launched:

```sh
npm run service -- status   # probes GET /health on the recorded port
npm run service -- stop     # stops it via an authenticated control endpoint
```

`status` and `stop` locate the service by actually probing the port
recorded at `start` (`GET /health`), not by trusting a recorded process ID:
a process ID can be reused by an unrelated process after the service that
wrote it exits, so neither command treats a pid file as proof that the
service is still running. `stop` ends the service by calling its own
authenticated `POST /control/stop` endpoint (same credential as the API),
which asks the service to shut itself down gracefully — it does not send
any OS signal to a recorded pid. If the recorded port doesn't answer,
`status`/`start` treat that state as stale and clean it up rather than
reporting it at face value.

### Calling the API

```sh
curl -H "Authorization: Bearer <token>" -H "X-Protocol-Version: 2" http://127.0.0.1:8743/api/browser.list_windows
```

Returns `{"protocolVersion": 2, "requestId": "...", "result": {...}}`, where
`result` is the same capture-provenance-wrapped object the extension's
`runtime.onMessage` listener produces (see "Stage 2: the read API" below).
`requestId` echoes an `X-Request-Id` header you send, or is generated if you
don't send one. Explicit failure modes:

| Condition | HTTP status | `error.code` |
| --- | --- | --- |
| No `Authorization` header | 401 | `missing_credential` |
| Wrong token | 401 | `invalid_credential` |
| `X-Protocol-Version` header missing or mismatched | 400 | `unsupported_protocol_version` |
| Extension not connected/paired | 503 | `disconnected` |
| Extension did not respond in time | 504 | `request_timeout` |
| Service is shutting down mid-request | 503 | `service_shutting_down` |
| Unknown `/api/<method>` route | 404 | `not_found` |
| More requests than the service boundary's rate limit allows | 429 | `rate_limited` |
| Extension's response exceeds the service boundary's size bound | 502 | `response_too_large` |

The conditions above are transport/service-boundary failures (the round trip
itself did not complete). A recognized operation that the *browser* could not
satisfy (an invalid parameter, a stale handle, an unsupported capability, or
a browser-API failure) still returns HTTP 200 with the outcome encoded in
`result.status`/`result.code` — see "Stage 2: the read API" below.

The extension's own WebSocket connection is authenticated the same way (an
`auth` message carrying the token and protocol version) and is only
accepted from a `chrome-extension://` origin; any other origin — including
a page served from `localhost` — is rejected at the HTTP upgrade (`403`)
before a WebSocket is ever established. The server never dispatches a
request to that connection until *after* it has sent `auth_ok`; the
extension additionally never acts on a request it receives before it has
itself observed `auth_ok`, as defense in depth.

### Fixed loopback target and keepalive (checkpoint resolution)

The extension's WebSocket target (`ws://127.0.0.1:8743/extension`) is a
source-level constant (`extension/service-client.js`), not something
stored in `chrome.storage` or editable from the options page — pairing only
ever supplies the credential, never an address.

Stage 1's checkpoint in `project.md` asked whether a quiet WebSocket can
stay reliable across a Manifest V3 service worker's idle lifecycle. The
chosen resolution is to **keep the WebSocket transport** and send an
authenticated heartbeat (`ping`/`pong`) no more than 20 seconds apart once
connected — Chrome's own documented keepalive pattern for a long-lived
service-worker WebSocket, since received/sent WebSocket traffic resets the
service worker's idle timer while a bare `setTimeout` alone is not
guaranteed to survive suspension. This is implemented in
`extension/service-client.js` (sends `ping`) and `service/server.mjs`
(answers with `pong`, and independently closes a connection that goes
quiet for too long). `HEARTBEAT_INTERVAL_MS` in `extension/protocol.js` is
the single source of truth for the interval on both sides.

This rationale was exercised iteratively against a real Chrome for Testing
browser and a real service process via `test/smoke/stage1-bridge-smoke.mjs`
in earlier (pre-Stage-2) revisions, including an explicit wait past the idle
window; several real defects surfaced and were fixed this way (see git
history). That script has since been extended for Stage 2 (see "Stage 2: the
read API" below) and re-run against this revision — see "Verification
status" below for the current status.

**Addendum — the heartbeat alone is not sufficient while the *service* is
unavailable.** The heartbeat keeps the worker alive while it has a live
connection to reset its idle timer against. While the service is down
(e.g. mid-restart), there is no connection, so the extension falls back to
a bounded `setTimeout` backoff to retry — but a `setTimeout` scheduled
before a service worker is fully terminated by Chrome's MV3 idle policy
does not survive that termination and will simply never fire. The
platform-native backstop for that case is
[`chrome.alarms`](https://developer.chrome.com/docs/extensions/reference/api/alarms):
a persistent, top-level `chrome.alarms.onAlarm` listener (registered in
`extension/service-worker.js`) is one of the mechanisms Chrome guarantees
will wake a terminated worker.

That guarantee only holds if the alarm was actually armed before
termination — and a plain WebSocket `close` event is *not* a reliable
place to arm it, because Chrome is not guaranteed to run `close` before
terminating an idle worker at all. So `extension/service-client.js` instead
arms a repeating `browser-tabs:reconnect` alarm (`RECONNECT_ALARM_NAME` in
`extension/protocol.js`) as soon as it reads a pairing token — at startup
and after every token change — and keeps it armed for as long as a token
exists, including while connected: `onAlarm` already no-ops whenever a
connection attempt is in progress or already connected, so a periodic
alarm firing while healthy is a harmless no-op, never a duplicate
connection. It is cleared only when the pairing token is removed or the
client is explicitly stopped. Chrome's current documented minimum alarm
create/period delay is 0.5 minutes (30 seconds); `RECONNECT_ALARM_DELAY_
MINUTES` requests that floor directly. This is Chrome's floor, **not a
worst-case guarantee** — Chrome may delay alarm delivery further (system
load, power-saving, or other scheduling policy) — so treat it only as the
fastest the platform says it will try: usually seconds in practice (via
the setTimeout fast path, while the worker is still alive), typically
around half a minute if the worker was actually terminated, but not a
hard bound. `test/smoke/stage1-bridge-smoke.mjs`'s service-restart test
deliberately leaves the service down past the idle window before
restarting it (so the fast path cannot mask the alarm path) and waits a
generous multiple of this floor for recovery — a generous test timeout,
not a claimed product SLA.

### Recovery

- **Service restart**: the credential file on disk is reused, not
  regenerated, so a restarted service does not need re-pairing. The
  extension's bounded-backoff reconnect logic re-establishes the
  connection automatically if the worker is still alive; if Chrome had
  terminated it, the `chrome.alarms` backstop above wakes it instead,
  bounding (not guaranteeing instant) recovery.
- **Extension restart** (reload, browser restart, or Manifest V3 service
  worker eviction): the pairing token lives in `chrome.storage.local`, so
  on the next wake the extension reconnects using the same token without
  re-pairing.
- **Lost/rotated credential**: delete `~/.browser-tabs/credential` and
  restart the service to force a new one, then re-pair the extension with
  `show-token`'s new value.
- **Graceful shutdown with work in flight**: any HTTP request still
  awaiting an extension response when the service shuts down (via `stop`,
  Ctrl+C, or SIGTERM) is settled with an explicit `503
  service_shutting_down` response rather than left hanging.

### Dependency added

The server side uses the [`ws`](https://github.com/websockets/ws) package
for the WebSocket server. Node's built-in `WebSocket` (stable since
Node.js 22, already used by the Stage 0 smoke test) is a *client* only —
there is no WebSocket *server* in the standard library. Implementing
RFC 6455 framing by hand to avoid one dependency was judged unnecessary
risk for a protocol this central; `ws` is small, has no required
dependencies of its own, and is the de facto standard choice for a Node
WebSocket server. No other dependency was added in this revision.

### Real-browser bridge smoke test

```sh
npm run test:smoke:bridge
```

Reuses the Stage 0 CDP harness (`test/smoke/chrome-harness.mjs`) to drive a
real unpacked extension in Chrome for Testing/Chromium alongside the actual
service as a separate process. It pairs via `chrome.storage.local` (as the
options page would), proves an HTTP→service→extension→
`browser.list_windows` round trip, waits past the Manifest V3 idle window
and proves the connection and another request still work, restarts the
*service* process and proves the extension reconnects without re-pairing,
forces a full *browser* restart (same `--user-data-dir`, same staged
extension, service left running) and proves the same reconnect-without-
re-pairing from the persisted `chrome.storage.local` token, and finally
confirms that a real (non-extension) browser page's Origin header gets
the WebSocket upgrade rejected. (`chrome.runtime.reload()` was tried
first but discarded: on Chrome for Testing it removes the command-line-
loaded unpacked extension entirely, an environment artifact of
`--load-extension`, not a meaningful recovery test.) Same
`CHROME_PATH`/`SMOKE_HEADLESS` environment variables and
`SMOKE_PASS`/`SMOKE_FAIL`/`SMOKE_BLOCKED` convention as `npm run test:smoke`
(see that section below), plus `STAGE1_IDLE_WAIT_MS` to override the
default 35-second idle-window wait. Runtime is roughly 2–3 minutes,
dominated by that idle wait plus a deliberate service-downtime wait and
the subsequent alarm-recovery wait (sized off Chrome's 0.5-minute alarm
floor plus margin, see "Addendum" above — a generous test timeout, not a
guaranteed bound) — the recovery waits return as soon as recovery is
observed, so they are upper bounds, not fixed sleeps.

The service worker's own CDP connection is deliberately detached before
the idle wait and the service-downtime window, and not reattached until
the browser-restart step genuinely needs one again: a live DevTools
session is known to keep Chrome from treating a target as idle, so
leaving it attached would make survival an artifact of being instrumented
rather than a real proof of the heartbeat/alarm. The persistent harness
page (a different, ordinary page target) may remain connected to read
`chrome.alarms.getAll()` during those windows, but never messages or
wakes the worker.

Because the extension's WebSocket target is a fixed, non-configurable
constant (`extension/service-client.js`), this test must run the real
service on that exact default port (`DEFAULT_SERVICE_PORT` in
`extension/protocol.js`, currently 8743) — it does not pick an arbitrary
free port the way the unit/integration tests do. It checks the port is free
first and reports `SMOKE_BLOCKED` with a clear message (rather than a
confusing timeout) if something else is already listening there, e.g. a
real `npm run service -- start` left running; stop that first.

If a connection-wait step ever times out, the failure message includes the
extension's own reported connection state (`not_paired`/`connecting`/
`reconnecting`/`connected`, read via a diagnostic-only hook) and the last
20 captured service-worker console/exception entries, so a wrong-port,
rejected-auth, rejected-origin, or thrown-on-startup failure can be told
apart without re-running under a debugger.

Before reacquiring a CDP connection to the service worker at all (for the
browser-restart step, or for best-effort diagnostics), the script never
trusts a possibly-stale handle: it looks the target up fresh each time. If
it can't be found, the error separately reports `/health` and a direct API
probe, so a disappeared CDP target is never confused with an actual
product failure.

### Verification status

Historically verified (prior revisions, before Stage 2): `npm test`,
`npm run test:smoke` (Stage 0) against a real Chrome for Testing browser,
`npm run test:smoke:bridge` (Stage 1) against a real Chrome for Testing
browser and a real service process, and `npm audit`. Several real defects (a
port mismatch, a `DevToolsActivePort` race, the harness page not surviving
`chrome.runtime.reload()`, among others) were found and fixed via this smoke
coverage across prior iterations — see git history for specifics.

Stage 2's own verification status is recorded in "Stage 2: the read API"
below; its automated checks have been run against this revision and pass
(see that section for the full evidence).

## Stage 2: the read API

Stage 2 extends the Stage 1 bridge's one route (`browser.list_windows`) into
a complete, bounded read API: windows, tabs, tab groups (where supported),
page-text snapshots, and browsing history, plus a capability-discovery
route. It reuses Stage 1's authenticated HTTP API and extension WebSocket
transport, but is a **breaking protocol change** (`PROTOCOL_VERSION` is now
`2`): every result is a validated capture-provenance envelope rather than a
bare value, and handle-consuming routes now require a caller-supplied
session id. A protocol-1 client or extension cannot interoperate with this
revision.

### Routes

All routes are `GET /api/<method>`, authenticated and protocol-versioned
exactly like Stage 1's `browser.list_windows`:

| Method | Query parameters | Notes |
| --- | --- | --- |
| `browser.list_windows` | _(none)_ | Extended result shape (see below); no session required. |
| `browser.list_tabs` | `windowId`, `browserSessionId` | Requires a matching session id; rejects a stale/nonexistent `windowId` explicitly. |
| `browser.list_tab_groups` | `windowId`, `browserSessionId` | Validates the session and the window handle *before* checking tab-group support, so a bad handle is never reported as merely "unsupported." Reports `status: "unsupported"` where the browser has no `tabGroups` API, instead of an empty list. |
| `browser.read_tab` | `tabId`, `browserSessionId` | Requires a matching session id; rejects a stale/closed `tabId` explicitly, before attempting injection. A tab still mid-navigation (`status: "loading"`, from `tabs.get`) returns `status: "not_ready", code: "tab_loading"` immediately, also before attempting injection — `scripting.executeScript` can otherwise block for the remainder of a slow page load, past the service's own HTTP request timeout. |
| `browser.query_history` | `startTime`, `endTime`, `maxResults`, `cursor` | `startTime`/`endTime` (ms since epoch) are required; `maxResults` defaults to 100, capped at 500; `cursor` is an offset into a deterministic sort, not a timestamp (see "History pagination" below). No session required (it does not resolve a window/tab handle). |
| `browser.get_capabilities` | _(none)_ | Reports `tabGroups`/`history`/`scripting` support and the configured bounds, so a client does not infer features from browser brand. No session required. |

A query parameter that is present but empty (e.g. `?windowId=`) is always
treated as malformed, never coerced to `0` — both at the HTTP layer
(`Number("")` is intercepted before it can happen) and, redundantly, by the
extension's own handle validation.

The route table itself is a `Map` (not a plain object), so a method name
that collides with an inherited `Object.prototype` member (`/api/toString`,
`/api/__proto__`, `/api/constructor`, ...) simply has no entry and 404s,
rather than ever risking being resolved as a route handler.

### Session-scoped handles

Window/tab IDs are session-scoped browser handles, not durable identities
(project.md's protocol rules), and so is `browserSessionId` itself: it
identifies one *browser session* (roughly: until the browser itself
restarts), not a single WebSocket connection or worker incarnation.
`browser.list_tabs`, `browser.list_tab_groups`, and `browser.read_tab` all
require a caller-supplied `browserSessionId`, validated — as missing or
mismatched, returning `status: "error", code: "stale_session"` — **before**
any numeric window/tab handle is even considered. A client obtains the
current session id from any prior result's envelope (e.g.
`browser.get_capabilities` or `browser.list_windows`).

Internally, `browserSessionId` is persisted via `chrome.storage.session`:
in-memory storage the browser itself clears on a full restart, so it
survives a Manifest V3 service-worker eviction (no re-pairing, same session)
but always rotates on an actual browser restart — no separate rotation
logic is needed. Where `chrome.storage.session` is unavailable, the
extension falls back to a non-persisted id; a client holding a handle across
a worker eviction in that fallback case simply receives a `stale_session`
rejection and refetches, the same outcome as a genuine restart.

Once the session matches, `browser.list_tabs`/`browser.list_tab_groups`
additionally confirm the window handle still resolves (`windows.get`)
before doing anything else, and `browser.read_tab` confirms the tab handle
resolves (`tabs.get`) before attempting injection — returning
`status: "error", code: "stale_handle"` if not. A closed window/tab is never
silently reinterpreted as "empty" or retargeted at a different one.

### Capture-provenance envelope, validated at the service boundary

Every `browser.*` result — success, `unsupported`, `not_ready`,
`incomplete`, or `error` — carries:

```json
{
  "schemaVersion": 1,
  "browserSessionId": "...",
  "sourceOperation": "browser.list_tabs",
  "capturedAt": 1735900000000,
  "status": "ok"
}
```

`browserSessionId` identifies the extension's current browser session (see
above). `capturedAt` is the service worker's own clock at the moment the
browser API call completed. `sourceOperation` is the method name that
produced the result. `status` is one of `"ok"`, `"unsupported"`,
`"not_ready"`, `"incomplete"`, or `"error"`; every non-`"ok"` status
additionally carries a non-empty `code` and, where available, `detail`.

The service (`service/server.mjs`) treats the extension as a trust boundary,
not a fully trusted peer: before ever returning a `200` to an HTTP caller,
it validates the extension's response against this envelope shape *and*
the method-specific fields an `"ok"` result for that route must have
(`validateMethodResult` in `extension/protocol.js`). A legacy (pre-Stage-2)
bare array, a result whose `sourceOperation` doesn't match the requested
method, or any other malformed shape is rejected as
`502 invalid_extension_response` rather than ever reaching a client as if it
were trustworthy.

### Bounds

Every list is capped and reports `returnedCount`, `totalCount`
(`list_windows`/`list_tabs`/`list_tab_groups`) or `returnedCount` plus a
`nextCursor` (`query_history`), and a `truncated` flag:

| Bound | Default |
| --- | --- |
| `MAX_WINDOWS_RETURNED` | 500 |
| `MAX_TABS_RETURNED` | 2,000 |
| `MAX_TAB_GROUPS_RETURNED` | 500 |
| `MAX_HISTORY_RESULTS` (per page) | 500 |
| `DEFAULT_HISTORY_MAX_RESULTS` | 100 |
| `MAX_HISTORY_SCAN` (per-page scan ceiling) | 5,000 |
| `MAX_TEXT_CHARACTERS` (page snapshot) | 500,000 |

At the service boundary (`service/server.mjs`, independent of the bounds
above), a conservative request-rate limit (`RATE_LIMIT_MAX_REQUESTS` per
`RATE_LIMIT_WINDOW_MS`, default 30/second) returns `429 rate_limited`, a
response-size bound (`MAX_RESPONSE_BYTES`, default 2 MiB) returns
`502 response_too_large` rather than ever writing an oversized payload to
the socket, and a separate, larger inbound-WebSocket-message bound
(`MAX_WS_MESSAGE_BYTES`, default 8 MiB) is enforced by the WebSocket server
itself (`maxPayload`), closing a connection that sends an oversized message
before it is ever fully buffered or parsed. The WS bound is deliberately
*not* just a small margin over `MAX_RESPONSE_BYTES`: a fully legitimate,
bounded `browser.read_tab` result (up to `MAX_TEXT_CHARACTERS` of text) can
itself serialize to well over 2 MiB once JSON-escaped in the worst case, and
that worst-case-but-legitimate result must still reach the service to be
evaluated and reported as `response_too_large` — not be silently dropped by
the transport before the service ever sees it. All of these constants live
in `extension/protocol.js`.

### History pagination

`chrome.history.search` has no native cursor. `browser.query_history` uses a
**bounded offset cursor over a deterministic sort**: entries are sorted by
`lastVisitTime` descending, tie-broken by the browser's own stable per-URL
`id` (`compareHistoryEntries` in `extension/protocol.js`), and `cursor` is a
plain offset into that sort — `0` for the first page, `nextCursor` from the
previous page thereafter.

Every page for a given `[startTime, endTime]` range re-fetches the *same*
bounded scan set — up to `MAX_HISTORY_SCAN` entries, regardless of `cursor`
or `maxResults` — and sorts that whole set deterministically before slicing
out the requested page, rather than asking the browser for a
page-size-dependent amount. This matters because `chrome.history.search`
does not guarantee stable tie-breaking for entries sharing the exact same
`lastVisitTime` across *differently-sized* requests, so two pages computed
from two differently-sized queries could otherwise duplicate or skip a tied
entry; re-sorting one identical scan set every time removes that
inconsistency. If the browser has at least `MAX_HISTORY_SCAN` matching
entries and a requested page's end reaches or exceeds that scanned
boundary — or if `cursor` itself is already at or past the ceiling — neither
that page's content nor whether a further page exists can be determined
reliably, and the result is `status: "incomplete", code:
"pagination_limit_reached"` rather than a silently wrong or incomplete
`"ok"` page.

The one limitation this does **not** remove: if the underlying history
changes between two separate page requests (a new visit recorded, or an
existing one re-visited, between fetching page 1 and page 2), pagination can
become inconsistent across those two calls — an inherent property of
stateless, non-transactional pagination over a live, mutable data source,
not a defect in the sort/slice logic itself.

### Permissions added

`tabGroups` and `history` were added to `extension/manifest.json`. A
browser's current version may lack a `tabGroups` API entirely (Firefox, as
of this writing); rather than maintaining a separate implementation for
such a browser, support is feature-detected at runtime
(`browser.get_capabilities`'s `tabGroups` field, and `list_tab_groups`'s own
`unsupported` outcome) from one shared codebase.

### What Stage 2 does not add

No derived store, no review UI, and no new mutation operation. The
read-API's own exposed methods are exactly the six listed above; Stage 1's
authentication and origin rules are unchanged (only the protocol version,
result shape, and session requirement changed).

### Verification status

The unit/integration tests above were written, reviewed, and **run** against
this revision (`test/protocol.test.mjs`, `test/service-worker.test.mjs`,
`test/service-client.test.mjs`, `test/bridge.test.mjs`), including
regressions for: the history-pagination redesign (an exact-equal-timestamp,
scrambled-browser-order case proving distinct, non-duplicated/non-skipped
entries across pages); the WS-transport-vs-HTTP-response size-bound
relationship (a response above the 2 MiB HTTP cap but below the 8 MiB WS cap
reaching the service and being reported `response_too_large`, and one above
the WS cap being rejected at the transport layer instead); and the deepened
`validateMethodResult` checks (per-record list validation,
returnedCount/totalCount consistency, read_tab's character-count/truncation
consistency, and capabilities' required types/bounds). `tab_loading` (a tab
caught mid-navigation before injection is attempted) has its own dedicated
unit test and is asserted exactly (not merely "some explicit outcome") by
the real-browser slow-loading-page smoke scenario.
`test/smoke/stage1-bridge-smoke.mjs`/`test/smoke/chromium-smoke.mjs` were
extended for the session requirement and the additional routes (capabilities,
tabs, a real harness-created tab group, read_tab outcomes including
protected/stale/tab_loading/best-effort-discarded tabs — with the discarded-
tab assertion failing the smoke outright if a confirmed discard yields a
malformed read_tab result, rather than being logged as non-fatal —
two-entry paginated history, and session rotation/rejection across a full
browser restart).

**All of the above has been run against this revision:** `npm test` passes
179/179; `npm audit` reports no vulnerabilities; `npm run test:smoke` (Stage
0) passes against a real Chrome for Testing browser; and the expanded
`npm run test:smoke:bridge` passes against a real Chrome for Testing browser
and a real service process, proving `browser.get_capabilities`,
windows/tabs enumeration, a real harness-created tab group, bounded
page-snapshot outcomes (`ok`, protected/`unsupported`, `stale_handle`,
`not_ready`/`tab_loading`, and a best-effort discarded-tab case), paginated
`browser.query_history`, capture-provenance on every result,
`browserSessionId` rotation across a full browser restart plus
`stale_session` rejection of a pre-restart session id, and the
service-boundary response-size/rate bounds. No mutation API is exposed by
any route exercised. See project.md's Stage 2 checklist (now checked) and
its "Current verification status (Stage 2)" section for the itemized
evidence.

Honest limits, unchanged by this verification: Firefox parity is still
Stage 6, not claimed here; history pagination can still be inconsistent
across two page requests if history mutates between them; reaching the
per-page scan ceiling yields an explicit `incomplete` outcome rather than a
silently wrong page; and the discarded-tab smoke outcome depends on the
browser's own discard/wake behavior, so a passing run may observe either the
discarded outcome or `status: "ok"`.

## Local development

Load `extension/` as an unpacked extension in a Chromium browser. Stage 1 adds
a local service (`service/`) that the extension connects to over a loopback
WebSocket; see "Stage 1: the local bridge" above for setup.

Run the deterministic unit tests (mocked browser APIs, no browser required) with:

```sh
npm test
```

Run the Chromium smoke test (stages a temporary copy of the extension plus a
test-only harness page, loads it unpacked in a real local Chromium or Chrome
for Testing binary, and — by calling `chrome.runtime.sendMessage` from that
harness page, exercising the real `runtime.onMessage` listener rather than
importing its exported functions — checks window listing, tab listing,
reading an ordinary page, reading a protected `chrome://` page, and an
unknown method) with:

```sh
npm run test:smoke
```

This smoke command specifically requires Node.js 22 or later, for the
built-in `WebSocket` client it uses to speak the Chrome DevTools Protocol;
this is not a project-wide requirement — `npm test` (the unit tests) runs on
any Node.js version supporting `node:test`.

It also needs a browser binary that reliably honors `--load-extension`: set
`CHROME_PATH` to a Chrome for Testing binary (proven to work) or rely on
auto-detected Chromium. A locally installed branded Google Chrome, Edge, or
Brave is known to silently ignore `--load-extension` and is deliberately not
auto-detected or recommended as `CHROME_PATH`; pointing `CHROME_PATH` at one
will run, but is unsupported — once Chrome has launched and exposed CDP, the
extension's service worker never loading (as happens when `--load-extension`
was silently ignored) is reported as `SMOKE_FAIL`, not `SMOKE_BLOCKED`, since
at that point the script cannot distinguish "unsupported browser" from a real
startup regression. Set `SMOKE_HEADLESS=false` to run headed.

The script prints `SMOKE_PASS`, `SMOKE_FAIL` (a product assertion failed, the
`runtime.sendMessage` exercise itself threw, or the extension's service
worker never started after Chrome launched and exposed CDP — the extension
behaved incorrectly, or an unsupported browser was used), or `SMOKE_BLOCKED`
(an infrastructure/environment problem prevented the test from running at
all, e.g. no suitable browser found, an invalid `CHROME_PATH` that failed to
launch, or a CDP/setup timeout before the browser was reachable) with the
specific reason, and exits non-zero on anything other than a pass.
