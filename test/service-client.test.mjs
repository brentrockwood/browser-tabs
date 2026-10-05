import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { createServiceClient as createUntrackedServiceClient, SERVICE_URL } from "../extension/service-client.js";
import { ERROR_CODES, PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";

// Wraps createServiceClient so every client this file creates is tracked
// and stopped after each test, regardless of pass/fail. Several tests reach
// "connected" and start a real heartbeat `setInterval`; an uncleared one
// would keep `node --test`'s per-file process alive forever. Explicit
// `client.stop()` calls at the end of specific tests are kept as
// documentation, but this is the safety net that actually prevents a hang
// (including on assertion failure, when a test body's own cleanup is
// skipped).
let activeClients = [];
function createServiceClient(options) {
  const client = createUntrackedServiceClient(options);
  activeClients.push(client);
  return client;
}
afterEach(() => {
  for (const client of activeClients) client.stop();
  activeClients = [];
});

// Minimal fake of the browser WebSocket API surface the client depends on
// (addEventListener/send/close), with test-only helpers to drive it from
// the "server" side, so the backoff/auth/correlation/heartbeat logic is
// exercised without a real socket or browser.
class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = { open: [], message: [], close: [], error: [] };
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, handler) {
    this.listeners[type].push(handler);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
    this._emit("close", {});
  }

  _emit(type, detail) {
    for (const handler of this.listeners[type]) handler(detail);
  }

  _open() {
    this.readyState = 1;
    this._emit("open", {});
  }

  _receive(obj) {
    this._emit("message", { data: JSON.stringify(obj) });
  }
}
FakeWebSocket.instances = [];

function freshFakeWebSocket() {
  FakeWebSocket.instances = [];
  return FakeWebSocket;
}

function fakeStorage(initial = {}) {
  let value = { ...initial };
  return {
    get: async (keys) => Object.fromEntries(keys.map((key) => [key, value[key]])),
    set: (patch) => {
      value = { ...value, ...patch };
    },
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function authenticate(ws, token = "tok-123") {
  ws._open();
  const authMessage = ws.sent[0];
  assert.equal(authMessage.type, "auth");
  assert.equal(authMessage.token, token);
  ws._receive({ type: "auth_ok", protocolVersion: PROTOCOL_VERSION });
}

// Minimal fake of the chrome.alarms adapter (create/clear) the client uses
// as its platform-native backstop for waking a terminated service worker.
function fakeAlarms() {
  const created = [];
  const cleared = [];
  let current = null;
  return {
    create: (name, info) => {
      current = { name, info };
      created.push({ name, info });
    },
    clear: (name) => {
      cleared.push(name);
      if (current?.name === name) current = null;
    },
    created,
    cleared,
    getCurrent: () => current,
  };
}

test("does not open a connection before a pairing token is stored", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const client = createServiceClient({ storage: fakeStorage(), routeMessage: async () => ({}), WebSocketImpl });
  client.start();
  await flushMicrotasks();
  assert.equal(client.getState(), "not_paired");
  assert.equal(FakeWebSocket.instances.length, 0);
});

test("connects to the fixed service URL and is not configurable via storage", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  // Even if a legacy/compromised storage value for "serviceUrl" exists, the
  // client never reads it: the WebSocket target is a source-level constant.
  const storage = fakeStorage({ serviceToken: "tok-123", serviceUrl: "ws://evil.example/extension" });
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl });

  client.start();
  await flushMicrotasks();
  assert.equal(FakeWebSocket.instances[0].url, SERVICE_URL);
});

test("connects, authenticates with the stored token and the protocol version, and resets the attempt counter", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl, serviceUrl: "ws://127.0.0.1:9999/extension" });

  client.start();
  await flushMicrotasks();
  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.url, "ws://127.0.0.1:9999/extension");

  ws._open();
  assert.deepEqual(ws.sent[0], { type: "auth", protocolVersion: PROTOCOL_VERSION, token: "tok-123" });
  assert.equal(client.getState(), "authenticating");

  ws._receive({ type: "auth_ok", protocolVersion: PROTOCOL_VERSION });
  assert.equal(client.getState(), "connected");
  client.stop(); // clears the heartbeat interval auth_ok started
});

