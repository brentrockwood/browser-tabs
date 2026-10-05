export const MAX_TEXT_CHARACTERS = 500_000;

// Stage 2: schema version for the capture-provenance envelope every
// browser-derived result now carries (browserSessionId, sourceOperation,
// capturedAt, status) — see captureEnvelope below. Distinct from the
// protocol version: this can change independently as the envelope shape
// evolves within the same protocol major version (unknown fields are
// tolerated; see project.md's protocol rules).
export const RESULT_SCHEMA_VERSION = 1;

// Stage 2 conservative response bounds, enforced where the corresponding
// list is produced (extension/service-worker.js) and, for overall payload
// size, again at the service boundary (service/server.mjs).
export const MAX_WINDOWS_RETURNED = 500;
export const MAX_TABS_RETURNED = 2_000;
export const MAX_TAB_GROUPS_RETURNED = 500;
export const MAX_HISTORY_RESULTS = 500;
export const DEFAULT_HISTORY_MAX_RESULTS = 100;
// Upper bound on how many history entries a single `browser.query_history`
// page will ever ask the browser to scan through (via `maxResults` on
// chrome.history.search), no matter how deep a caller's `cursor` offset is.
// Protects against an unbounded scan for a very deep page; see
// queryHistory's "incomplete"/`pagination_limit_reached` outcome in
// extension/service-worker.js for what happens when this is reached before
// a full page can be determined.
export const MAX_HISTORY_SCAN = 5_000;

// Conservative request-rate and response-size bounds enforced at the
// service's HTTP boundary (service/server.mjs), independent of whatever an
// individual browser operation itself bounds.
export const RATE_LIMIT_WINDOW_MS = 1_000;
export const RATE_LIMIT_MAX_REQUESTS = 30;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
// Inbound WebSocket message cap (service/server.mjs's WebSocketServer
// `maxPayload`). Deliberately *larger* than MAX_RESPONSE_BYTES, not derived
// from it: a legitimate, fully-bounded `browser.read_tab` result (up to
// MAX_TEXT_CHARACTERS of text) can itself exceed MAX_RESPONSE_BYTES once
// JSON-escaped — a single character can expand to a 6-byte `\uXXXX` escape
// in the worst case, so 500,000 characters alone can serialize to roughly
// 2.9 MB, before the rest of the envelope. If this transport cap were tied
// to (or only slightly larger than) MAX_RESPONSE_BYTES, that worst-case but
// entirely legitimate result could never even reach the service to be
// evaluated and reported as `response_too_large` — it would instead be
// silently dropped by the WebSocket layer itself. This cap exists only to
// bound memory against a misbehaving/compromised extension connection, not
// to pre-empt the service's own (separate, smaller) response-size decision;
// `MAX_RESPONSE_BYTES` remains the actual, documented limit a caller sees
// via `502 response_too_large`.
export const MAX_WS_MESSAGE_BYTES = 8 * 1024 * 1024;

// Versioned request/response contract shared by the HTTP API and the
// extension<->service WebSocket (project.md "Protocol rules"). A client or
// extension on a different major version gets a stable
// `unsupported_protocol_version` error instead of an undefined result.
//
// Bumped to 2 for Stage 2's read API: this is a breaking response-shape
// change (every browser.* result is now a validated capture-provenance
// envelope, not a bare array/value) and handle-consuming methods now
// require a caller-supplied `browserSessionId`, neither of which an old
// (version-1) client or extension could produce or understand correctly.
//
// Bumped to 3 for Phase 2 Action 1 (`browser.open_tab`): the first request
// the service sends the extension that *mutates* the browser. A version-2
// extension must never be paired with a service that expects the strict
// session-revalidating, create-then-observe contract below (it would answer
// `unknown_method`, with no `created` field), so the handshake refuses the
// mismatch outright with `unsupported_protocol_version`.
//
// Bumped to 4 for Phase 2 Action 2 (`browser.configure_group`, plus the
// read-only `browser.inspect_group_target` its preview uses): a second
// mutating request. A version-3 extension would answer it `unknown_method`
// with no `changed` field, so the handshake refuses the mismatch outright.
//
// Bumped to 5 for Phase 2 Action 3 (`browser.move_tabs`, plus the read-only
// `browser.inspect_move_target` its preview uses): a third mutating request. A
// version-4 extension would answer it `unknown_method` with no `changed`
// field, so the handshake refuses the mismatch outright.
export const PROTOCOL_VERSION = 5;

