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
// extension<->service WebSocket. A client or extension on a different version
// gets a stable `unsupported_protocol_version` error instead of an undefined
// result.
//
// Version 7 is the reduced contract: five reads (`browser.list_windows`,
// `browser.list_tabs`, `browser.read_tab`, `browser.list_tab_groups`,
// `browser.query_history`) and three direct tab-group mutations
// (`browser.create_tab_group`, `browser.update_tab_group`,
// `browser.move_tabs`). Earlier versions carried preview/approval actions and
// other methods that no longer exist, so the handshake refuses any older
// extension outright.
export const PROTOCOL_VERSION = 7;

// The most tabs one mutation request may name. Bounds the request body, the
// extension requests, and the single `tabs.group` / `tabs.ungroup` call.
export const MAX_TAB_IDS = 100;

// Tab-group configuration. The colors are Chrome's native `tabGroups.Color`
// enum, passed through unchanged. A title is plain text of at most this many
// characters; on update the empty string is the explicit "remove the title"
// value (an omitted/null title means "leave it alone").
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
  // Mutation outcomes. Refusals made after re-reading current browser state,
  // before anything is changed: a pinned tab, tabs (or the destination group)
  // in more than one window, and a request that would change nothing.
  PINNED_TAB: "pinned_tab",
  WINDOW_MISMATCH: "window_mismatch",
  NO_CHANGE: "no_change",
  // The one mutation call (`tabs.group`, `tabs.ungroup`, or
  // `tabGroups.update`) rejected. A rejection does not prove nothing changed,
  // so these always travel with `changed: null`.
  GROUP_FAILED: "group_failed",
  UNGROUP_FAILED: "ungroup_failed",
  // For a new group, the follow-up title/color update rejected after the
  // group was created (a partial outcome); for an update, the one update call
  // rejected (an unknown outcome).
  GROUP_UPDATE_FAILED: "group_update_failed",
  // A mutation call resolved but its read-back failed or did not show the
  // requested state (a partial outcome).
  OBSERVE_FAILED: "observe_failed",
  // A mutation request body larger than the service accepts.
  PAYLOAD_TOO_LARGE: "payload_too_large",
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

// Shared by the service (before forwarding) and the extension (re-checked
// before any mutation). Plain text only: bounded, no control characters. The
// empty string is valid here — on update it removes the title.
export function isValidGroupTitle(value) {
  return typeof value === "string" && value.length <= MAX_GROUP_TITLE_LENGTH && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

export function isValidGroupColor(value) {
  return typeof value === "string" && TAB_GROUP_COLORS.includes(value);
}

// Mutation request validation, shared by the service (before forwarding) and
// the extension (re-checked before any mutation). Each returns the normalized
// request with every field present (null where not requested), or the reason
// it is invalid. Unknown fields are refused rather than ignored, so a caller
// never believes an unsupported option (a window, an index, a collapsed state)
// took effect. `browserSessionId` is allowed here but checked separately: a
// missing or mismatched session is a `stale_session` outcome, not a shape error.
function invalidRequest(reason) {
  return { valid: false, reason };
}

function requestObjectError(value, allowedFields) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "request must be a JSON object";
  const extra = Object.keys(value).find((key) => !allowedFields.includes(key));
  return extra === undefined ? null : `unexpected field "${extra}"`;
}

function tabIdsError(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length < 1 || tabIds.length > MAX_TAB_IDS || !tabIds.every(isValidHandle)) {
    return `tabIds must list 1 to ${MAX_TAB_IDS} non-negative safe integers`;
  }
  return new Set(tabIds).size === tabIds.length ? null : "tabIds must not repeat a tab";
}

function titleColorError(title, color) {
  if (title !== null && !isValidGroupTitle(title)) {
    return `title must be plain text of at most ${MAX_GROUP_TITLE_LENGTH} characters with no control characters`;
  }
  if (color !== null && !isValidGroupColor(color)) return `color must be one of: ${TAB_GROUP_COLORS.join(", ")}`;
  return null;
}

// `browser.create_tab_group`: a new group around 1..MAX_TAB_IDS distinct tabs,
// with an optional title and color. A group is never created empty, and a new
// group's title is either omitted or non-empty.
export function normalizeCreateTabGroupRequest(value) {
  const shapeError = requestObjectError(value, ["browserSessionId", "tabIds", "title", "color"]);
  if (shapeError) return invalidRequest(shapeError);
  const tabsError = tabIdsError(value.tabIds);
  if (tabsError) return invalidRequest(tabsError);
  const title = value.title ?? null;
  const color = value.color ?? null;
  const fieldError = titleColorError(title, color);
  if (fieldError) return invalidRequest(fieldError);
  if (title === "") return invalidRequest("a new group's title must not be empty; omit title to create a group without one");
  return { valid: true, request: { tabIds: [...value.tabIds], title, color } };
}

// `browser.update_tab_group`: renames and/or recolors one existing group.
// At least one of `title`/`color` is required; `title: ""` removes the title.
// Whether it would actually change anything is decided against the group's
// current state, in the extension.
export function normalizeUpdateTabGroupRequest(value) {
  const shapeError = requestObjectError(value, ["browserSessionId", "groupId", "title", "color"]);
  if (shapeError) return invalidRequest(shapeError);
  if (!isValidHandle(value.groupId)) return invalidRequest("groupId must be a non-negative safe integer");
  const title = value.title ?? null;
  const color = value.color ?? null;
  const fieldError = titleColorError(title, color);
  if (fieldError) return invalidRequest(fieldError);
  if (title === null && color === null) return invalidRequest("at least one of title or color is required");
  return { valid: true, request: { groupId: value.groupId, title, color } };
}