test("routes an incoming request through routeMessage and sends the correlated, versioned response", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const routeMessage = async (message) => {
    assert.equal(message.method, "browser.list_windows");
    return [{ windowId: 1 }];
  };
  const client = createServiceClient({ storage, routeMessage, WebSocketImpl });

  client.start();
  await flushMicrotasks();
  const ws = FakeWebSocket.instances[0];
  await authenticate(ws);

  ws._receive({ type: "request", protocolVersion: PROTOCOL_VERSION, id: "req-1", method: "browser.list_windows", params: {} });
  await flushMicrotasks();

  const response = ws.sent.find((message) => message.type === "response");
  assert.deepEqual(response, { type: "response", protocolVersion: PROTOCOL_VERSION, id: "req-1", result: [{ windowId: 1 }] });
  client.stop(); // clears the heartbeat interval auth_ok started
});

test("sends an explicit error response if routeMessage itself rejects, instead of leaving the request unanswered", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const routeMessage = async () => {
    throw new Error("boom");
  };
  const client = createServiceClient({ storage, routeMessage, WebSocketImpl, getBrowserSessionId: () => "test-session" });

  client.start();
  await flushMicrotasks();
  const ws = FakeWebSocket.instances[0];
  await authenticate(ws);

  ws._receive({ type: "request", protocolVersion: PROTOCOL_VERSION, id: "req-1", method: "browser.list_windows", params: {} });
  await flushMicrotasks();

  const response = ws.sent.find((message) => message.type === "response");
  assert.ok(response, "a response must still be sent even though routeMessage rejected");
  assert.equal(response.id, "req-1");
  assert.equal(response.result.schemaVersion, RESULT_SCHEMA_VERSION);
  assert.equal(response.result.browserSessionId, "test-session");
  assert.equal(response.result.sourceOperation, "browser.list_windows");
  assert.equal(response.result.status, "error");
  assert.equal(response.result.code, ERROR_CODES.INTERNAL_ERROR);
  assert.equal(response.result.detail, "boom");
  client.stop();
});

test("never dispatches a request received before auth_ok", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  let routeMessageCalled = false;
  const routeMessage = async () => {
    routeMessageCalled = true;
    return { ok: true };
  };
  const client = createServiceClient({ storage, routeMessage, WebSocketImpl });

  client.start();
  await flushMicrotasks();
  const ws = FakeWebSocket.instances[0];
  ws._open(); // sent "auth", but no auth_ok received yet — still "authenticating"
  assert.equal(client.getState(), "authenticating");

  // A request arriving before auth_ok (malformed/unexpected peer, or a
  // stray message) must be ignored, not executed or answered.
  ws._receive({ type: "request", protocolVersion: PROTOCOL_VERSION, id: "early-1", method: "browser.list_windows", params: {} });
  await flushMicrotasks();

  assert.equal(routeMessageCalled, false);
  assert.equal(ws.sent.some((message) => message.type === "response"), false);

  // Confirm the connection still works normally once actually authenticated.
  ws._receive({ type: "auth_ok", protocolVersion: PROTOCOL_VERSION });
  ws._receive({ type: "request", protocolVersion: PROTOCOL_VERSION, id: "late-1", method: "browser.list_windows", params: {} });
  await flushMicrotasks();
  assert.equal(routeMessageCalled, true);
  client.stop(); // clears the heartbeat interval auth_ok started
});

test("sends an authenticated heartbeat ping no more than the configured interval apart", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const client = createServiceClient({
    storage,
    routeMessage: async () => ({}),
    WebSocketImpl,
    heartbeatIntervalMs: 10,
  });

  client.start();
  await flushMicrotasks();
  const ws = FakeWebSocket.instances[0];
  await authenticate(ws);

  // No ping before authentication completes.
  assert.equal(ws.sent.filter((message) => message.type === "ping").length, 0);

  await new Promise((resolve) => setTimeout(resolve, 45));
  const pings = ws.sent.filter((message) => message.type === "ping");
  assert.ok(pings.length >= 2, `expected at least 2 pings in 45ms at a 10ms interval, got ${pings.length}`);
  for (const ping of pings) assert.deepEqual(ping, { type: "ping", protocolVersion: PROTOCOL_VERSION });
  client.stop(); // clears the (10ms!) heartbeat interval before the test ends
});