// Phase 2 Action 3: the most tabs one move may name. Bounds the preview body,
// the stored binding, the extension requests, and the single `tabs.group` call.
export const MAX_MOVE_TABS = 100;

// Phase 2 Action 1: the longest URL (raw input, and again after
// normalization) the open-tab action accepts. Bounds the preview, the stored
// action record, and the `tabs.create` argument.
export const MAX_OPEN_URL_LENGTH = 2_048;

// Phase 2 Action 2: tab-group configuration. The colors are Chrome's native
// `tabGroups.Color` enum, passed through unchanged. A title is plain text of
// at most this many characters; the empty string is the explicit "clear the
// title" value (an omitted/null title means "leave it alone").
export const TAB_GROUP_COLORS = Object.freeze(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
export const MAX_GROUP_TITLE_LENGTH = 100;
// `tabs.TAB_GROUP_ID_NONE`: a tab's `groupId` when it is in no group.
export const TAB_GROUP_ID_NONE = -1;

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
  // A tab still mid-navigation (tabs.get's own `status: "loading"`), caught
  // before injection is even attempted — scripting.executeScript can block
  // for the remainder of a slow page load, well past the service's HTTP
  // request timeout, rather than failing fast. See readTab in
  // extension/service-worker.js.
  TAB_LOADING: "tab_loading",
  // Stage 1: local-bridge transport errors (service <-> extension <-> API client).
  // The raw HTTP request itself could not be parsed (e.g. a malformed
  // request target that fails `new URL(...)`) — rejected before any
  // authentication or route dispatch is even attempted. See
  // service/server.mjs.
  INVALID_REQUEST: "invalid_request",
  MISSING_CREDENTIAL: "missing_credential",
  INVALID_CREDENTIAL: "invalid_credential",
  // Stage 4: the presented credential authenticated successfully (it is a
  // real owner or external-agent token), but the scope it carries does not
  // permit the requested method — distinct from INVALID_CREDENTIAL, which
  // means the credential itself did not authenticate at all. See
  // service/server.mjs's AGENT_ALLOWED_* allowlists.
  FORBIDDEN_SCOPE: "forbidden_scope",
  ORIGIN_REJECTED: "origin_rejected",
  // Stage 5 remediation: the request's Host header did not match this
  // loopback service's own canonical `127.0.0.1:<actual listening port>`
  // (service/server.mjs's checkHost) — defense against DNS rebinding and
  // similar Host-header-confusion attacks, since loopback binding alone
  // does not stop a browser page on an attacker-controlled hostname that
  // merely *resolves* to 127.0.0.1 from issuing a same-"IP" request here.
  INVALID_HOST: "invalid_host",
  AUTH_TIMEOUT: "auth_timeout",
  DISCONNECTED: "disconnected",
  REQUEST_TIMEOUT: "request_timeout",
  NOT_PAIRED: "not_paired",
  UNSUPPORTED_PROTOCOL_VERSION: "unsupported_protocol_version",
  SERVICE_SHUTTING_DOWN: "service_shutting_down",
  // Stage 2: read-API outcomes.
  STALE_HANDLE: "stale_handle",
  STALE_SESSION: "stale_session",
  UNSUPPORTED_FEATURE: "unsupported_feature",
  TAB_GROUPS_QUERY_FAILED: "tab_groups_query_failed",
  HISTORY_QUERY_FAILED: "history_query_failed",
  PAGINATION_LIMIT_REACHED: "pagination_limit_reached",
  // Phase 2 Action 1: `tabs.create` itself rejected (no tab was created), and
  // the partial outcome where it succeeded but the follow-up `tabs.get`
  // observation did not (a tab *was* created; its final state is unknown).
  OPEN_TAB_FAILED: "open_tab_failed",
  OBSERVE_FAILED: "observe_failed",
  // Phase 2 Action 2: `tabs.group` rejected (no group was created); the
  // follow-up `tabGroups.update` rejected (for a new group, the group exists
  // without its title/color — a partial outcome); and the bound current state
  // (window, ungrouped tab, group title/color) no longer matching at
  // execution time, so nothing was changed.
  GROUP_FAILED: "group_failed",
  GROUP_UPDATE_FAILED: "group_update_failed",
  STATE_MISMATCH: "state_mismatch",
  RATE_LIMITED: "rate_limited",
  RESPONSE_TOO_LARGE: "response_too_large",
  // The extension's own response failed the service boundary's envelope/
  // shape validation (see validateMethodResult below) — a legacy shape,
  // wrong `sourceOperation`, or otherwise malformed result, never forwarded
  // to an HTTP caller as if it were trustworthy.
  INVALID_EXTENSION_RESPONSE: "invalid_extension_response",
  INTERNAL_ERROR: "internal_error",
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

export function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

// A caller-supplied browserSessionId is a string, validated for shape only
// here; whether it actually *matches* the extension's current session is a
// comparison the extension itself must make (see checkSession in
// extension/service-worker.js) — this only rejects obviously-malformed
// input before that comparison.
export function isValidSessionId(value) {
  return isNonEmptyString(value);
}

export function requestError(code, detail) {
  const error = { status: "error", code };
  if (detail !== undefined) error.detail = detail;
  return error;
}

// Stage 2: the capture-provenance envelope every browser-derived result
// carries (project.md protocol rules: "Browser records include a
// browser-session identifier, capture time, source operation, and capture
// status"). `browserSessionId` identifies the extension's current connected
// session (see extension/service-worker.js), not a durable database
// identity. Callers spread additional result-specific fields alongside this.
export function captureEnvelope(browserSessionId, sourceOperation, status) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId,
    sourceOperation,
    capturedAt: Date.now(),
    status,
  };
}

