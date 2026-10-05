import {
  DEFAULT_SERVICE_PORT,
  ERROR_CODES,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  RECONNECT_ALARM_DELAY_MINUTES,
  RECONNECT_ALARM_NAME,
  RESULT_SCHEMA_VERSION,
  WS_MESSAGE_TYPES,
} from "./protocol.js";

// Fixed, loopback-only target. Stage 1 deliberately does not let a user (or
// a compromised options page) point the extension at an arbitrary remote
// WebSocket URL: there is no stored/user-editable URL, only this constant,
// built from the single shared DEFAULT_SERVICE_PORT (see protocol.js) so it
// can never silently drift from the service's own default listen port.
export const SERVICE_URL = `ws://127.0.0.1:${DEFAULT_SERVICE_PORT}/extension`;

const DEFAULT_BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const DEFAULT_AUTH_TIMEOUT_MS = 5000;

// Drives the extension side of the Stage 1 local bridge: reads the pairing
// token from storage, opens the fixed-URL WebSocket to the service,
// authenticates, routes incoming requests through `routeMessage`, sends a
// ping no more than `heartbeatIntervalMs` apart once connected (Chrome's
// documented keepalive pattern for a long-lived service-worker WebSocket —
// see project.md's Stage 1 checkpoint), and reconnects with bounded backoff
// on any disconnect. Kept dependency-free and testable with a fake
// `WebSocketImpl`/`storage` so this logic does not require a real browser.
export function createServiceClient({
  storage,
  routeMessage,
  WebSocketImpl = globalThis.WebSocket,
  serviceUrl = SERVICE_URL,
  backoffScheduleMs = DEFAULT_BACKOFF_SCHEDULE_MS,
  authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  // A chrome.alarms-shaped adapter: { create(name, info), clear(name) }.
  // Optional (and inert if omitted) so this module stays testable without a
  // browser; the real extension passes `browserApi.alarms` (see
  // service-worker.js). See RECONNECT_ALARM_NAME in protocol.js for why
  // this exists: a setTimeout-based retry cannot wake a terminated worker.
  alarms,
  // Used only to build a minimal, still envelope-valid error result if
  // `routeMessage` itself rejects (see the `.catch` below) — a product bug,
  // not an expected browser-API outcome, which `routeMessage`'s own
  // functions already convert to a resolved error result in the normal
  // case. Defaults to a fixed placeholder so this module stays testable
  // without a browser or a real session id.
  getBrowserSessionId = () => "service-client-unknown-session",
  log = () => {},
}) {
  let stopped = true;
  let socket = null;
  let reconnectTimer = null;
  let attempt = 0;
  let state = "idle";
  // Bumped on every connect() call and on every forced replacement
  // (stop()/onStorageChanged()). Each connection attempt's event handlers
  // close over the generation they were created with, so a superseded
  // (old/replaced) socket's eventual events can never affect a newer
  // attempt's state or schedule a redundant reconnect.
  let generation = 0;

  async function connect() {
    if (stopped) return;
    clearTimeout(reconnectTimer);
    const myGeneration = ++generation;

    let token;
    try {
      const stored = await storage.get(["serviceToken"]);
      token = stored.serviceToken;
    } catch (error) {
      log(`failed to read pairing token: ${error instanceof Error ? error.message : String(error)}`);
      if (myGeneration === generation) state = "not_paired";
      return;
    }

    if (myGeneration !== generation) return; // superseded while awaiting storage
    if (!token) {
      state = "not_paired";
      return;
    }

    // Durable for the whole time a token exists, not just while actively
    // retrying: idempotently (re-)arm the alarm backstop here, on every
    // connect() — including the very first one at startup and right after
    // a token change — not only when a reconnect gets scheduled. A
    // WebSocket "close" event is the normal way a lost connection is
    // noticed, but Chrome is not guaranteed to deliver it before
    // terminating an idle worker; relying on "close" to (re-)arm the alarm
    // would leave a window, right after this worker incarnation started,
    // with no alarm armed at all. See clearRetryAlarm's call sites for why
    // this is safe to leave armed even while connected.
    scheduleRetryAlarm();

    state = "connecting";
    let ws;
    try {
      ws = new WebSocketImpl(serviceUrl);
    } catch (error) {
      log(`failed to open websocket to ${serviceUrl}: ${error instanceof Error ? error.message : String(error)}`);
      scheduleReconnect();
      return;
    }
    socket = ws;

    let authTimer = null;
    let heartbeatTimer = null;

    ws.addEventListener("open", () => {
      if (myGeneration !== generation) return;
      state = "authenticating";
      ws.send(JSON.stringify({ type: WS_MESSAGE_TYPES.AUTH, protocolVersion: PROTOCOL_VERSION, token }));
      authTimer = setTimeout(() => {
        log("pairing authentication timed out; closing");
        ws.close(4401, ERROR_CODES.AUTH_TIMEOUT);
      }, authTimeoutMs);
    });

    ws.addEventListener("message", (event) => {
      if (myGeneration !== generation) return;
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      // Strictly required on every message from the service: one with a
      // missing or wrong protocol version cannot be dispatched/resolved —
      // it is dropped here, the same as a malformed message, rather than
      // acted on (never treated as a valid auth_ok/auth_error/pong/request).
      if (message?.protocolVersion !== PROTOCOL_VERSION) return;

      if (message?.type === WS_MESSAGE_TYPES.AUTH_OK) {
        clearTimeout(authTimer);
        attempt = 0;
        state = "connected";
        // Deliberately does NOT clear the retry alarm here: the alarm's
        // lifetime tracks whether a pairing token exists, not whether the
        // socket is currently connected (see onAlarm, which already no-ops
        // while connecting/authenticating/connected, so a periodic alarm
        // firing while healthy is a harmless no-op, not a duplicate
        // connection). Clearing it on every successful auth would mean the
        // alarm is only ever armed in the "close -> scheduleReconnect"
        // path, which Chrome is not guaranteed to run before terminating
        // an idle worker — exactly the gap this alarm exists to cover.
        heartbeatTimer = setInterval(() => {
          if (myGeneration !== generation) {
            clearInterval(heartbeatTimer);
            return;
          }
          ws.send(JSON.stringify({ type: WS_MESSAGE_TYPES.PING, protocolVersion: PROTOCOL_VERSION }));
        }, heartbeatIntervalMs);
        log("authenticated with the local service");
        return;
      }

      if (message?.type === WS_MESSAGE_TYPES.AUTH_ERROR) {
        clearTimeout(authTimer);
        log(`service rejected pairing credential: ${message.code}`);
        return;
      }

      if (message?.type === WS_MESSAGE_TYPES.PONG) {
        return; // Heartbeat acknowledgment; no action needed.
      }

      if (message?.type === WS_MESSAGE_TYPES.REQUEST) {
        // Defense in depth: the service only ever sends a request over an
        // already-authenticated connection, but this client never acts on
        // one unless it has itself completed authentication. A request
        // arriving before auth_ok (a malformed/unexpected peer, or a stray
        // message from a superseded exchange) is dropped, not executed.
        if (state !== "connected") {
          log(`ignoring a "${WS_MESSAGE_TYPES.REQUEST}" received before authentication completed`);
          return;
        }
        routeMessage({ method: message.method, ...message.params })
          .then((result) => {
            if (myGeneration !== generation) return;
            ws.send(
              JSON.stringify({
                type: WS_MESSAGE_TYPES.RESPONSE,
                protocolVersion: PROTOCOL_VERSION,
                id: message.id,
                result,
              }),
            );
          })
          .catch((error) => {
            // routeMessage's own functions are expected to resolve to an
            // error-shaped result, never reject — but if one somehow does
            // (a product bug), the request must still be answered
            // explicitly rather than left for the service's request
            // timeout to eventually report as a generic, uninformative
            // failure.
            if (myGeneration !== generation) return;
            log(`routeMessage rejected for method "${message.method}": ${error instanceof Error ? error.message : String(error)}`);
            ws.send(
              JSON.stringify({
                type: WS_MESSAGE_TYPES.RESPONSE,
                protocolVersion: PROTOCOL_VERSION,
                id: message.id,
                result: {
                  schemaVersion: RESULT_SCHEMA_VERSION,
                  browserSessionId: getBrowserSessionId(),
                  sourceOperation: message.method,
                  capturedAt: Date.now(),
                  status: "error",
                  code: ERROR_CODES.INTERNAL_ERROR,
                  detail: error instanceof Error ? error.message : String(error),
                },
              }),
            );
          });
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(authTimer);
      clearInterval(heartbeatTimer);
      if (socket === ws) socket = null;
      if (myGeneration !== generation) return; // a newer attempt owns reconnect responsibility
      if (stopped) return;
      scheduleReconnect();
    });

    // The close event always follows an error for the browser WebSocket
    // API, so reconnect scheduling lives there, not here.
    ws.addEventListener("error", () => {});
  }

  // Fast path: a bounded setTimeout backoff, which only works while the
  // worker is still alive to run it. Also (re-)arms the alarm backstop —
  // already armed by connect() itself whenever a token exists, so this
  // call is redundant in the common case, but cheap and idempotent
  // (chrome.alarms.create replaces any existing alarm of the same name),
  // and guards against the alarm somehow having been cleared without a
  // corresponding disconnect.
  function scheduleReconnect() {
    state = "reconnecting";
    const delayMs = backoffScheduleMs[Math.min(attempt, backoffScheduleMs.length - 1)];
    attempt += 1;
    reconnectTimer = setTimeout(() => connect(), delayMs);
    scheduleRetryAlarm();
  }

  function scheduleRetryAlarm() {
    alarms?.create(RECONNECT_ALARM_NAME, {
      delayInMinutes: RECONNECT_ALARM_DELAY_MINUTES,
      periodInMinutes: RECONNECT_ALARM_DELAY_MINUTES,
    });
  }

  function clearRetryAlarm() {
    alarms?.clear(RECONNECT_ALARM_NAME);
  }

  function start() {
    stopped = false;
    connect();
  }

  function stop() {
    stopped = true;
    generation += 1;
    clearTimeout(reconnectTimer);
    clearRetryAlarm();
    const old = socket;
    socket = null;
    old?.close(1000, "client_stopped");
  }

  // A saved token always takes effect immediately — both first pairing and
  // rotating an already-paired token — rather than waiting for the next
  // backoff attempt, and any live connection using a now-stale token is
  // replaced rather than left running.
  function onStorageChanged(changes, areaName) {
    if (areaName !== "local" || !changes.serviceToken) return;
    const newToken = changes.serviceToken.newValue;

    generation += 1; // supersedes any in-flight/old connection attempt
    clearTimeout(reconnectTimer);
    const old = socket;
    socket = null;
    old?.close(1000, newToken ? "token_changed" : "token_cleared");

    attempt = 0;
    if (!newToken) {
      state = "not_paired";
      clearRetryAlarm(); // nothing to retry without a token
      return;
    }
    connect();
  }

  // Called from a top-level `chrome.alarms.onAlarm` listener (see
  // service-worker.js) — that top-level registration is what lets Chrome
  // wake a fully terminated worker to deliver this event; a setTimeout
  // scheduled before termination would simply never fire. If the worker
  // was merely idle (never terminated), a reconnect may already be
  // connecting/connected by the time this fires: in that case do nothing,
  // so the alarm can never produce a second, duplicate connection attempt
  // alongside the one already in progress. `connect()` itself is also safe
  // to call redundantly (it cancels any pending setTimeout reconnect and
  // supersedes any earlier attempt via the generation counter), so this
  // only needs to filter out the "already working on it" states.
  function onAlarm(alarmName) {
    if (alarmName !== RECONNECT_ALARM_NAME) return;
    if (state === "connecting" || state === "authenticating" || state === "connected") return;
    connect();
  }

  function getState() {
    return state;
  }

  return { start, stop, onStorageChanged, onAlarm, getState };
}