test("schedules a bounded reconnect after a disconnect and reopens a new connection", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const client = createServiceClient({
    storage,
    routeMessage: async () => ({}),
    WebSocketImpl,
    backoffScheduleMs: [5, 10, 15],
  });

  client.start();
  await flushMicrotasks();
  const first = FakeWebSocket.instances[0];
  await authenticate(first);

  first.close();
  assert.equal(client.getState(), "reconnecting");

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(FakeWebSocket.instances.length, 2);
});

test("caps reconnect backoff at the last configured delay across repeated failures", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const client = createServiceClient({
    storage,
    routeMessage: async () => ({}),
    WebSocketImpl,
    backoffScheduleMs: [5, 10],
  });

  client.start();
  await flushMicrotasks();

  // Fail three times in a row without ever authenticating; the schedule
  // only has two entries, so the third and any later attempt reuse the
  // last (largest) delay instead of growing unbounded.
  for (let i = 0; i < 3; i += 1) {
    const current = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    current.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  assert.equal(FakeWebSocket.instances.length, 4);
});

test("an unacknowledged auth times out and triggers a reconnect rather than hanging", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const client = createServiceClient({
    storage,
    routeMessage: async () => ({}),
    WebSocketImpl,
    authTimeoutMs: 5,
    backoffScheduleMs: [5],
  });

  client.start();
  await flushMicrotasks();
  const ws = FakeWebSocket.instances[0];
  ws._open();

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(ws.readyState, 3);
  assert.equal(FakeWebSocket.instances.length, 2);
});

test("reconnects immediately once a token is saved after being unpaired", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage();
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl });

  client.start();
  await flushMicrotasks();
  assert.equal(client.getState(), "not_paired");

  storage.set({ serviceToken: "new-token" });
  client.onStorageChanged({ serviceToken: { newValue: "new-token" } }, "local");
  await flushMicrotasks();

  assert.equal(FakeWebSocket.instances.length, 1);
});

test("changing the pairing token while connected replaces the live connection immediately", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "old-token" });
  const client = createServiceClient({
    storage,
    routeMessage: async () => ({}),
    WebSocketImpl,
    // Deliberately small: if the old socket's close handler were ever
    // allowed to schedule its own (redundant) backoff-based reconnect
    // instead of recognizing it has been superseded, it would fire well
    // within this test and be caught by the final instance-count check.
    backoffScheduleMs: [15],
  });

  client.start();
  await flushMicrotasks();
  const first = FakeWebSocket.instances[0];
  await authenticate(first, "old-token");
  assert.equal(client.getState(), "connected");

  storage.set({ serviceToken: "new-token" });
  client.onStorageChanged({ serviceToken: { newValue: "new-token", oldValue: "old-token" } }, "local");
  await flushMicrotasks();

  // The old socket was closed as part of the replacement...
  assert.equal(first.readyState, 3);
  // ...and exactly one new connection was opened immediately (not two, and
  // not zero): the old socket's own close event must not have been allowed
  // to schedule a second, redundant reconnect via backoff.
  assert.equal(FakeWebSocket.instances.length, 2);
  const second = FakeWebSocket.instances[1];
  await authenticate(second, "new-token");
  assert.equal(client.getState(), "connected");

  // Give the (small) backoff window time to elapse; a stray reconnect from
  // the superseded old socket must not have fired.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(FakeWebSocket.instances.length, 2);
  client.stop(); // clears the second socket's heartbeat interval
});

test("clearing the pairing token closes the live connection without reconnecting", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "old-token" });
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl });

  client.start();
  await flushMicrotasks();
  const first = FakeWebSocket.instances[0];
  await authenticate(first, "old-token");

  storage.set({ serviceToken: undefined });
  client.onStorageChanged({ serviceToken: { newValue: undefined, oldValue: "old-token" } }, "local");
  await flushMicrotasks();

  assert.equal(first.readyState, 3);
  assert.equal(client.getState(), "not_paired");

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(FakeWebSocket.instances.length, 1, "must not reconnect with no token");
});