export function isValidTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

// Phase 2 Action 1: the one place a URL to open is validated and normalized,
// shared by the service (preview) and the extension (re-checked before
// `tabs.create`). Accepts only an absolute, bounded `http(s)://` URL with no
// embedded credentials and returns the WHATWG-normalized form — the exact
// string the preview shows, the approval binds, and the browser is asked to
// open. Whitespace and control characters are rejected rather than left for
// the URL parser to silently strip or re-encode, and any other scheme
// (`javascript:`, `data:`, `file:`, `chrome:`, ...) is refused outright.
export function normalizeOpenUrl(value) {
  const invalid = (reason) => ({ valid: false, reason });
  if (typeof value !== "string" || value.length === 0) return invalid("url must be a non-empty string");
  if (value.length > MAX_OPEN_URL_LENGTH) return invalid(`url must be at most ${MAX_OPEN_URL_LENGTH} characters`);
  if (/[\u0000- \u007f-\u009f]/.test(value)) return invalid("url must not contain whitespace or control characters");
  if (!/^https?:\/\//i.test(value)) return invalid("url must be an absolute http:// or https:// URL");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return invalid("url is not a valid absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return invalid("url scheme must be http or https");
  if (parsed.username !== "" || parsed.password !== "") return invalid("url must not contain credentials");
  if (parsed.href.length > MAX_OPEN_URL_LENGTH) return invalid(`normalized url must be at most ${MAX_OPEN_URL_LENGTH} characters`);
  return { valid: true, url: parsed.href };
}

// Phase 2 Action 2: shared by the service (preview) and the extension (re-checked
// before any mutation). Plain text only: bounded, no control characters. The
// empty string is valid here — it means "clear the title" where a title is
// requested at all.
export function isValidGroupTitle(value) {
  return typeof value === "string" && value.length <= MAX_GROUP_TITLE_LENGTH && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function isValidGroupColor(value) {
  return typeof value === "string" && TAB_GROUP_COLORS.includes(value);
}

// Phase 2 Action 2: the one place a group-configuration request is validated,
// shared by the service (when a preview is stored) and the extension (re-checked
// before any mutation). `create` groups exactly one existing tab
// (`tabId`, in `windowId`) and may set a title and/or color; `update` changes an
// existing group (`groupId`, in `windowId`) whose current title/color the
// request states (`expectedTitle`/`expectedColor`) and must actually change at
// least one of them. `title`/`color` of null or absent mean "leave it alone";
// a `title` of "" clears an existing title. Returns the normalized request
// with every field present (null where not requested), or the reason it is
// invalid.
export function normalizeGroupConfig(value) {
  const invalid = (reason) => ({ valid: false, reason });
  if (value === null || typeof value !== "object") return invalid("must be an object");
  const title = value.title ?? null;
  const color = value.color ?? null;
  if (title !== null && !isValidGroupTitle(title)) {
    return invalid(`title must be plain text of at most ${MAX_GROUP_TITLE_LENGTH} characters with no control characters`);
  }
  if (color !== null && !isValidGroupColor(color)) return invalid(`color must be one of: ${TAB_GROUP_COLORS.join(", ")}`);
  if (!isValidHandle(value.windowId)) return invalid("windowId must be a non-negative safe integer");

  if (value.operation === "create") {
    if (!isValidHandle(value.tabId)) return invalid("tabId must be a non-negative safe integer");
    if (title === "") return invalid("a new group cannot be created with an empty title");
    return { valid: true, config: { operation: "create", tabId: value.tabId, windowId: value.windowId, title, color } };
  }
  if (value.operation === "update") {
    if (!isValidHandle(value.groupId)) return invalid("groupId must be a non-negative safe integer");
    if (!isValidGroupTitle(value.expectedTitle)) return invalid("expectedTitle must be the group's current title (a string)");
    if (!isValidGroupColor(value.expectedColor)) return invalid("expectedColor must be the group's current color");
    const changes = (title !== null && title !== value.expectedTitle) || (color !== null && color !== value.expectedColor);
    if (!changes) return invalid("the request must change the group's title or color");
    return {
      valid: true,
      config: {
        operation: "update",
        groupId: value.groupId,
        windowId: value.windowId,
        expectedTitle: value.expectedTitle,
        expectedColor: value.expectedColor,
        title,
        color,
      },
    };
  }
  return invalid('operation must be "create" or "update"');
}

// Phase 2 Action 3: the one place a move-tabs request is validated, shared by
// the service (when a preview is stored) and the extension (re-checked before
// any mutation). `tabs` lists 1..MAX_MOVE_TABS distinct tabs, each with the
// `groupId` it was in when previewed (-1 for none), all in `windowId`. The
// destination is either `existing` (`groupId` in that window, with its
// previewed `expectedTitle`/`expectedColor`; at least one listed tab must not
// already be in it; no title/color — Action 2 renames and recolors) or `new`
// (a group created around all the tabs, with an optional title and/or color).
// Returns the normalized request with only the bound fields, or the reason it
// is invalid. Extra fields (e.g. a stored preview's display text) are ignored.
export function normalizeMoveConfig(value) {
  const invalid = (reason) => ({ valid: false, reason });
  if (value === null || typeof value !== "object") return invalid("must be an object");
  if (!isValidHandle(value.windowId)) return invalid("windowId must be a non-negative safe integer");
  if (!Array.isArray(value.tabs) || value.tabs.length < 1 || value.tabs.length > MAX_MOVE_TABS) {
    return invalid(`tabs must list between 1 and ${MAX_MOVE_TABS} tabs`);
  }
  const seen = new Set();
  const tabs = [];
  for (const entry of value.tabs) {
    if (entry === null || typeof entry !== "object" || !isValidHandle(entry.tabId)) {
      return invalid("every tab needs a tabId that is a non-negative safe integer");
    }
    if (seen.has(entry.tabId)) return invalid("tabs must not repeat a tabId");
    seen.add(entry.tabId);
    if (entry.groupId !== TAB_GROUP_ID_NONE && !isValidHandle(entry.groupId)) {
      return invalid("every tab needs its current groupId (-1 when it is in no group)");
    }
    tabs.push({ tabId: entry.tabId, groupId: entry.groupId });
  }

  const title = value.title ?? null;
  const color = value.color ?? null;
  if (value.destination === "new") {
    if (title !== null && !isValidGroupTitle(title)) {
      return invalid(`title must be plain text of at most ${MAX_GROUP_TITLE_LENGTH} characters with no control characters`);
    }
    if (title === "") return invalid("a new group cannot be created with an empty title");
    if (color !== null && !isValidGroupColor(color)) return invalid(`color must be one of: ${TAB_GROUP_COLORS.join(", ")}`);
    return { valid: true, config: { destination: "new", windowId: value.windowId, tabs, title, color } };
  }
  if (value.destination === "existing") {
    if (title !== null || color !== null) return invalid("a move into an existing group does not rename or recolor it");
    if (!isValidHandle(value.groupId)) return invalid("groupId must be a non-negative safe integer");
    if (!isValidGroupTitle(value.expectedTitle)) return invalid("expectedTitle must be the group's current title (a string)");
    if (!isValidGroupColor(value.expectedColor)) return invalid("expectedColor must be the group's current color");
    if (tabs.every((tab) => tab.groupId === value.groupId)) return invalid("every listed tab is already in the group");
    return {
      valid: true,
      config: {
        destination: "existing",
        windowId: value.windowId,
        tabs,
        groupId: value.groupId,
        expectedTitle: value.expectedTitle,
        expectedColor: value.expectedColor,
      },
    };
  }
  return invalid('destination must be "existing" or "new"');
}

// Every status a `browser.*` result's envelope may carry. "incomplete" is
// used only by `browser.query_history`, when its explicit scan ceiling
// (MAX_HISTORY_SCAN) is reached before a full page can be determined — see
// queryHistory in extension/service-worker.js.
export const ALLOWED_RESULT_STATUSES = Object.freeze(["ok", "unsupported", "not_ready", "error", "incomplete"]);

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isValidRecordList(value, isValidRecord) {
  return Array.isArray(value) && value.every(isValidRecord);
}

// Mirrors normalizeWindow's output shape (extension/protocol.js).
function isValidWindowRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isValidHandle(value.windowId) &&
    typeof value.focused === "boolean" &&
    typeof value.type === "string" &&
    typeof value.state === "string" &&
    isNonNegativeInteger(value.tabCount)
  );
}

