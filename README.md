# Browser Tabs

A deterministic, local-first browser adapter for inspecting open browser windows, tabs, and page-content snapshots. Model integration is deliberately out of scope.

## Phase-one contract

- Enumerate extension-visible browser windows.
- Enumerate extension-visible tabs in a window.
- Read a versioned, bounded text snapshot from a tab that permits script injection.

The extension never rearranges, closes, creates, or navigates tabs in this phase.

`browser.read_tab` returns the document body's rendered text (`innerText`) in
document order, normalizes CRLF to LF, and caps `text` at 500,000 characters.
It reports the full `characterCount` and `truncated: true` when the cap applies.

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
curl -H "Authorization: Bearer <token>" -H "X-Protocol-Version: 1" http://127.0.0.1:8743/api/browser.list_windows
```

Returns `{"protocolVersion": 1, "requestId": "...", "result": [...]}` with
the same normalized window objects the extension's `runtime.onMessage`
listener produces. `requestId` echoes an `X-Request-Id` header you send, or
is generated if you don't send one. Explicit failure modes:

| Condition | HTTP status | `error.code` |
| --- | --- | --- |
| No `Authorization` header | 401 | `missing_credential` |
| Wrong token | 401 | `invalid_credential` |
| `X-Protocol-Version` header missing or mismatched | 400 | `unsupported_protocol_version` |
| Extension not connected/paired | 503 | `disconnected` |
| Extension did not respond in time | 504 | `request_timeout` |
| Service is shutting down mid-request | 503 | `service_shutting_down` |

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

This rationale has been exercised iteratively against a real Chrome for
Testing browser and a real service process via
`test/smoke/stage1-bridge-smoke.mjs`, including an explicit wait past the
idle window; several real defects surfaced and were fixed this way (see
git history). Both `npm run test:smoke` (Stage 0) and `npm run
test:smoke:bridge` (Stage 1) have passed against Chrome for Testing on this
revision — see "Verification status" below.

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

Verified on this revision: `npm test` passes (84/84), `npm run test:smoke`
(Stage 0) passes against a real Chrome for Testing browser, `npm run
test:smoke:bridge` (Stage 1) passes against a real Chrome for Testing
browser and a real service process, and `npm audit` reports no
vulnerabilities. Several real defects (a port mismatch, a
`DevToolsActivePort` race, the harness page not surviving
`chrome.runtime.reload()`, among others) were found and fixed via this
smoke coverage across prior iterations — see git history for specifics.

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