test("arms the retry alarm as soon as a pairing token is read, before the connection even opens", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const alarms = fakeAlarms();
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl, alarms });

  client.start();
  await flushMicrotasks();

  // Armed at connect() time, not only once a reconnect gets scheduled: a
  // WebSocket "close" event is not guaranteed to run before Chrome
  // terminates an idle worker, so waiting for "close" to arm the alarm
  // would leave a startup window with no alarm armed at all.
  assert.equal(client.getState(), "connecting");
  assert.equal(alarms.created.length, 1);
  assert.equal(alarms.created[0].name, "browser-tabs:reconnect");
  assert.equal(alarms.created[0].info.delayInMinutes, 0.5);
  assert.equal(alarms.created[0].info.periodInMinutes, 0.5);
  assert.ok(alarms.getCurrent());
});

test("keeps the retry alarm armed through a successful connection instead of clearing it on auth", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const alarms = fakeAlarms();
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl, alarms });

  client.start();
  await flushMicrotasks();
  const first = FakeWebSocket.instances[0];
  await authenticate(first);

  // The alarm's lifetime tracks whether a pairing token exists, not
  // whether the socket is currently connected: clearing it on every
  // successful auth would mean it is only ever armed in the
  // "close -> scheduleReconnect" path, which is exactly the gap this
  // alarm exists to cover when Chrome skips that path entirely.
  assert.equal(client.getState(), "connected");
  assert.equal(alarms.cleared.length, 0, "must not clear the alarm just because auth succeeded");
  assert.ok(alarms.getCurrent(), "alarm must remain armed while connected and paired");
});

test("re-arms (idempotently) the retry alarm on disconnect, and it survives multiple reconnect cycles", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const alarms = fakeAlarms();
  const client = createServiceClient({
    storage,
    routeMessage: async () => ({}),
    WebSocketImpl,
    alarms,
    backoffScheduleMs: [10_000], // large: this test exercises the alarm backstop, not the fast setTimeout path
  });

  client.start();
  await flushMicrotasks();
  const first = FakeWebSocket.instances[0];
  await authenticate(first);

  first.close(); // simulate the service going away (e.g. a restart)
  assert.equal(client.getState(), "reconnecting");
  assert.ok(alarms.getCurrent(), "alarm should still be armed while disconnected");

  // The 10s backoff above deliberately has not fired yet; simulate the
  // alarm firing instead (as it would for a worker the setTimeout could not
  // have survived to wake) to drive the second connection attempt.
  client.onAlarm("browser-tabs:reconnect");
  await flushMicrotasks();
  const second = FakeWebSocket.instances[1];
  await authenticate(second);

  assert.equal(client.getState(), "connected");
  assert.equal(alarms.cleared.length, 0, "the alarm is never cleared merely for reconnecting");
  assert.ok(alarms.getCurrent(), "alarm remains armed after the reconnect, ready for a future disconnect");
});

test("clears the retry alarm when the pairing token is removed, whether connected or disconnected", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const alarms = fakeAlarms();
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl, alarms });

  client.start();
  await flushMicrotasks();
  const first = FakeWebSocket.instances[0];
  await authenticate(first);
  assert.ok(alarms.getCurrent(), "armed while connected and paired");

  storage.set({ serviceToken: undefined });
  client.onStorageChanged({ serviceToken: { newValue: undefined, oldValue: "tok-123" } }, "local");
  await flushMicrotasks();

  assert.equal(client.getState(), "not_paired");
  assert.equal(alarms.getCurrent(), null, "alarm must not keep firing with no token to retry");
});

test("clears the retry alarm when the client is explicitly stopped", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const alarms = fakeAlarms();
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl, alarms });

  client.start();
  await flushMicrotasks();
  const first = FakeWebSocket.instances[0];
  await authenticate(first);
  assert.ok(alarms.getCurrent());

  client.stop();
  assert.equal(alarms.getCurrent(), null, "stop() must not leave the alarm armed behind it");
});

test("a firing alarm wakes a stalled reconnect immediately instead of waiting for backoff", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const alarms = fakeAlarms();
  const client = createServiceClient({
    storage,
    routeMessage: async () => ({}),
    WebSocketImpl,
    alarms,
    backoffScheduleMs: [60_000], // large enough that it would not fire during this test on its own
  });

  client.start();
  await flushMicrotasks();
  const first = FakeWebSocket.instances[0];
  await authenticate(first);

  first.close(); // the service worker may have been suspended for a while here, in reality
  assert.equal(client.getState(), "reconnecting");
  assert.equal(FakeWebSocket.instances.length, 1);

  // Simulates chrome.alarms.onAlarm firing (and, in the real worker, having
  // just woken it) before the long setTimeout backoff would ever fire.
  client.onAlarm("browser-tabs:reconnect");
  await flushMicrotasks();

  assert.equal(FakeWebSocket.instances.length, 2, "the alarm must trigger an immediate reconnect attempt");
  const second = FakeWebSocket.instances[1];
  await authenticate(second);
  assert.equal(client.getState(), "connected");
});