// Mirrors normalizeTab's output shape.
export function isValidTabRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isValidHandle(value.tabId) &&
    isValidHandle(value.windowId) &&
    isNonNegativeInteger(value.index) &&
    typeof value.active === "boolean" &&
    typeof value.pinned === "boolean" &&
    typeof value.audible === "boolean" &&
    typeof value.discarded === "boolean" &&
    typeof value.status === "string" &&
    isNullableString(value.title) &&
    isNullableString(value.url)
  );
}

// Mirrors normalizeTabGroup's output shape.
function isValidTabGroupRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isValidHandle(value.groupId) &&
    isValidHandle(value.windowId) &&
    isNullableString(value.title) &&
    isNullableString(value.color) &&
    typeof value.collapsed === "boolean"
  );
}

// What `browser.inspect_group_target` reports about a tab: enough to bind a
// preview (its window, whether it is already in a group) and to show the user
// which tab it is, and whether it is pinned (a pinned tab is never grouped).
// `title`/`url` are untrusted browser content.
function isValidInspectedTab(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isValidHandle(value.tabId) &&
    isValidHandle(value.windowId) &&
    typeof value.grouped === "boolean" &&
    typeof value.pinned === "boolean" &&
    isNullableString(value.title) &&
    isNullableString(value.url)
  );
}

