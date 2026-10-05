import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { WebSocketServer } from "ws";

import {
  ERROR_CODES,
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_INTERVAL_MS,
  MAX_RESPONSE_BYTES,
  MAX_WS_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  WS_MESSAGE_TYPES,
  validateMethodResult,
} from "../extension/protocol.js";
import { STORE_ERROR_CODES, StoreError } from "./store-errors.mjs";
import { STORE_ERROR_STATUS, STORE_ROUTES } from "./store-routes.mjs";
import { UI_ROUTES, serveUiAsset } from "./ui.mjs";
import { MAX_REQUEST_BODY_BYTES } from "./validation.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;

// Reads a numeric query parameter. `null` (param absent) is passed through
// as `undefined` so the extension side's own validation can distinguish
// "not supplied" from a value, but an explicitly *empty* value (`?id=`) is
// never silently coerced to 0 via `Number("")` — it becomes `NaN`, the same
// as any other malformed numeric string, so it is rejected as
// `invalid_params` there rather than accepted as a real handle.
function numberParam(url, name) {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (raw === "") return NaN;
  return Number(raw);
}

// Reads a string query parameter as-is (including an empty string, which
// the extension side's own session-matching check already rejects as a
// mismatch — no special-casing needed here).
function stringParam(url, name) {
  const raw = url.searchParams.get(name);
  return raw === null ? undefined : raw;
}

// Stage 2: the allowlist of named browser.* methods exposed as GET
// /api/<method> routes, each paired with how to read its parameters off the
// query string. A `Map` (not a plain object or object literal) so route
// lookup can never be confused with inherited `Object.prototype` members —
// `/api/toString` or `/api/__proto__` simply have no entry and 404, rather
// than resolving to a function and crashing when called as a route handler.
// The extension side (extension/service-worker.js) owns the actual
// parameter validation (project.md's trust-boundary convention already
// established in Stage 1), so an absent or unparsable value is rejected
// there as `invalid_params` rather than guessed at here.
const API_ROUTES = new Map([
  ["browser.list_windows", () => ({})],
  [
    "browser.list_tabs",
    (url) => ({ windowId: numberParam(url, "windowId"), browserSessionId: stringParam(url, "browserSessionId") }),
  ],
  [
    "browser.list_tab_groups",
    (url) => ({ windowId: numberParam(url, "windowId"), browserSessionId: stringParam(url, "browserSessionId") }),
  ],
  [
    "browser.read_tab",
    (url) => ({ tabId: numberParam(url, "tabId"), browserSessionId: stringParam(url, "browserSessionId") }),
  ],
  [
    "browser.query_history",
    (url) => ({
      startTime: numberParam(url, "startTime"),
      endTime: numberParam(url, "endTime"),
      maxResults: numberParam(url, "maxResults"),
      cursor: numberParam(url, "cursor"),
    }),
  ],
  ["browser.get_capabilities", () => ({})],
]);

// HTTP statuses for the stable transport-error codes a caller can receive
// from the API route. Anything else is reported as a generic internal error
// rather than leaking an unstable code to the caller.
const ERROR_STATUS = Object.freeze({
  [ERROR_CODES.REQUEST_TIMEOUT]: 504,
  [ERROR_CODES.DISCONNECTED]: 503,
  [ERROR_CODES.SERVICE_SHUTTING_DOWN]: 503,
});

// Stage 4: the one new operation exposed under /api/workflow.<method>,
// alongside the existing browser.* (forward-to-extension) and store.*
// (local-store) namespaces. `workflow.capture_tab` is the *only*
// capture-creation path exposed to external-agent scope (see
// AGENT_ALLOWED_STORE_METHODS below, which deliberately excludes
// `store.captures.create`): it takes a tabId/browserSessionId, performs the
// real `browser.read_tab` round trip itself, and persists exactly that
// freshly-fetched, already-validated result — never a caller-supplied
// capture body — so stored browser evidence cannot be forged by submitting
// arbitrary JSON (see handleWorkflowMethod below).
const WORKFLOW_ROUTES = new Map([
  [
    "workflow.capture_tab",
    {
      httpMethod: "POST",
      paramsFromQuery: (url) => ({ tabId: numberParam(url, "tabId"), browserSessionId: stringParam(url, "browserSessionId") }),
    },
  ],
]);

// Stage 4: the server-side allowlists an external-agent credential's scope
// is restricted to (project.md Stage 4 remediation: "external-agent scope
// must be server-side allowlisted only to Stage4 operations needed"). The
// owner credential bypasses these entirely (see `authenticate` below) — it
// always has full, unscoped access, exactly as before this stage. Anything
// not listed here is unreachable for agent scope even if the underlying
// route exists for the owner: a 403 `forbidden_scope`, never a silent
// allow, and never implemented as "everything except a denylist."
//
// browser.*: every Stage 2 read-only route — listing/reading browser
// sources is always safe; none of them mutate the browser or persist
// anything.
const AGENT_ALLOWED_BROWSER_METHODS = new Set([
  "browser.list_windows",
  "browser.list_tabs",
  "browser.list_tab_groups",
  "browser.read_tab",
  "browser.query_history",
  "browser.get_capabilities",
]);
// workflow.*: the one capture-creation path agent scope may use.
const AGENT_ALLOWED_WORKFLOW_METHODS = new Set(["workflow.capture_tab"]);
// Stage 5 remediation: `owner.status` (handleOwnerStatus, below) is
// deliberately not reachable through any AGENT_ALLOWED_* set at all —
// like `/control/stop`, it is owner-only by its own explicit scope check,
// not by omission from an allowlist that merely happens not to name it.
// store.*: read evidence already captured, and write only the two derived
// record types Stage 4's workflow needs (summaries, proposals) — never
// update/delete, never tags/collections/queue, never retention/clear, and
// never a direct `store.captures.create` (which would let a caller assert
// arbitrary "evidence" instead of going through workflow.capture_tab above).
const AGENT_ALLOWED_STORE_METHODS = new Set([
  "store.captures.list",
  "store.captures.read",
  "store.summaries.create",
  "store.summaries.list",
  "store.proposals.create",
  "store.proposals.list",
]);