test("a firing alarm does not create a duplicate connection when one is already in progress", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const alarms = fakeAlarms();
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl, alarms });

  client.start();
  await flushMicrotasks();
  assert.equal(FakeWebSocket.instances.length, 1);

  // Still "connecting"/"authenticating"/"connected" at each of these
  // points; an alarm firing here must never spawn a second socket.
  client.onAlarm("browser-tabs:reconnect");
  await flushMicrotasks();
  assert.equal(FakeWebSocket.instances.length, 1, "no duplicate while connecting");

  const ws = FakeWebSocket.instances[0];
  ws._open();
  client.onAlarm("browser-tabs:reconnect");
  await flushMicrotasks();
  assert.equal(FakeWebSocket.instances.length, 1, "no duplicate while authenticating");

  ws._receive({ type: "auth_ok" });
  client.onAlarm("browser-tabs:reconnect");
  await flushMicrotasks();
  assert.equal(FakeWebSocket.instances.length, 1, "no duplicate while already connected");
});

test("ignores an auth_ok with a missing or wrong protocol version instead of treating it as authenticated", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const client = createServiceClient({ storage, routeMessage: async () => ({}), WebSocketImpl });

  client.start();
  await flushMicrotasks();
  const ws = FakeWebSocket.instances[0];
  ws._open();
  assert.equal(client.getState(), "authenticating");

  ws._receive({ type: "auth_ok" }); // no protocolVersion at all
  assert.equal(client.getState(), "authenticating", "must not authenticate without a protocol version");

  ws._receive({ type: "auth_ok", protocolVersion: 999 }); // wrong protocolVersion
  assert.equal(client.getState(), "authenticating", "must not authenticate with the wrong protocol version");

  ws._receive({ type: "auth_ok", protocolVersion: PROTOCOL_VERSION });
  assert.equal(client.getState(), "connected");
  client.stop();
});

test("ignores a request with a missing or wrong protocol version instead of dispatching it", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  let calls = 0;
  const routeMessage = async () => {
    calls += 1;
    return { ok: true };
  };
  const client = createServiceClient({ storage, routeMessage, WebSocketImpl });

  client.start();
  await flushMicrotasks();
  const ws = FakeWebSocket.instances[0];
  await authenticate(ws);

  ws._receive({ type: "request", id: "no-version", method: "browser.list_windows", params: {} });
  await flushMicrotasks();
  assert.equal(calls, 0, "a request with no protocol version must not be dispatched");

  ws._receive({ type: "request", protocolVersion: 999, id: "wrong-version", method: "browser.list_windows", params: {} });
  await flushMicrotasks();
  assert.equal(calls, 0, "a request with the wrong protocol version must not be dispatched");

  ws._receive({ type: "request", protocolVersion: PROTOCOL_VERSION, id: "right-version", method: "browser.list_windows", params: {} });
  await flushMicrotasks();
  assert.equal(calls, 1, "a correctly versioned request is still dispatched normally");
  client.stop();
});

test("ignores an alarm with a different name", async () => {
  const WebSocketImpl = freshFakeWebSocket();
  const storage = fakeStorage({ serviceToken: "tok-123" });
  const alarms = fakeAlarms();
  const client = createServiceClient({
    storage,
    routeMessage: async () => ({}),
    WebSocketImpl,
    alarms,
    backoffScheduleMs: [60_000],
  });

  client.start();
  await flushMicrotasks();
  const first = FakeWebSocket.instances[0];
  await authenticate(first);
  first.close();
  assert.equal(FakeWebSocket.instances.length, 1);

  client.onAlarm("some-other-extensions-alarm");
  await flushMicrotasks();
  assert.equal(FakeWebSocket.instances.length, 1, "an unrelated alarm must not trigger a reconnect attempt");
});