// Phase 2 Action 3: 1..MAX_MOVE_TABS records, each valid.
function isValidMoveList(value, isValidRecord) {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_MOVE_TABS && value.every(isValidRecord);
}

// A tab's group membership: a group handle, or the explicit "no group" id.
function isValidMembership(value) {
  return value === TAB_GROUP_ID_NONE || isValidHandle(value);
}

// What `browser.inspect_move_target` reports about one selected tab.
// `title`/`url` are untrusted browser content.
function isValidInspectedMoveTab(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isValidHandle(value.tabId) &&
    isValidHandle(value.windowId) &&
    isValidMembership(value.groupId) &&
    typeof value.pinned === "boolean" &&
    isNullableString(value.title) &&
    isNullableString(value.url)
  );
}

// One moved tab as read back after the move.
function isValidObservedMoveTab(value) {
  return value !== null && typeof value === "object" && isValidHandle(value.tabId) && isValidHandle(value.windowId) && isValidMembership(value.groupId);
}

// Mirrors normalizeHistoryEntry's output shape.
function isValidHistoryEntryRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isNullableString(value.id) &&
    isNullableString(value.url) &&
    isNullableString(value.title) &&
    (value.lastVisitTime === null || isValidTimestamp(value.lastVisitTime)) &&
    isNonNegativeInteger(value.visitCount) &&
    isNonNegativeInteger(value.typedCount)
  );
}