function forbiddenScopeResponse(requestId, name) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId,
    error: { code: ERROR_CODES.FORBIDDEN_SCOPE, detail: `"${name}" is not permitted for this credential's scope` },
  };
}

function timingSafeTokenEquals(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Browser-extension origin schemes only: `chrome-extension://` (Chrome-family)
// and `moz-extension://` (Firefox sends this as the WebSocket Origin for a
// background script). An ordinary web page cannot claim either scheme.
function isTrustedExtensionOrigin(origin) {
  return (
    typeof origin === "string" && (origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://"))
  );
}

// Stage 5 remediation: Host-header defense against DNS rebinding and
// similar Host-header-confusion attacks. This service binds only to
// 127.0.0.1 (project.md's trust model), but loopback binding alone is not
// sufficient isolation: a page served from an attacker-controlled DNS name
// that *resolves* to 127.0.0.1 causes the victim's own browser to issue an
// ordinary same-origin-looking request here, with the Host header set from
// the navigated-to hostname — not the resolved IP. project.md's trust model
// already makes exactly this point about the extension WebSocket's Origin
// check ("Loopback alone is not authentication"); this is the HTTP-side
// counterpart, applied before anything else — serving the UI, answering
// /health, or dispatching an authenticated /api/ or /control/ route — ever
// happens for a request whose own Host header is not this exact, literal,
// canonical value.
//
// The only accepted Host is `127.0.0.1:<port>`, where `<port>` must be the
// exact port *this connection* is actually being served on
// (`req.socket.localPort`) — never merely "any 127.0.0.1", and never
// derived from a configured/expected port that could drift from what the
// server actually bound (this also makes the check correct for an
// ephemeral `port: 0` test listener, whose real port is only known after
// `listen()`). A missing Host header, more than one Host header value, or
// anything not matching this exact pattern is rejected the same way.
const CANONICAL_LOOPBACK_HOST_PATTERN = /^127\.0\.0\.1:(\d{1,5})$/;

function isCanonicalLoopbackHost(hostHeader, expectedPort) {
  if (typeof hostHeader !== "string") return false;
  const match = CANONICAL_LOOPBACK_HOST_PATTERN.exec(hostHeader.trim());
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 && port === expectedPort;
}

// Returns `null` when the request's Host header is the canonical
// `127.0.0.1:<this connection's actual listening port>`, or a failure
// descriptor (`{ status, error }`, HTTP 421 Misdirected Request — distinct
// from every other 4xx this service returns, so a caller/test can tell
// this apart from a malformed request, a bad credential, or an
// unsupported protocol version) otherwise. `req.socket.localPort` is used
// rather than any value captured at `listen()` time, so this is always
// correct for the port the request actually arrived on.
function checkHost(req) {
  const expectedPort = req.socket.localPort;
  if (isCanonicalLoopbackHost(req.headers.host, expectedPort)) return null;
  return {
    status: 421,
    error: {
      code: ERROR_CODES.INVALID_HOST,
      detail: `expected Host: 127.0.0.1:${expectedPort}`,
    },
  };
}

// True if the request declares any body framing at all — a `Content-Length`
// other than exactly "0", or any `Transfer-Encoding` (chunked bodies carry
// no Content-Length). Used to reject a body on a route that never reads
// one (workflow.capture_tab), so a forged body can never be silently
// ignored and then mistaken for having had no effect.
function hasRequestBodyFraming(req) {
  const contentLength = req.headers["content-length"];
  if (typeof contentLength === "string" && contentLength !== "0") return true;
  return req.headers["transfer-encoding"] !== undefined;
}

function respondJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

// Creates the Stage 1 local bridge: an HTTP API bound to loopback, a
// WebSocket endpoint the extension connects out to, and the request
// correlation between them. Does not call `listen()` itself, so tests can
// bind an ephemeral port.
export function createService({
  credentialToken,
  // Stage 4: the separate, scoped external-agent credential (see
  // service/credential.mjs's loadOrCreateAgentCredential). Optional so
  // every existing Stage 1/2/3 test/caller that never configures one keeps
  // exactly its prior behavior: with no agent token configured, only
  // `credentialToken` (owner) authenticates at all, same as before this
  // stage.
  agentCredentialToken = null,
  // Stage 4: the fixed, server-controlled creator identity bound to every
  // derived record an agent-scoped write creates (summaries, proposals) —
  // never the identity the caller's request body claims. See
  // handleStoreMethod's creator-override step below.
  agentCreatorName = "reference-agent",
  host = "127.0.0.1",
  port = 0,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  heartbeatGraceMs = HEARTBEAT_GRACE_MS,
  // Stage 3: the derived store (service/store.mjs). Optional so Stage 1/2
  // tests that only exercise the browser-bridge routes can keep constructing
  // a service without one; any store.* route then explicitly reports
  // `store_unavailable` (503) rather than crashing.
  store = null,
  maxStoreRequestBodyBytes = MAX_REQUEST_BODY_BYTES,
  // Conservative request-rate and response-size bounds enforced at this
  // service boundary (project.md Stage 2), independent of whatever an
  // individual browser operation itself bounds. Overridable so tests can
  // exercise both limits without waiting on production-sized windows.
  rateLimitWindowMs = RATE_LIMIT_WINDOW_MS,
  rateLimitMaxRequests = RATE_LIMIT_MAX_REQUESTS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  // Inbound WebSocket message cap, independent of (but deliberately sized
  // around) `maxResponseBytes` above. Overridable so a test can exercise
  // the bound directly without needing to send a multi-megabyte message.
  maxWsMessageBytes = MAX_WS_MESSAGE_BYTES,
  // Invoked (not awaited) after a successful authenticated POST
  // /control/stop response has been flushed to the caller. The CLI wires
  // this to the same graceful-shutdown routine used for SIGINT/SIGTERM, so
  // "stop" works by asking the service itself to shut down rather than by
  // signaling a PID that might have been reused by an unrelated process.
  onControlStop = async () => {},
  log = () => {},
}) {
  // Fails fast, before any socket is ever opened: an agent credential equal
  // to the owner credential would let the external-agent token authenticate
  // with full owner scope (see `authenticate` below, which checks the owner
  // token first but would still grant "owner" for a presented token equal
  // to it either way) — exactly the privilege escalation Stage 4's separate
  // scoped credential exists to prevent.
  if (typeof agentCredentialToken === "string" && agentCredentialToken.length > 0 && timingSafeTokenEquals(agentCredentialToken, credentialToken)) {
    throw new Error("agentCredentialToken must not equal credentialToken: a shared token would grant the external-agent credential owner scope");
  }

  const startedAt = Date.now();
  let extensionSocket = null;
  let extensionConnectedAt = null;
  let shuttingDown = false;

  // Fixed-window counter shared across all API callers: this project's
  // trust model is a single local user and one connected browser profile
  // (project.md), so one global counter is sufficient conservative
  // protection against a runaway or malicious local caller flooding the
  // extension, without the complexity of per-client tracking.
  let rateWindowStart = Date.now();
  let rateWindowCount = 0;
  function checkRateLimit() {
    const now = Date.now();
    if (now - rateWindowStart >= rateLimitWindowMs) {
      rateWindowStart = now;
      rateWindowCount = 0;
    }
    rateWindowCount += 1;
    return rateWindowCount <= rateLimitMaxRequests;
  }

  // Authenticates a request and reports which *scope* the presented
  // credential carries — `"owner"` (the original pairing credential, full
  // access, unchanged from before Stage 4) or `"agent"` (the separate,
  // restricted external-agent credential; see the AGENT_ALLOWED_* sets
  // above). Returns `{ ok: true, scope }` on success or `{ ok: false,
  // status, error }` on failure, so every call site can branch on scope
  // without re-deriving it. Both tokens are compared with the same
  // timing-safe comparison used before this stage; agentCredentialToken
  // being unset (the default) means no token other than the owner's can
  // ever authenticate, exactly matching this project's behavior before
  // Stage 4.
  function authenticate(req) {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(.+)$/.exec(header) : null;
    if (!match) return { ok: false, status: 401, error: { code: ERROR_CODES.MISSING_CREDENTIAL } };
    const presented = match[1];
    if (timingSafeTokenEquals(presented, credentialToken)) return { ok: true, scope: "owner" };
    if (typeof agentCredentialToken === "string" && agentCredentialToken.length > 0 && timingSafeTokenEquals(presented, agentCredentialToken)) {
      return { ok: true, scope: "agent" };
    }
    return { ok: false, status: 401, error: { code: ERROR_CODES.INVALID_CREDENTIAL } };
  }

  // Strictly required, not merely validated-if-present: a caller that never
  // declares a protocol version is exactly as unsupported as one that
  // declares the wrong one (project.md: "every request has a protocol
  // version"). This rejects requests from any client — including this
  // project's own CLI/tests — that omit the header, by design.
  function checkProtocolVersion(req) {
    const header = req.headers["x-protocol-version"];
    if (header !== undefined && Number(header) === PROTOCOL_VERSION) return null;
    return {
      status: 400,
      error: {
        code: ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION,
        detail:
          header === undefined
            ? `missing required X-Protocol-Version header (expected ${PROTOCOL_VERSION})`
            : `service supports protocol version ${PROTOCOL_VERSION}, got "${header}"`,
      },
    };
  }

  function requestIdFor(req) {
    const header = req.headers["x-request-id"];
    return typeof header === "string" && header.length > 0 && header.length <= 200 ? header : randomUUID();
  }

  // Requests are always sent to whichever socket is current *at send time*,
  // and are owned by that socket's own `pendingRequests` map — never a
  // service-wide map. That is what lets a replaced/closed old connection
  // reject only its own in-flight work, never a newer connection's.
  function sendExtensionRequest(method, params) {
    return new Promise((resolve, reject) => {
      const socket = extensionSocket;
      if (!socket) {
        const error = new Error("No extension connected");
        error.code = ERROR_CODES.DISCONNECTED;
        reject(error);
        return;
      }

      const id = randomUUID();
      const timer = setTimeout(() => {
        socket.pendingRequests.delete(id);
        const error = new Error(`Request "${method}" timed out waiting for the extension`);
        error.code = ERROR_CODES.REQUEST_TIMEOUT;
        reject(error);
      }, requestTimeoutMs);
      socket.pendingRequests.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: WS_MESSAGE_TYPES.REQUEST, protocolVersion: PROTOCOL_VERSION, id, method, params }));
    });
  }

  async function handleApiMethod(method, req, res, url) {
    const requestId = requestIdFor(req);
    const auth = authenticate(req);
    if (!auth.ok) {
      respondJson(res, auth.status, { protocolVersion: PROTOCOL_VERSION, requestId, error: auth.error });
      return;
    }
    // Stage 4: explicit, server-side scope allowlist — the owner scope
    // bypasses this entirely; agent scope may only reach the browser.*
    // methods named in AGENT_ALLOWED_BROWSER_METHODS. Checked before rate
    // limiting/forwarding so a forbidden request never reaches the
    // extension at all.
    if (auth.scope === "agent" && !AGENT_ALLOWED_BROWSER_METHODS.has(method)) {
      respondJson(res, 403, forbiddenScopeResponse(requestId, method));
      return;
    }

    // Checked after authentication (an unauthenticated caller already gets
    // turned away above) but before the extension round trip: a flood of
    // otherwise-valid requests is rejected here at the service boundary,
    // never forwarded to the extension at all.
    if (!checkRateLimit()) {
      respondJson(res, 429, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: ERROR_CODES.RATE_LIMITED } });
      return;
    }

    // Guarded: a route's parameter-extraction function runs against a
    // caller-controlled query string, and must never be allowed to crash
    // the request handler even if it throws unexpectedly.
    let params;
    try {
      params = API_ROUTES.get(method)(url);
    } catch (error) {
      respondJson(res, 500, {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        error: { code: ERROR_CODES.INTERNAL_ERROR, detail: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    try {
      const result = await sendExtensionRequest(method, params);

      // The extension sits at a trust boundary (project.md's trust model):
      // its response is validated like any other untrusted input before
      // ever being forwarded to an HTTP caller with a 200. A legacy
      // (pre-Stage-2) shape, a result for the wrong method, or any other
      // malformed envelope becomes an explicit error here instead of
      // reaching a client as if it were trustworthy. Guarded so a defect in
      // the validator itself can never crash the request handler either.
      let validation;
      try {
        validation = validateMethodResult(method, result);
      } catch (error) {
        validation = { valid: false, reason: `validation itself failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!validation.valid) {
        respondJson(res, 502, {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          error: { code: ERROR_CODES.INVALID_EXTENSION_RESPONSE, detail: validation.reason },
        });
        return;
      }

      const body = { protocolVersion: PROTOCOL_VERSION, requestId, result };
      const payload = JSON.stringify(body);
      // Defense in depth on top of the extension's own per-operation bounds
      // (list/history page sizes, snapshot text length): rejects an
      // unexpectedly oversized response here rather than ever writing it to
      // the socket.
      if (Buffer.byteLength(payload) > maxResponseBytes) {
        respondJson(res, 502, {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          error: { code: ERROR_CODES.RESPONSE_TOO_LARGE },
        });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    } catch (error) {
      const status = ERROR_STATUS[error.code] ?? 502;
      const code = error.code in ERROR_STATUS ? error.code : ERROR_CODES.INTERNAL_ERROR;
      const body = { protocolVersion: PROTOCOL_VERSION, requestId, error: { code } };
      if (!(error.code in ERROR_STATUS)) body.error.detail = error.message;
      respondJson(res, status, body);
    }
  }

  // Reads a request body up to `maxBytes`, rejecting explicitly (never
  // silently truncating) if it is exceeded — the bounded-request-body
  // counterpart to the existing bounded-response enforcement above. Once
  // exceeded, buffering stops (no further chunks are retained, bounding
  // memory) but the connection itself is left alone: destroying/resetting
  // the socket here would tear down the response path before the caller
  // can ever read the stable 413 response this is meant to produce.
  // Remaining inbound data is simply discarded as it arrives. `settled`
  // guards against a double resolve/reject once 'end' eventually fires.
  function readRequestBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      let total = 0;
      let settled = false;
      const chunks = [];
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      req.on("data", (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          const error = new Error("request body exceeds the maximum allowed size");
          error.code = STORE_ERROR_CODES.PAYLOAD_TOO_LARGE;
          fail(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", fail);
    });
  }

  function parseJsonBody(raw) {
    if (raw.length === 0) return {};
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const wrapped = new Error(`request body is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      wrapped.code = STORE_ERROR_CODES.MALFORMED_BODY;
      throw wrapped;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const error = new Error("request body must be a JSON object");
      error.code = STORE_ERROR_CODES.MALFORMED_BODY;
      throw error;
    }
    return parsed;
  }

  // Dispatches one Stage 3 store.* route (service/store-routes.mjs):
  // authenticates and rate-limits exactly like a browser.* route, reads and
  // bounds the request body for POST/PATCH, runs the route against the
  // store, and maps a StoreError's stable code to an HTTP status
  // (STORE_ERROR_STATUS). Deliberately never passes request bodies, query
  // values, or store error detail to `log()` — those can contain captured
  // browser content (project.md Stage 3: "keep credentials and browser
  // content out of logs by default").
  async function handleStoreMethod(name, route, req, res, url) {
    const requestId = requestIdFor(req);
    const auth = authenticate(req);
    if (!auth.ok) {
      respondJson(res, auth.status, { protocolVersion: PROTOCOL_VERSION, requestId, error: auth.error });
      return;
    }
    // Stage 4: agent scope may reach only the store.* methods named in
    // AGENT_ALLOWED_STORE_METHODS — deliberately excluding
    // store.captures.create, every update/delete route, tags/collections/
    // queue entirely, and retention/clear. The owner scope is unaffected.
    if (auth.scope === "agent" && !AGENT_ALLOWED_STORE_METHODS.has(name)) {
      respondJson(res, 403, forbiddenScopeResponse(requestId, name));
      return;
    }
    if (!checkRateLimit()) {
      respondJson(res, 429, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: ERROR_CODES.RATE_LIMITED } });
      return;
    }
    if (!store) {
      respondJson(res, 503, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: "store_unavailable" } });
      return;
    }
    if (req.method !== route.httpMethod) {
      respondJson(res, 405, {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        error: { code: "method_not_allowed", detail: `"${name}" expects ${route.httpMethod}` },
      });
      return;
    }

    let body;
    if (route.httpMethod === "POST" || route.httpMethod === "PATCH") {
      try {
        const raw = await readRequestBody(req, maxStoreRequestBodyBytes);
        body = parseJsonBody(raw);
      } catch (error) {
        const status = error.code === STORE_ERROR_CODES.PAYLOAD_TOO_LARGE ? 413 : 400;
        respondJson(res, status, {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          error: { code: error.code ?? STORE_ERROR_CODES.MALFORMED_BODY, detail: error.message },
        });
        return;
      }
    }

    // Stage 4: an agent-scoped write cannot assert its own creator identity
    // — in particular it cannot claim `creatorType: "user"` to impersonate
    // the local human. Whatever the request body contains for
    // creatorType/creatorName is discarded and replaced with the fixed,
    // server-controlled external-agent identity before the store ever sees
    // it. This is unconditional for any agent-scoped POST/PATCH body (not
    // only the two routes that use these fields): agent scope cannot reach
    // any other mutating store.* route at all (see the allowlist check
    // above), so there is nothing else for this override to affect.
    if (auth.scope === "agent" && body !== undefined && body !== null && typeof body === "object" && !Array.isArray(body)) {
      body = { ...body, creatorType: "agent", creatorName: agentCreatorName };
    }

    try {
      const result = route.run({ store, url, body });
      const responseBody = { protocolVersion: PROTOCOL_VERSION, requestId, result };
      const payload = JSON.stringify(responseBody);
      // Same bound and stable outcome as the browser.* routes above
      // (maxResponseBytes, ERROR_CODES.RESPONSE_TOO_LARGE): a store.*
      // route's own per-field bounds (e.g. list projections that omit
      // large text — service/store.mjs's rowToCaptureListItem) keep this
      // rare in practice, but it is still enforced here as the same
      // explicit, final backstop, never an unbounded response written to
      // the socket.
      if (Buffer.byteLength(payload) > maxResponseBytes) {
        respondJson(res, 502, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: ERROR_CODES.RESPONSE_TOO_LARGE } });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    } catch (error) {
      const storeError =
        error instanceof StoreError ? error : new StoreError(STORE_ERROR_CODES.DB_ERROR, error instanceof Error ? error.message : String(error));
      const status = STORE_ERROR_STATUS[storeError.code] ?? 500;
      respondJson(res, status, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: storeError.code, detail: storeError.message } });
    }
  }

  // Stage 4: `workflow.capture_tab` — the only capture-creation path
  // exposed to external-agent scope (AGENT_ALLOWED_STORE_METHODS
  // deliberately excludes `store.captures.create` for that reason). Unlike
  // every store.* route, this one does not take a caller-supplied capture
  // body at all: it performs the real `browser.read_tab` extension round
  // trip itself (exactly like handleApiMethod above), validates that
  // result the same way handleApiMethod does, and persists *that*
  // server-fetched, already-validated result — never anything read from
  // the HTTP request body, because there is no such body. A caller cannot
  // forge stored browser evidence through this route no matter what JSON
  // it sends, because nothing it sends is ever stored.
  //
  // Non-"ok" `browser.read_tab` outcomes (stale handle, protected page,
  // tab still loading, ...) are persisted too, not discarded: the capture
  // row then records the envelope's `code`/`detail` only (no invented page
  // content — the same rule validateCaptureInput already enforces for any
  // caller), which preserves a documented record of "this is what happened
  // when tab X was read," matching how store.captures.create already
  // supports non-"ok" captures (see service/validation.mjs). The response
  // is always the same bounded capture projection store.captures.create
  // returns, regardless of status.
  async function handleWorkflowMethod(name, route, req, res, url) {
    const requestId = requestIdFor(req);
    const auth = authenticate(req);
    if (!auth.ok) {
      respondJson(res, auth.status, { protocolVersion: PROTOCOL_VERSION, requestId, error: auth.error });
      return;
    }
    if (auth.scope === "agent" && !AGENT_ALLOWED_WORKFLOW_METHODS.has(name)) {
      respondJson(res, 403, forbiddenScopeResponse(requestId, name));
      return;
    }
    if (!checkRateLimit()) {
      respondJson(res, 429, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: ERROR_CODES.RATE_LIMITED } });
      return;
    }
    if (!store) {
      respondJson(res, 503, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: "store_unavailable" } });
      return;
    }
    if (req.method !== route.httpMethod) {
      respondJson(res, 405, {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        error: { code: "method_not_allowed", detail: `"${name}" expects ${route.httpMethod}` },
      });
      return;
    }

    // `workflow.capture_tab` is a no-body POST (see this function's header
    // comment): any caller-supplied body is simply never read or inspected,
    // so a caller asserting one via Content-Length or chunked
    // Transfer-Encoding framing is rejected explicitly, before the
    // extension round trip or any persistence, rather than having that body
    // silently ignored.
    if (hasRequestBodyFraming(req)) {
      respondJson(res, 400, {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        error: { code: ERROR_CODES.INVALID_REQUEST, detail: `"${name}" does not accept a request body` },
      });
      return;
    }

    let params;
    try {
      params = route.paramsFromQuery(url);
    } catch (error) {
      respondJson(res, 500, {
        protocolVersion: PROTOCOL_VERSION,
        requestId,
        error: { code: ERROR_CODES.INTERNAL_ERROR, detail: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    try {
      const extensionResult = await sendExtensionRequest("browser.read_tab", params);

      let validation;
      try {
        validation = validateMethodResult("browser.read_tab", extensionResult);
      } catch (error) {
        validation = { valid: false, reason: `validation itself failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!validation.valid) {
        respondJson(res, 502, {
          protocolVersion: PROTOCOL_VERSION,
          requestId,
          error: { code: ERROR_CODES.INVALID_EXTENSION_RESPONSE, detail: validation.reason },
        });
        return;
      }

      let result;
      try {
        // The server's own freshly-validated result, exactly as received —
        // never the HTTP request body (there isn't one for this route).
        result = store.createCapture(extensionResult);
      } catch (error) {
        const storeError =
          error instanceof StoreError ? error : new StoreError(STORE_ERROR_CODES.DB_ERROR, error instanceof Error ? error.message : String(error));
        const status = STORE_ERROR_STATUS[storeError.code] ?? 500;
        respondJson(res, status, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: storeError.code, detail: storeError.message } });
        return;
      }

      const body = { protocolVersion: PROTOCOL_VERSION, requestId, result };
      const payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > maxResponseBytes) {
        respondJson(res, 502, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: ERROR_CODES.RESPONSE_TOO_LARGE } });
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    } catch (error) {
      const status = ERROR_STATUS[error.code] ?? 502;
      const code = error.code in ERROR_STATUS ? error.code : ERROR_CODES.INTERNAL_ERROR;
      const body = { protocolVersion: PROTOCOL_VERSION, requestId, error: { code } };
      if (!(error.code in ERROR_STATUS)) body.error.detail = error.message;
      respondJson(res, status, body);
    }
  }

  // Stage 5 remediation: an extension-independent, authenticated,
  // protocol-versioned owner-scope probe. Unlike `browser.get_capabilities`
  // (which round-trips through the extension and therefore fails with
  // `disconnected` whenever the extension is not currently connected),
  // this route never touches `sendExtensionRequest` at all — it only
  // answers the question "does this credential authenticate, and does it
  // carry owner scope?" The UI's Connect flow uses this (not
  // `browser.get_capabilities`) to validate the pasted token, specifically
  // so an owner can still enter the review UI while the extension is
  // disconnected, and so an agent-scoped token is explicitly rejected
  // here rather than incidentally succeeding merely because
  // `browser.get_capabilities` happens to be agent-allowed too.
  function handleOwnerStatus(req, res) {
    const requestId = requestIdFor(req);
    const auth = authenticate(req);
    if (!auth.ok) {
      respondJson(res, auth.status, { protocolVersion: PROTOCOL_VERSION, requestId, error: auth.error });
      return;
    }
    if (auth.scope !== "owner") {
      respondJson(res, 403, forbiddenScopeResponse(requestId, "owner.status"));
      return;
    }
    if (!checkRateLimit()) {
      respondJson(res, 429, { protocolVersion: PROTOCOL_VERSION, requestId, error: { code: ERROR_CODES.RATE_LIMITED } });
      return;
    }
    respondJson(res, 200, { protocolVersion: PROTOCOL_VERSION, requestId, result: { scope: "owner" } });
  }

  function handleHealth(_req, res) {
    respondJson(res, 200, {
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
      service: { startedAt },
      extension: { connected: extensionSocket !== null, connectedAt: extensionConnectedAt },
      store: { available: store !== null },
    });
  }

  async function handleControlStop(req, res) {
    const auth = authenticate(req);
    if (!auth.ok) {
      respondJson(res, auth.status, { protocolVersion: PROTOCOL_VERSION, error: auth.error });
      return;
    }
    // Stage 4: shutting the service down is never in an agent's scope,
    // regardless of the AGENT_ALLOWED_* sets above (control/stop is not
    // even a /api/ route, so it is not reachable through them at all) —
    // this is an explicit, separate check for the same reason.
    if (auth.scope !== "owner") {
      respondJson(res, 403, { protocolVersion: PROTOCOL_VERSION, error: { code: ERROR_CODES.FORBIDDEN_SCOPE, detail: '"control/stop" is owner-only' } });
      return;
    }
    respondJson(res, 200, { protocolVersion: PROTOCOL_VERSION, ok: true });
    // Let the response above actually flush to the caller before the
    // process that owns it starts tearing things down.
    setImmediate(() => {
      onControlStop();
    });
  }

  const httpServer = createHttpServer((req, res) => {
    // Guarded: `req.url` is the raw, caller-controlled HTTP request target,
    // and `new URL(...)` throws `ERR_INVALID_URL` for a malformed one (e.g.
    // an invalid raw target like `//[`). That must become an explicit,
    // bounded 400 response — never an uncaught exception that could crash
    // the process — and must happen before any authentication, protocol
    // check, or route dispatch is attempted.
    let url;
    try {
      url = new URL(req.url, "http://127.0.0.1");
    } catch (error) {
      respondJson(res, 400, {
        protocolVersion: PROTOCOL_VERSION,
        error: { code: ERROR_CODES.INVALID_REQUEST, detail: error instanceof Error ? error.message : String(error) },
      });
      return;
    }

    // Stage 5 remediation: the Host-header check runs before *everything*
    // else — before even serving a UI asset — so a DNS-rebinding-style
    // request never gets so much as the UI shell, let alone a chance to
    // reach an authenticated route. See checkHost's own comment above.
    const hostFailure = checkHost(req);
    if (hostFailure) {
      respondJson(res, hostFailure.status, { protocolVersion: PROTOCOL_VERSION, error: hostFailure.error });
      return;
    }

    // Stage 5: the local review UI's static assets are served before (and
    // regardless of) the X-Protocol-Version check below — ordinary browser
    // navigation and <script src>/<link> fetches never send that header,
    // and these routes carry no secret and perform no action by themselves
    // (see service/ui.mjs). Every actual operation the UI performs is a
    // call to the authenticated, protocol-versioned /api/ routes below,
    // exactly like any other local API caller.
    if (req.method === "GET" && UI_ROUTES.has(url.pathname)) {
      serveUiAsset(res, UI_ROUTES.get(url.pathname));
      return;
    }

    const versionFailure = checkProtocolVersion(req);
    if (versionFailure) {
      respondJson(res, versionFailure.status, { protocolVersion: PROTOCOL_VERSION, error: versionFailure.error });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      handleHealth(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/control/stop") {
      handleControlStop(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice("/api/".length);
      if (req.method === "GET" && name === "owner.status") {
        handleOwnerStatus(req, res);
        return;
      }
      if (req.method === "GET" && API_ROUTES.has(name)) {
        handleApiMethod(name, req, res, url);
        return;
      }
      if (WORKFLOW_ROUTES.has(name)) {
        handleWorkflowMethod(name, WORKFLOW_ROUTES.get(name), req, res, url);
        return;
      }
      if (STORE_ROUTES.has(name)) {
        handleStoreMethod(name, STORE_ROUTES.get(name), req, res, url);
        return;
      }
    }
    respondJson(res, 404, { protocolVersion: PROTOCOL_VERSION, error: { code: "not_found" } });
  });

  // `maxPayload` bounds a single inbound WebSocket message from the
  // extension consistent with this service's own outbound response-size
  // boundary (maxResponseBytes, defaulted from MAX_RESPONSE_BYTES) plus a
  // small, fixed allowance for envelope/JSON framing overhead — so a
  // misbehaving or compromised extension connection cannot force a huge
  // buffer allocation merely by sending an oversized message; `ws` rejects
  // and closes the connection itself once this is exceeded, before the
  // message is ever fully buffered or parsed.
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxWsMessageBytes });

  httpServer.on("upgrade", (req, socket, head) => {
    if (shuttingDown) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }

    // Stage 5 remediation: the same Host-header defense applied to every
    // plain HTTP response also applies to the WebSocket upgrade. The
    // existing Origin check below already defeats an ordinary web page
    // (which can never claim a `chrome-extension://` origin), but this is
    // cheap, consistent defense-in-depth against the same DNS-rebinding
    // class of attack, checked first.
    const hostFailure = checkHost(req);
    if (hostFailure) {
      log(`rejected websocket upgrade due to an invalid Host header: ${req.headers.host ?? "(none)"}`);
      socket.end(`HTTP/1.1 ${hostFailure.status} Misdirected Request\r\nConnection: close\r\n\r\n`);
      return;
    }

    if (req.url !== "/extension") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }

    if (!isTrustedExtensionOrigin(req.headers.origin)) {
      log(`rejected websocket upgrade from untrusted origin: ${req.headers.origin ?? "(none)"}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws) => {
    // Owned by this socket alone: a replacement connection gets its own
    // fresh map, and this socket's eventual close only ever rejects entries
    // in *this* map (see sendExtensionRequest and the close handler below).
    ws.pendingRequests = new Map();

    // Registered immediately, before any other listener: an unhandled
    // 'error' event on a Node EventEmitter crashes the process, and `ws`
    // emits one for socket-level faults including an inbound message that
    // exceeds `maxPayload` above. The existing 'close' handler already
    // performs all necessary cleanup (rejecting in-flight requests,
    // clearing the heartbeat monitor) — 'close' always follows 'error' for
    // a `ws` connection, so nothing further is needed here beyond not
    // crashing.
    ws.on("error", (error) => {
      log(`extension websocket error: ${error instanceof Error ? error.message : String(error)}`);
    });

    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) ws.close(4401, ERROR_CODES.AUTH_TIMEOUT);
    }, authTimeoutMs);

    // Nothing other than the auth handshake is ever handled on this socket
    // until it authenticates: there is no "message" listener registered
    // until inside the success branch below, so the service structurally
    // cannot dispatch a request (or anything else) to an unauthenticated
    // connection.
    ws.once("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        message = null;
      }

      // Strictly required: an auth message with no protocolVersion at all is
      // treated the same as one with the wrong version, not given a pass.
      const validAuth =
        message?.type === WS_MESSAGE_TYPES.AUTH &&
        message.protocolVersion === PROTOCOL_VERSION &&
        timingSafeTokenEquals(message.token, credentialToken);

      if (!validAuth) {
        clearTimeout(authTimer);
        const code =
          message?.type === WS_MESSAGE_TYPES.AUTH && message.protocolVersion !== PROTOCOL_VERSION
            ? ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION
            : ERROR_CODES.INVALID_CREDENTIAL;
        ws.send(JSON.stringify({ type: WS_MESSAGE_TYPES.AUTH_ERROR, protocolVersion: PROTOCOL_VERSION, code }));
        ws.close(4401, code);
        return;
      }

      clearTimeout(authTimer);
      authenticated = true;

      // Single-profile scope (project.md): a newly authenticated connection
      // replaces any previous one rather than running both concurrently.
      // The previous socket's own close handler only rejects requests in
      // *its* pendingRequests map, so this never touches requests already
      // issued against the new socket.
      const previous = extensionSocket;
      if (previous && previous !== ws) {
        previous.close(4409, "replaced_by_new_connection");
      }
      extensionSocket = ws;
      extensionConnectedAt = Date.now();
      ws.lastActivityAt = Date.now();
      ws.send(JSON.stringify({ type: WS_MESSAGE_TYPES.AUTH_OK, protocolVersion: PROTOCOL_VERSION }));
      log("extension authenticated");

      const heartbeatMonitor = setInterval(() => {
        if (Date.now() - ws.lastActivityAt > heartbeatIntervalMs + heartbeatGraceMs) {
          log("extension connection went quiet past the heartbeat grace period; closing");
          ws.close(4408, "heartbeat_timeout");
        }
      }, heartbeatIntervalMs);

      ws.on("message", (raw) => {
        ws.lastActivityAt = Date.now();
        let message;
        try {
          message = JSON.parse(raw.toString());
        } catch {
          return;
        }

        // Strictly required on every message, not only the auth handshake:
        // a ping or response with a missing or wrong protocol version
        // cannot be dispatched/resolved — it is dropped here, the same as
        // a malformed message, rather than answered or used to settle a
        // pending request.
        if (message?.protocolVersion !== PROTOCOL_VERSION) return;

        if (message?.type === WS_MESSAGE_TYPES.PING) {
          ws.send(JSON.stringify({ type: WS_MESSAGE_TYPES.PONG, protocolVersion: PROTOCOL_VERSION }));
          return;
        }

        if (message?.type !== WS_MESSAGE_TYPES.RESPONSE || typeof message.id !== "string") return;
        const entry = ws.pendingRequests.get(message.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        ws.pendingRequests.delete(message.id);
        entry.resolve(message.result);
      });

      ws.on("close", () => {
        clearInterval(heartbeatMonitor);
        if (extensionSocket === ws) {
          extensionSocket = null;
          extensionConnectedAt = null;
        }
        for (const [id, entry] of ws.pendingRequests) {
          clearTimeout(entry.timer);
          const error = new Error("Extension connection ended before responding");
          error.code = ERROR_CODES.DISCONNECTED;
          entry.reject(error);
          ws.pendingRequests.delete(id);
        }
      });
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => resolve(httpServer.address()));
    });
  }

  // Rejects (never leaves hanging) any request in flight against the
  // currently active extension socket, so a caller awaiting an HTTP
  // response always gets a settled response instead of a connection that
  // never completes while the service tears down.
  function close() {
    shuttingDown = true;
    return new Promise((resolve) => {
      if (extensionSocket) {
        for (const [id, entry] of extensionSocket.pendingRequests) {
          clearTimeout(entry.timer);
          const error = new Error("Service is shutting down");
          error.code = ERROR_CODES.SERVICE_SHUTTING_DOWN;
          entry.reject(error);
          extensionSocket.pendingRequests.delete(id);
        }
        extensionSocket.close(1001, "service_shutdown");
      }
      wss.close(() => {
        httpServer.close(() => resolve());
      });
    });
  }

  function getState() {
    return { extensionConnected: extensionSocket !== null };
  }

  return { listen, close, getState };
}