// `browser.move_tabs`: moves 1..MAX_TAB_IDS distinct tabs into one existing
// group (`groupId` a handle) or out of their groups (`groupId: null`). The
// destination is always explicit: an absent `groupId` is refused rather than
// read as either meaning.
export function normalizeMoveTabsRequest(value) {
  const shapeError = requestObjectError(value, ["browserSessionId", "tabIds", "groupId"]);
  if (shapeError) return invalidRequest(shapeError);
  const tabsError = tabIdsError(value.tabIds);
  if (tabsError) return invalidRequest(tabsError);
  if (!Object.hasOwn(value, "groupId") || (value.groupId !== null && !isValidHandle(value.groupId))) {
    return invalidRequest("groupId is required: a non-negative safe integer, or null to remove the tabs from their groups");
  }
  return { valid: true, request: { tabIds: [...value.tabIds], groupId: value.groupId } };
}

// Every status a `browser.*` result's envelope may carry. "incomplete" is
// used by `browser.query_history` when its explicit scan ceiling
// (MAX_HISTORY_SCAN) is reached before a full page can be determined (see
// queryHistory in extension/service-worker.js), and by the mutations for a
// change that was made but not completed or fully observed.
export const ALLOWED_RESULT_STATUSES = Object.freeze(["ok", "unsupported", "not_ready", "error", "incomplete"]);

function isNullableString(value) {
  return value === null || typeof value === "string";
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
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
    isValidMembership(value.groupId) &&
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

// 1..MAX_TAB_IDS records, each valid.
function isValidTabIdList(value, isValidRecord) {
  return Array.isArray(value) && value.length >= 1 && value.length <= MAX_TAB_IDS && value.every(isValidRecord);
}

// A tab's group membership: a group handle, or the explicit "no group" id.
function isValidMembership(value) {
  return value === TAB_GROUP_ID_NONE || isValidHandle(value);
}

// One selected tab as read back after a mutation.
function isValidObservedTab(value) {
  return value !== null && typeof value === "object" && isValidHandle(value.tabId) && isValidHandle(value.windowId) && isValidMembership(value.groupId);
}

// An observed group after a mutation: a full group record with a native color.
function isValidObservedGroup(value) {
  return isValidTabGroupRecord(value) && isValidGroupColor(value.color);
}

// Every observed tab is in `groupId` (TAB_GROUP_ID_NONE for "no group") and
// in one window — `windowId` when given.
function tabsObservedIn(tabs, groupId, windowId = tabs[0]?.windowId) {
  return isValidTabIdList(tabs, isValidObservedTab) && tabs.every((tab) => tab.groupId === groupId && tab.windowId === windowId);
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

  // A fully observed new group: `group` and every entry of `tabs` (in the
  // order requested) are the browser's own answers after the mutation, not an
  // echo of the request.
  "browser.create_tab_group": (result) =>
    result.changed === true && isValidObservedGroup(result.group) && tabsObservedIn(result.tabs, result.group.groupId, result.group.windowId),

  // A fully observed rename/recolor: `group` is read back after the update.
  "browser.update_tab_group": (result) => result.changed === true && isValidObservedGroup(result.group),

  // A fully observed move. With a destination group, `group` is that group
  // read back and every tab was observed in it; with `group: null` (an
  // ungroup) every tab was observed in no group.
  "browser.move_tabs": (result) =>
    result.changed === true &&
    (result.group === null
      ? tabsObservedIn(result.tabs, TAB_GROUP_ID_NONE)
      : isValidObservedGroup(result.group) && tabsObservedIn(result.tabs, result.group.groupId, result.group.windowId)),
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
  if (MUTATION_METHODS.includes(method) && !isValidMutationNonOkShape(result)) {
    return { valid: false, reason: `a "${result.status}" result for "${method}" must state whether the browser was changed, consistently` };
  }
  return { valid: true };
}

export const MUTATION_METHODS = Object.freeze(["browser.create_tab_group", "browser.update_tab_group", "browser.move_tabs"]);

// A non-"ok" mutation result states whether the browser changed in one of
// three ways. `changed: false`: refused before the one mutation call, so
// nothing was changed. `changed: null`: that call was attempted but did not
// resolve (or resolved without a usable group id), so whether it changed the
// browser is unknown — always a plain `error`. `changed: true`: the call
// resolved, so a change is known to have been made, but a follow-up step
// (a new group's title/color, or the read-back) did not complete — always
// `incomplete`, carrying the handles that are known (`groupId`/`windowId`
// null when unknown) and `tabIds`: null, or the ordered subset of the
// requested tabs that *were* observed in their requested place. Only an "ok"
// result says every tab was.
function isValidMutationNonOkShape(result) {
  if (result.changed === false) return result.status !== "incomplete";
  if (result.changed === null) return result.status === "error";
  return (
    result.changed === true &&
    result.status === "incomplete" &&
    (result.code === ERROR_CODES.OBSERVE_FAILED || result.code === ERROR_CODES.GROUP_UPDATE_FAILED) &&
    (result.groupId === null || isValidHandle(result.groupId)) &&
    (result.windowId === null || isValidHandle(result.windowId)) &&
    (result.tabIds === null || isValidTabIdList(result.tabIds, isValidHandle))
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

// A tab's group membership as the protocol states it: its group's handle, or
// TAB_GROUP_ID_NONE (-1) for none. A browser that reports no group at all
// (no tab-group support) is consistently "none".
export function tabGroupMembership(tab) {
  return Number.isSafeInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : TAB_GROUP_ID_NONE;
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
    groupId: tabGroupMembership(tab),
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