// Per-method checks for a successful ("ok") result's method-specific fields,
// beyond the common envelope validated by validateMethodResult below —
// including each list's own entries (never merely "it is an array"),
// returnedCount/totalCount consistency, and read_tab's character-count/
// truncation-flag consistency. Kept as a plain object (not used for
// property lookup by caller-controlled keys — `method` is always one of the
// fixed strings routeMessage already dispatched on), so there is no
// prototype-pollution surface here.
const OK_SHAPE_VALIDATORS = {
  "browser.list_windows": (result) =>
    isValidRecordList(result.windows, isValidWindowRecord) &&
    isNonNegativeInteger(result.returnedCount) &&
    isNonNegativeInteger(result.totalCount) &&
    result.returnedCount === result.windows.length &&
    result.totalCount >= result.returnedCount &&
    typeof result.truncated === "boolean",

  "browser.list_tabs": (result) =>
    isValidHandle(result.windowId) &&
    isValidRecordList(result.tabs, isValidTabRecord) &&
    isNonNegativeInteger(result.returnedCount) &&
    isNonNegativeInteger(result.totalCount) &&
    result.returnedCount === result.tabs.length &&
    result.totalCount >= result.returnedCount &&
    typeof result.truncated === "boolean",

  "browser.list_tab_groups": (result) =>
    isValidHandle(result.windowId) &&
    isValidRecordList(result.groups, isValidTabGroupRecord) &&
    isNonNegativeInteger(result.returnedCount) &&
    isNonNegativeInteger(result.totalCount) &&
    result.returnedCount === result.groups.length &&
    result.totalCount >= result.returnedCount &&
    typeof result.truncated === "boolean",

  "browser.read_tab": (result) => {
    if (
      !isValidHandle(result.tabId) ||
      !isValidHandle(result.windowId) ||
      !isNullableString(result.url) ||
      !isNullableString(result.title) ||
      typeof result.documentReadyState !== "string" ||
      typeof result.text !== "string" ||
      !isNonNegativeInteger(result.characterCount) ||
      !isNonNegativeInteger(result.returnedCharacterCount) ||
      typeof result.truncated !== "boolean"
    ) {
      return false;
    }
    if (result.returnedCharacterCount !== result.text.length) return false;
    if (result.characterCount < result.returnedCharacterCount) return false;
    // "truncated" must exactly reflect whether the full text exceeded what
    // was actually returned — never claimed true with nothing cut, nor
    // false while characters were in fact dropped.
    const actuallyTruncated = result.characterCount > result.returnedCharacterCount;
    return result.truncated === actuallyTruncated;
  },

  "browser.query_history": (result) => {
    if (
      !isValidTimestamp(result.startTime) ||
      !isValidTimestamp(result.endTime) ||
      result.startTime > result.endTime ||
      !isValidRecordList(result.entries, isValidHistoryEntryRecord) ||
      !isNonNegativeInteger(result.returnedCount) ||
      typeof result.truncated !== "boolean" ||
      !(result.nextCursor === null || isValidHandle(result.nextCursor))
    ) {
      return false;
    }
    return result.returnedCount === result.entries.length;
  },

  // Phase 2 Action 1: a fully observed open. `tab` is the browser's own
  // `tabs.get` answer after the one `tabs.create`, not an echo of the request.
  "browser.open_tab": (result) =>
    result.created === true &&
    isNonEmptyString(result.requestedUrl) &&
    isValidTabRecord(result.tab) &&
    isNullableString(result.pendingUrl),

  // Phase 2 Action 2: a read-only look at the one tab or group a preview is
  // about — exactly one of `tab` / `group` is an object, the other `null`. A
  // group's color must be one of the native enum values.
  "browser.inspect_group_target": (result) => {
    const { tab, group } = result;
    if (!((tab === null && group !== null) || (tab !== null && group === null))) return false;
    if (tab !== null) return isValidInspectedTab(tab);
    return isValidTabGroupRecord(group) && isValidGroupColor(group.color);
  },

  // Phase 2 Action 2: a fully observed group change. `group` is the browser's
  // own `tabGroups.get` answer after the mutation, not an echo of the request.
  // `tabId` is the grouped tab for a create and `null` for an update.
  "browser.configure_group": (result) =>
    result.changed === true &&
    (result.operation === "create" || result.operation === "update") &&
    isValidTabGroupRecord(result.group) &&
    (result.operation === "create" ? isValidHandle(result.tabId) : result.tabId === null),

  // Phase 2 Action 3, read-only: every selected tab's current window, group
  // membership (-1 for none), and pinned state in the order asked, plus the
  // existing destination group when one was asked about (otherwise `null`).
  "browser.inspect_move_target": (result) =>
    isValidMoveList(result.tabs, isValidInspectedMoveTab) &&
    (result.group === null || (isValidTabGroupRecord(result.group) && isValidGroupColor(result.group.color))),

  // Phase 2 Action 3: a fully observed move. `group` and every entry of `tabs`
  // (in the order requested) are the browser's own `tabGroups.get` /
  // `tabs.get` answers after the single `tabs.group`, not an echo of the request.
  "browser.move_tabs": (result) =>
    result.changed === true &&
    (result.destination === "new" || result.destination === "existing") &&
    isValidTabGroupRecord(result.group) &&
    isValidMoveList(result.tabs, isValidObservedMoveTab),

  "browser.get_capabilities": (result) =>
    result.protocolVersion === PROTOCOL_VERSION &&
    typeof result.tabGroups === "boolean" &&
    typeof result.history === "boolean" &&
    typeof result.scripting === "boolean" &&
    isPositiveInteger(result.maxTextCharacters) &&
    isPositiveInteger(result.maxWindowsReturned) &&
    isPositiveInteger(result.maxTabsReturned) &&
    isPositiveInteger(result.maxTabGroupsReturned) &&
    isPositiveInteger(result.maxHistoryResults),
};

