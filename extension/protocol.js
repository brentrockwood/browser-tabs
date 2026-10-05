export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_TEXT_CHARACTERS = 500_000;

// Versioned request/response contract shared by the HTTP API and the
// extension<->service WebSocket (project.md "Protocol rules"). A client or
// extension on a different major version gets a stable
// `unsupported_protocol_version` error instead of an undefined result.
export const PROTOCOL_VERSION = 1;

// Single source of truth for the Stage 1 fixed loopback port: both the
// extension's WebSocket target (extension/service-client.js) and the
// service's default listen port (service/cli.mjs) derive from this
// constant, so they cannot silently drift apart. The extension deliberately
// has no way to be pointed at a different port at runtime (see
// service-client.js) — this is the only place that number is allowed to
// change, and any caller (including a test harness) that wants the real
// extension to connect must use this exact value.
export const DEFAULT_SERVICE_PORT = 8743;

// Platform-native backstop for reconnecting after the service worker has
// been fully suspended/terminated by Chrome's MV3 idle policy (e.g. while
// the service itself was down across a restart): a `setTimeout` cannot
// survive worker termination and will never fire, but a `chrome.alarms`
// alarm is one of the few mechanisms Chrome guarantees will wake a
// terminated worker (a persistent, top-level `chrome.alarms.onAlarm`
// listener is re-registered whenever the worker runs, and firing the alarm
// starts the worker up again to deliver it). Chrome's current documented
// minimum create/period delay is 0.5 minutes (30 seconds); this requests
// that floor directly. This is Chrome's *minimum*, not a guarantee: Chrome
// may delay alarm delivery further (system load, power-saving, or other
// scheduling policy), so do not treat this constant, or any wait derived
// from it, as a hard worst-case recovery bound — only as the fastest the
// platform says it will try. The fast setTimeout backoff in
// extension/service-client.js, used whenever the worker is still alive,
// remains the common-case path and typically reconnects within seconds;
// this alarm only matters when the worker was actually terminated.
export const RECONNECT_ALARM_NAME = "browser-tabs:reconnect";
export const RECONNECT_ALARM_DELAY_MINUTES = 0.5;

// Chosen Stage 1 checkpoint resolution (see project.md): keep the WebSocket
// transport, and keep the Manifest V3 background service worker alive with
// authenticated ping/pong traffic no more than this many milliseconds
// apart. This matches Chrome's own documented keepalive pattern for
// long-lived WebSocket connections from a service worker (periodic
// application-level traffic resets the ~30s idle timer; a bare timer alone
// is not guaranteed to survive suspension). Validated against a real
// Chrome for Testing browser in test/smoke/stage1-bridge-smoke.mjs.
export const HEARTBEAT_INTERVAL_MS = 20_000;
// Extra time the service tolerates past one heartbeat interval with no
// traffic at all from an authenticated extension socket before treating
// the connection as dead and closing it.
export const HEARTBEAT_GRACE_MS = 20_000;

export const ERROR_CODES = Object.freeze({
  INVALID_PARAMS: "invalid_params",
  UNKNOWN_METHOD: "unknown_method",
  LISTING_FAILED: "listing_failed",
  NO_INJECTION_RESULT: "no_injection_result",
  NO_MAIN_FRAME_RESULT: "no_main_frame_result",
  INJECTION_REJECTED: "injection_rejected",
  DOCUMENT_HAS_NO_BODY: "document_has_no_body",
  // Stage 1: local-bridge transport errors (service <-> extension <-> API client).
  MISSING_CREDENTIAL: "missing_credential",
  INVALID_CREDENTIAL: "invalid_credential",
  ORIGIN_REJECTED: "origin_rejected",
  AUTH_TIMEOUT: "auth_timeout",
  DISCONNECTED: "disconnected",
  REQUEST_TIMEOUT: "request_timeout",
  NOT_PAIRED: "not_paired",
  UNSUPPORTED_PROTOCOL_VERSION: "unsupported_protocol_version",
  SERVICE_SHUTTING_DOWN: "service_shutting_down",
});

// Message `type` values exchanged on the extension<->service WebSocket.
// Distinct from the extension-internal `runtime.onMessage` methods above.
export const WS_MESSAGE_TYPES = Object.freeze({
  AUTH: "auth",
  AUTH_OK: "auth_ok",
  AUTH_ERROR: "auth_error",
  REQUEST: "request",
  RESPONSE: "response",
  PING: "ping",
  PONG: "pong",
});

export function isValidHandle(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function requestError(code, detail) {
  const error = { status: "error", code };
  if (detail !== undefined) error.detail = detail;
  return error;
}

export function unsupportedSnapshot(tabId, code, detail) {
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    tabId,
    status: "unsupported",
    code,
  };
  if (detail !== undefined) snapshot.detail = detail;
  return snapshot;
}

export function normalizeWindow(window) {
  return {
    windowId: window.id,
    focused: Boolean(window.focused),
    type: window.type,
    state: window.state,
    tabCount: Array.isArray(window.tabs) ? window.tabs.length : 0,
  };
}

export function normalizeTab(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    status: tab.status ?? "unknown",
    title: tab.title ?? null,
    url: tab.url ?? null,
  };
}

// Runs inside the target tab via scripting.executeScript. The browser
// serializes this function body alone, so it cannot close over module
// lexical scope (e.g. MAX_TEXT_CHARACTERS or ERROR_CODES) — values must
// arrive as arguments. The default parameter below is literal syntax
// baked into the serialized function source, not a closure, so it is safe;
// callers should still pass ERROR_CODES.DOCUMENT_HAS_NO_BODY explicitly to
// keep a single source of truth for the code string.
export function pageTextSnapshot(maxCharacters, documentHasNoBodyCode = "document_has_no_body") {
  const body = document.body;
  if (!body) {
    return { status: "not_ready", code: documentHasNoBodyCode };
  }

  const fullText = body.innerText.replace(/\r\n/g, "\n");
  const truncated = fullText.length > maxCharacters;
  const text = fullText.slice(0, maxCharacters);
  return {
    status: "ok",
    title: document.title,
    url: location.href,
    text,
    characterCount: fullText.length,
    truncated,
    documentReadyState: document.readyState,
  };
}
