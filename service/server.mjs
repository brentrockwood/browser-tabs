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

function timingSafeTokenEquals(candidate, expected) {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isTrustedExtensionOrigin(origin) {
  return typeof origin === "string" && origin.startsWith("chrome-extension://");
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
  host = "127.0.0.1",
  port = 0,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  heartbeatGraceMs = HEARTBEAT_GRACE_MS,
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

  function checkAuth(req) {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer\s+(.+)$/.exec(header) : null;
    if (!match) return { status: 401, error: { code: ERROR_CODES.MISSING_CREDENTIAL } };
    if (!timingSafeTokenEquals(match[1], credentialToken)) {
      return { status: 401, error: { code: ERROR_CODES.INVALID_CREDENTIAL } };
    }
    return null;
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
    const authFailure = checkAuth(req);
    if (authFailure) {
      respondJson(res, authFailure.status, { protocolVersion: PROTOCOL_VERSION, requestId, error: authFailure.error });
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

  function handleHealth(_req, res) {
    respondJson(res, 200, {
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
      service: { startedAt },
      extension: { connected: extensionSocket !== null, connectedAt: extensionConnectedAt },
    });
  }

  async function handleControlStop(req, res) {
    const authFailure = checkAuth(req);
    if (authFailure) {
      respondJson(res, authFailure.status, { protocolVersion: PROTOCOL_VERSION, error: authFailure.error });
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
    const versionFailure = checkProtocolVersion(req);
    if (versionFailure) {
      respondJson(res, versionFailure.status, { protocolVersion: PROTOCOL_VERSION, error: versionFailure.error });
      return;
    }

    // Guarded: `req.url` is the raw, caller-controlled HTTP request target,
    // and `new URL(...)` throws `ERR_INVALID_URL` for a malformed one (e.g.
    // an invalid raw target like `//[`). That must become an explicit,
    // bounded 400 response — never an uncaught exception that could crash
    // the process — and must happen before any authentication or route
    // dispatch is attempted.
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

    if (req.method === "GET" && url.pathname === "/health") {
      handleHealth(req, res);
      return;
    }
    if (req.method === "POST" && url.pathname === "/control/stop") {
      handleControlStop(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/")) {
      const method = url.pathname.slice("/api/".length);
      if (API_ROUTES.has(method)) {
        handleApiMethod(method, req, res, url);
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