// Validates an extension's `browser.*` response — envelope plus
// method-specific shape — before the service boundary (service/server.mjs)
// ever returns it to an HTTP caller with a 200. The extension sits at a
// trust boundary (project.md's trust model): its output is checked like any
// other untrusted input, not assumed correct. A legacy (pre-Stage-2) array
// response, a result for the wrong method, or any other malformed shape is
// rejected here rather than forwarded.
//
// `method` is the method the caller actually requested (not merely
// whatever `result.sourceOperation` claims), so a mismatch between the two
// is itself a validation failure, not silently trusted.
export function validateMethodResult(method, result) {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return { valid: false, reason: "result is not a plain object" };
  }
  if (result.schemaVersion !== RESULT_SCHEMA_VERSION) {
    return { valid: false, reason: `schemaVersion must be ${RESULT_SCHEMA_VERSION}` };
  }
  if (!isNonEmptyString(result.browserSessionId)) {
    return { valid: false, reason: "browserSessionId must be a non-empty string" };
  }
  if (result.sourceOperation !== method) {
    return { valid: false, reason: `sourceOperation must exactly match the requested method "${method}"` };
  }
  if (!Number.isFinite(result.capturedAt) || result.capturedAt < 0) {
    return { valid: false, reason: "capturedAt must be a non-negative finite number" };
  }
  if (!ALLOWED_RESULT_STATUSES.includes(result.status)) {
    return { valid: false, reason: `status must be one of: ${ALLOWED_RESULT_STATUSES.join(", ")}` };
  }

  if (result.status === "ok") {
    const validator = Object.hasOwn(OK_SHAPE_VALIDATORS, method) ? OK_SHAPE_VALIDATORS[method] : null;
    if (validator && !validator(result)) {
      return { valid: false, reason: `"ok" result for "${method}" is missing required fields or has the wrong shape` };
    }
    return { valid: true };
  }

  // "error" / "unsupported" / "not_ready" / "incomplete" all require a
  // stable, non-empty code identifying the specific outcome.
  if (!isNonEmptyString(result.code)) {
    return { valid: false, reason: `a "${result.status}" result must carry a non-empty "code"` };
  }
  if (method === "browser.open_tab" && !isValidOpenTabNonOkShape(result)) {
    return { valid: false, reason: `a "${result.status}" result for "${method}" must state whether a tab was created, consistently` };
  }
  if (method === "browser.configure_group" && !isValidConfigureGroupNonOkShape(result)) {
    return { valid: false, reason: `a "${result.status}" result for "${method}" must state whether the browser was changed, consistently` };
  }
  if (method === "browser.move_tabs" && !isValidMoveTabsNonOkShape(result)) {
    return { valid: false, reason: `a "${result.status}" result for "${method}" must state whether the browser was changed, consistently` };
  }
  return { valid: true };
}

// A non-"ok" `browser.move_tabs` result states whether the browser changed in
// one of three ways. `changed: false`: a refusal or failure before the one
// `tabs.group` call, with nothing changed. `changed: null`: that call was
// attempted but whether it changed the browser is unknown (it rejected, or a
// new-group call resolved without a usable group id) — always a plain `error`.
// `changed: true`: the call resolved with a usable destination group, so a move
// is known to have been made, and the result is `incomplete` (a new group's
// title/color update failed, or the read-back failed or showed fewer tabs than
// requested). Its `tabIds` is `null` (no tab was observed in the destination, or
// observation was unavailable) or the ordered list of the tabs that *were*
// observed there — never a claim that every requested tab was; a full ok result
// is the only one that says so.
function isValidMoveTabsNonOkShape(result) {
  if (result.changed === false) return result.status !== "incomplete";
  if (result.changed === null) return result.status === "error";
  return (
    result.changed === true &&
    result.status === "incomplete" &&
    (result.code === ERROR_CODES.OBSERVE_FAILED || result.code === ERROR_CODES.GROUP_UPDATE_FAILED) &&
    (result.groupId === null || isValidHandle(result.groupId)) &&
    (result.windowId === null || isValidHandle(result.windowId)) &&
    (result.tabIds === null || isValidMoveList(result.tabIds, isValidHandle))
  );
}

// A non-"ok" `browser.configure_group` result must say whether the browser was
// changed. Every refusal or failure is `changed: false`; the partial outcomes —
// a new group was created but its title/color update failed, or a change was
// made but the observation was not — are `status: "incomplete"`,
// `changed: true`, and carry whatever handles are known (null if none).
function isValidConfigureGroupNonOkShape(result) {
  if (result.changed === false) return result.status !== "incomplete";
  return (
    result.changed === true &&
    result.status === "incomplete" &&
    (result.code === ERROR_CODES.OBSERVE_FAILED || result.code === ERROR_CODES.GROUP_UPDATE_FAILED) &&
    (result.groupId === null || isValidHandle(result.groupId)) &&
    (result.windowId === null || isValidHandle(result.windowId)) &&
    (result.tabId === null || isValidHandle(result.tabId))
  );
}

// A non-"ok" `browser.open_tab` result must say whether the browser was
// mutated. Every refusal or failure is `created: false`; the one partial
// outcome — `tabs.create` succeeded but the `tabs.get` observation did not —
// is `status: "incomplete"`, `created: true`, and carries whatever handles
// `tabs.create` returned (null if it returned none).
function isValidOpenTabNonOkShape(result) {
  if (result.created === false) return result.status !== "incomplete";
  return (
    result.created === true &&
    result.status === "incomplete" &&
    result.code === ERROR_CODES.OBSERVE_FAILED &&
    (result.tabId === null || isValidHandle(result.tabId)) &&
    (result.windowId === null || isValidHandle(result.windowId))
  );
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

// Only called where the browser reports tabGroups support at runtime (see
// listTabGroups in extension/service-worker.js); a browser whose current
// version lacks a tabGroups API (e.g. Firefox, as of this writing) reports
// that via capability status — determined by feature-detecting the API
// itself, not by checking the browser's name — never via an
// empty/invented list.
export function normalizeTabGroup(group) {
  return {
    groupId: group.id,
    windowId: group.windowId,
    title: group.title ?? null,
    color: group.color ?? null,
    collapsed: Boolean(group.collapsed),
  };
}

// chrome.history.search() entries. `url`/`title` are untrusted browser
// content (project.md trust model) carried through as data, never executed
// or treated as instructions.
export function normalizeHistoryEntry(entry) {
  return {
    id: entry.id !== undefined ? String(entry.id) : null,
    url: entry.url ?? null,
    title: entry.title ?? null,
    lastVisitTime: entry.lastVisitTime ?? null,
    visitCount: entry.visitCount ?? 0,
    typedCount: entry.typedCount ?? 0,
  };
}

// Deterministic ordering for history entries sharing the browser's own
// `chrome.history.search` result set: most-recent-first by `lastVisitTime`,
// tie-broken by the browser's own stable per-URL `id` so that offset-based
// pagination (see queryHistory in extension/service-worker.js) never
// depends on whatever incidental order the browser happened to return
// same-timestamp entries in.
export function compareHistoryEntries(a, b) {
  const timeDiff = (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0);
  if (timeDiff !== 0) return timeDiff;
  const idA = String(a.id ?? "");
  const idB = String(b.id ?? "");
  if (idA < idB) return -1;
  if (idA > idB) return 1;
  return 0;
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
