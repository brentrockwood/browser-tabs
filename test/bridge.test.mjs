// Real local end-to-end simulation of the Stage 1/2 bridge: the actual
// service (`createService`) listens on a real loopback socket, and a real
// `ws` client stands in for the extension's WebSocket connection — no
// mocked sockets, no browser required. Covers authentication, origin
// rejection, request correlation (including out-of-order responses),
// timeouts, graceful shutdown with in-flight work, connection replacement
// ownership, the versioned request/response contract, the authenticated
// control-stop endpoint, the Stage 2 read-API route allowlist, the service
// boundary's rate limit/response-size/envelope-validation/inbound-payload
// bounds.
//
// This fake "extension" is a plain scripted `ws` client: it never runs
// extension/service-worker.js's own session/handle validation (that is unit
// tested in test/service-worker.test.mjs). What this file verifies is the
// *transport*: that the service forwards parameters (including
// browserSessionId) faithfully, and validates whatever the "extension" side
// sends back before ever returning it to an HTTP caller.
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import WebSocket from "ws";

import { ERROR_CODES, PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { createService } from "../service/server.mjs";

const TOKEN = "integration-test-token-0123456789";
const EXTENSION_ORIGIN = "chrome-extension://test-extension-id";
const SESSION_ID = "test-session-id";

// Defaults every request to a valid X-Protocol-Version header, since the
// service now strictly requires one on every HTTP request; a caller can
// still override it (e.g. to a wrong value) or truly omit it (by passing
// `"x-protocol-version": undefined`) for tests that specifically exercise
// that enforcement. Node's http client does *not* silently drop an
// `undefined`-valued header itself (it throws ERR_HTTP_INVALID_HEADER_
// VALUE), so any such key is deleted here before the request is built.
// After the client side of a WS connection closes, the server's own close
// handler (which flips extension.connected to false) is not guaranteed to
// have run yet, so an immediate /health read can still observe a stale
// connected:true. Poll until it settles or a short deadline elapses.
async function pollHealthUntilDisconnected({ port }) {
  const deadline = Date.now() + 2000;
  let health;
  do {
    health = await httpRequest({
      port,
      path: "/health",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    if (health.json?.extension?.connected === false) return health;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert.equal(health.json.extension.connected, false, `extension.connected did not settle to false before deadline; last health: ${JSON.stringify(health.json)}`);
  return health;
}

function httpRequest({ port, path, method = "GET", headers = {} }) {
  const finalHeaders = { "x-protocol-version": String(PROTOCOL_VERSION), ...headers };
  for (const key of Object.keys(finalHeaders)) {
    if (finalHeaders[key] === undefined) delete finalHeaders[key];
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: finalHeaders }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          // leave json null
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function withService(options, run) {
  const service = createService({ credentialToken: TOKEN, port: 0, host: "127.0.0.1", ...options });
  const address = await service.listen();
  try {
    await run(service, address.port);
  } finally {
    await service.close().catch(() => {});
  }
}

function connectAsExtension(port, { origin = EXTENSION_ORIGIN } = {}) {
  return new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

async function openAuthenticated(port, { origin = EXTENSION_ORIGIN, token = TOKEN } = {}) {
  const ws = connectAsExtension(port, { origin });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const authOkPromise = nextMessage(ws);
  ws.send(JSON.stringify({ type: "auth", protocolVersion: PROTOCOL_VERSION, token }));
  await authOkPromise;
  return ws;
}

// A minimal, valid capture-provenance envelope, matching whatever
// `sourceOperation` the caller passes — the server validates this exactly
// against the requested method (see validateMethodResult in
// extension/protocol.js) before ever returning 200. `capturedAt` is a fixed
// value (not Date.now()) so two independently-built fixtures for the same
// result — one sent over the wire, one built again for a deepEqual
// assertion — always compare equal instead of flaking on a few
// milliseconds' drift.
function envelope(sourceOperation, status = "ok") {
  return { schemaVersion: RESULT_SCHEMA_VERSION, browserSessionId: SESSION_ID, sourceOperation, capturedAt: 1_700_000_000_000, status };
}

function listWindowsResult(overrides = {}) {
  return {
    ...envelope("browser.list_windows"),
    windows: [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 1 }],
    returnedCount: 1,
    totalCount: 1,
    truncated: false,
    ...overrides,
  };
}

function listTabsResult(overrides = {}) {
  return {
    ...envelope("browser.list_tabs"),
    windowId: 7,
    tabs: [],
    returnedCount: 0,
    totalCount: 0,
    truncated: false,
    ...overrides,
  };
}

function listTabGroupsResult(overrides = {}) {
  return {
    ...envelope("browser.list_tab_groups"),
    windowId: 3,
    groups: [],
    returnedCount: 0,
    totalCount: 0,
    truncated: false,
    ...overrides,
  };
}

function readTabResult(overrides = {}) {
  return {
    ...envelope("browser.read_tab"),
    tabId: 42,
    windowId: 1,
    url: "https://example.com",
    title: "T",
    documentReadyState: "complete",
    text: "hi",
    characterCount: 2,
    returnedCharacterCount: 2,
    truncated: false,
    ...overrides,
  };
}

function queryHistoryResult(overrides = {}) {
  return {
    ...envelope("browser.query_history"),
    startTime: 0,
    endTime: 1000,
    entries: [],
    returnedCount: 0,
    truncated: false,
    nextCursor: null,
    ...overrides,
  };
}

function capabilitiesResult(overrides = {}) {
  return {
    ...envelope("browser.get_capabilities"),
    protocolVersion: PROTOCOL_VERSION,
    tabGroups: true,
    history: true,
    scripting: true,
    maxTextCharacters: 500_000,
    maxWindowsReturned: 500,
    maxTabsReturned: 2_000,
    maxTabGroupsReturned: 500,
    maxHistoryResults: 500,
    ...overrides,
  };
}

// Auto-replies to any forwarded "request" with a canned (valid-envelope, by
// default) result, echoing the request's id. Returns the list of requests
// observed, in arrival order.
function autoRespond(ws, result = listWindowsResult()) {
  const seen = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "request") {
      seen.push(message);
      ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result }));
    }
  });
  return seen;
}

test("health reports the extension as disconnected before any extension connects", async () => {
  await withService({}, async (_service, port) => {
    const { status, json } = await httpRequest({ port, path: "/health" });
    assert.equal(status, 200);
    assert.equal(json.protocolVersion, PROTOCOL_VERSION);
    assert.equal(json.ok, true);
    assert.equal(json.extension.connected, false);
  });
});

test("the API route fails explicitly when no credential is presented", async () => {
  await withService({}, async (_service, port) => {
    const { status, json } = await httpRequest({ port, path: "/api/browser.list_windows" });
    assert.equal(status, 401);
    assert.equal(json.error.code, "missing_credential");
  });
});

test("the API route fails explicitly for a wrong credential", async () => {
  await withService({}, async (_service, port) => {
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: "Bearer wrong-token" },
    });
    assert.equal(status, 401);
    assert.equal(json.error.code, "invalid_credential");
  });
});

test("the API route fails explicitly as disconnected when no extension is paired", async () => {
  await withService({}, async (_service, port) => {
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 503);
    assert.equal(json.error.code, "disconnected");
  });
});

test("the API route rejects a request claiming an unsupported protocol version", async () => {
  await withService({}, async (_service, port) => {
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}`, "x-protocol-version": "99" },
    });
    assert.equal(status, 400);
    assert.equal(json.error.code, "unsupported_protocol_version");
  });
});

test("the API route rejects a request missing the protocol version header entirely", async () => {
  await withService({}, async (_service, port) => {
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}`, "x-protocol-version": undefined },
    });
    assert.equal(status, 400);
    assert.equal(json.error.code, "unsupported_protocol_version");
  });
});

test("the API route echoes a caller-supplied request ID and the protocol version", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws);

    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}`, "x-request-id": "caller-chosen-id" },
    });
    assert.equal(status, 200);
    assert.equal(json.protocolVersion, PROTOCOL_VERSION);
    assert.equal(json.requestId, "caller-chosen-id");
    ws.close();
  });
});

test("the websocket upgrade is rejected for an untrusted browser origin", async () => {
  await withService({}, async (_service, port) => {
    const ws = connectAsExtension(port, { origin: "https://evil.example" });
    const outcome = await new Promise((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("unexpected-response", (_req, res) => resolve(`unexpected-response:${res.statusCode}`));
      ws.on("error", () => resolve("error"));
    });
    assert.equal(outcome, "unexpected-response:403");
  });
});

test("the websocket upgrade is accepted from a Firefox moz-extension:// origin", async () => {
  await withService({}, async (_service, port) => {
    const ws = connectAsExtension(port, { origin: "moz-extension://firefox-test-uuid" });
    const outcome = await new Promise((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("unexpected-response", (_req, res) => resolve(`unexpected-response:${res.statusCode}`));
      ws.on("error", () => resolve("error"));
    });
    assert.equal(outcome, "open");
    ws.close();
  });
});

test("the websocket connection is rejected and closed for an invalid pairing token", async () => {
  await withService({}, async (_service, port) => {
    const ws = connectAsExtension(port);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    const authErrorPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: "auth", protocolVersion: PROTOCOL_VERSION, token: "wrong-token" }));
    const authError = await authErrorPromise;
    assert.deepEqual(authError, { type: "auth_error", protocolVersion: PROTOCOL_VERSION, code: "invalid_credential" });
    await new Promise((resolve) => ws.once("close", resolve));
  });
});

test("the websocket connection is rejected for a mismatched protocol version", async () => {
  await withService({}, async (_service, port) => {
    const ws = connectAsExtension(port);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    const authErrorPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: "auth", protocolVersion: 999, token: TOKEN }));
    const authError = await authErrorPromise;
    assert.deepEqual(authError, { type: "auth_error", protocolVersion: PROTOCOL_VERSION, code: "unsupported_protocol_version" });
  });
});

test("the websocket connection is rejected when the auth message omits the protocol version entirely", async () => {
  await withService({}, async (_service, port) => {
    const ws = connectAsExtension(port);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    const authErrorPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: "auth", token: TOKEN })); // no protocolVersion at all
    const authError = await authErrorPromise;
    assert.deepEqual(authError, { type: "auth_error", protocolVersion: PROTOCOL_VERSION, code: "unsupported_protocol_version" });
  });
});

test("an authenticated request round-trips end to end through the extension connection", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws);

    const health = await httpRequest({ port, path: "/health" });
    assert.equal(health.json.extension.connected, true);

    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 200);
    assert.deepEqual(json.result, listWindowsResult());

    ws.close();
  });
});

test("two concurrent requests are correlated correctly even when responses arrive out of order", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const seen = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      seen.push(message);
      // Reply to the *second* observed request first, and tag each result
      // with the request id it should be matched back to, so a correlation
      // bug (matching by arrival order instead of id) would be caught.
      if (seen.length === 2) {
        ws.send(
          JSON.stringify({
            type: "response",
            protocolVersion: PROTOCOL_VERSION,
            id: seen[1].id,
            result: listWindowsResult({ forId: seen[1].id }),
          }),
        );
        ws.send(
          JSON.stringify({
            type: "response",
            protocolVersion: PROTOCOL_VERSION,
            id: seen[0].id,
            result: listWindowsResult({ forId: seen[0].id }),
          }),
        );
      }
    });

    const [first, second] = await Promise.all([
      httpRequest({ port, path: "/api/browser.list_windows", headers: { authorization: `Bearer ${TOKEN}` } }),
      httpRequest({ port, path: "/api/browser.list_windows", headers: { authorization: `Bearer ${TOKEN}` } }),
    ]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    // Each HTTP caller must get back the result tagged for *its own*
    // request id, not whichever response happened to arrive first.
    assert.notEqual(first.json.result.forId, second.json.result.forId);
    ws.close();
  });
});

test("a request fails explicitly with a timeout when the extension never responds", async () => {
  await withService({ requestTimeoutMs: 50 }, async (_service, port) => {
    const ws = await openAuthenticated(port);
    // Intentionally never reply to the forwarded request.

    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 504);
    assert.equal(json.error.code, "request_timeout");
    ws.close();
  });
});

test("the API route reports disconnected again after the extension disconnects", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    ws.close();
    await new Promise((resolve) => ws.once("close", resolve));
    // Give the server a tick to observe the closed connection.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 503);
    assert.equal(json.error.code, "disconnected");
  });
});

test("the server answers an authenticated ping with a pong", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const pongPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: "ping", protocolVersion: PROTOCOL_VERSION }));
    assert.deepEqual(await pongPromise, { type: "pong", protocolVersion: PROTOCOL_VERSION });
    ws.close();
  });
});

test("the server does not answer a ping missing or with the wrong protocol version", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    let pongReceived = false;
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "pong") pongReceived = true;
    });

    ws.send(JSON.stringify({ type: "ping" })); // no protocolVersion
    ws.send(JSON.stringify({ type: "ping", protocolVersion: 999 }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(pongReceived, false, "an unversioned or wrong-version ping must not be answered");

    const pongPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: "ping", protocolVersion: PROTOCOL_VERSION }));
    assert.deepEqual(await pongPromise, { type: "pong", protocolVersion: PROTOCOL_VERSION });
    ws.close();
  });
});

test("a WS response missing or with the wrong protocol version does not resolve the pending request", async () => {
  await withService({ requestTimeoutMs: 2000 }, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const resultPromise = httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const request = await nextMessage(ws);
    assert.equal(request.type, "request");

    // Neither of these may settle the pending HTTP request.
    ws.send(JSON.stringify({ type: "response", id: request.id, result: listWindowsResult() }));
    ws.send(JSON.stringify({ type: "response", protocolVersion: 999, id: request.id, result: listWindowsResult() }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const tagged = listWindowsResult({ forId: "correct-version" });
    ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: request.id, result: tagged }));
    const { status, json } = await resultPromise;
    assert.equal(status, 200);
    assert.equal(json.result.forId, "correct-version");
    ws.close();
  });
});

test("a replacement connection's in-flight request is not rejected by the old socket's close racing behind it", async () => {
  await withService({ requestTimeoutMs: 2000 }, async (_service, port) => {
    const first = await openAuthenticated(port);
    // The first connection never answers; it is about to be replaced.

    const second = await openAuthenticated(port); // replaces `first` (single-profile scope)
    const seen = [];
    second.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === "request") {
        seen.push(message);
        second.send(
          JSON.stringify({
            type: "response",
            protocolVersion: PROTOCOL_VERSION,
            id: message.id,
            result: listWindowsResult({ forId: "ok-from-second" }),
          }),
        );
      }
    });

    // Issued immediately after the replacement, racing against `first`'s
    // own (asynchronous) close completing. If pending requests were ever
    // tracked in one map shared across sockets instead of one owned by
    // each socket, `first`'s close handler sweeping that shared map could
    // reject this request — meant for `second` — before `second` gets a
    // chance to answer it.
    const resultPromise = httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await new Promise((resolve) => first.once("close", resolve));

    const { status, json } = await resultPromise;
    assert.equal(status, 200);
    assert.equal(json.result.forId, "ok-from-second");
    assert.equal(seen.length, 1);

    second.close();
  });
});

test("replacing the connection while a request is in flight on the old socket still resolves that request as disconnected, not hanging", async () => {
  await withService({ requestTimeoutMs: 2000 }, async (_service, port) => {
    const first = await openAuthenticated(port);

    const inFlight = httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // Let the request actually reach the extension before replacing it.
    await nextMessage(first);

    const second = await openAuthenticated(port); // replaces `first`
    autoRespond(second);

    const { status, json } = await inFlight;
    assert.equal(status, 503);
    assert.equal(json.error.code, "disconnected");

    second.close();
  });
});

test("graceful shutdown settles an in-flight request instead of leaving it hanging", async () => {
  await withService({ requestTimeoutMs: 5000 }, async (service, port) => {
    const ws = await openAuthenticated(port);
    // Never respond; the request must still settle via shutdown, not the
    // (much longer) request timeout.

    const inFlight = httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await nextMessage(ws); // ensure the request actually reached the extension first

    const closePromise = service.close();
    const { status, json } = await inFlight;
    assert.equal(status, 503);
    assert.equal(json.error.code, "service_shutting_down");

    await closePromise;
    ws.close();
  });
});

test("GET /api/browser.list_tabs forwards windowId and browserSessionId to the extension", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const seen = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      seen.push(message);
      ws.send(
        JSON.stringify({
          type: "response",
          protocolVersion: PROTOCOL_VERSION,
          id: message.id,
          result: listTabsResult({ windowId: message.params.windowId }),
        }),
      );
    });

    const { status, json } = await httpRequest({
      port,
      path: `/api/browser.list_tabs?windowId=7&browserSessionId=${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 200);
    assert.equal(seen[0].method, "browser.list_tabs");
    assert.equal(seen[0].params.windowId, 7);
    assert.equal(seen[0].params.browserSessionId, SESSION_ID);
    assert.equal(json.result.windowId, 7);
    ws.close();
  });
});

test("GET /api/browser.read_tab forwards tabId and browserSessionId to the extension", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const seen = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      seen.push(message);
      ws.send(
        JSON.stringify({
          type: "response",
          protocolVersion: PROTOCOL_VERSION,
          id: message.id,
          result: readTabResult({ tabId: message.params.tabId }),
        }),
      );
    });

    const { status, json } = await httpRequest({
      port,
      path: `/api/browser.read_tab?tabId=42&browserSessionId=${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 200);
    assert.equal(seen[0].params.tabId, 42);
    assert.equal(seen[0].params.browserSessionId, SESSION_ID);
    assert.equal(json.result.tabId, 42);
    ws.close();
  });
});

test("GET /api/browser.list_tabs omits the browserSessionId key entirely (never an empty string) when the caller does not supply one", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const seen = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      seen.push(message);
      ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result: listTabsResult({ windowId: 7 }) }));
    });

    await httpRequest({ port, path: "/api/browser.list_tabs?windowId=7", headers: { authorization: `Bearer ${TOKEN}` } });
    // JSON.stringify drops an `undefined`-valued property entirely, so the
    // key the extension actually receives over the wire is absent, not
    // present-with-undefined — which is what makes the extension's own
    // `checkSession` (typeof callerSessionId !== "string") reject it as
    // stale_session rather than ever treating it as an empty-string match.
    assert.equal("browserSessionId" in seen[0].params, false);
    ws.close();
  });
});

test("GET /api/browser.list_tab_groups forwards the windowId query parameter to the extension", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws, listTabGroupsResult({ windowId: 3 }));
    const { status, json } = await httpRequest({
      port,
      path: `/api/browser.list_tab_groups?windowId=3&browserSessionId=${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 200);
    assert.deepEqual(json.result, listTabGroupsResult({ windowId: 3 }));
    ws.close();
  });
});

test("GET /api/browser.query_history forwards startTime/endTime/maxResults/cursor query parameters", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const seen = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      seen.push(message);
      ws.send(
        JSON.stringify({
          type: "response",
          protocolVersion: PROTOCOL_VERSION,
          id: message.id,
          result: queryHistoryResult({ startTime: 100, endTime: 200 }),
        }),
      );
    });

    const { status } = await httpRequest({
      port,
      path: "/api/browser.query_history?startTime=100&endTime=200&maxResults=5&cursor=20",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 200);
    assert.deepEqual(seen[0].params, { startTime: 100, endTime: 200, maxResults: 5, cursor: 20 });
    ws.close();
  });
});

test("GET /api/browser.query_history treats an empty numeric query value as malformed, never as 0", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const seen = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      seen.push(message);
      ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result: queryHistoryResult() }));
    });

    // `?startTime=` (present but empty) must never silently become 0 via
    // Number(""). JSON has no NaN, so a NaN parameter is transmitted to the
    // extension as `null` over the wire — still unambiguously not 0, and
    // still rejected by the extension's own isValidTimestamp check.
    await httpRequest({
      port,
      path: "/api/browser.query_history?startTime=&endTime=1000",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(seen[0].params.startTime, null);
    assert.notEqual(seen[0].params.startTime, 0);
    ws.close();
  });
});

test("GET /api/browser.list_tabs treats an empty windowId query value as malformed, never as handle 0", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const seen = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type !== "request") return;
      seen.push(message);
      ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result: listTabsResult({ windowId: 0 }) }));
    });

    await httpRequest({
      port,
      path: `/api/browser.list_tabs?windowId=&browserSessionId=${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(seen[0].params.windowId, null);
    assert.notEqual(seen[0].params.windowId, 0);
    ws.close();
  });
});

test("GET /api/browser.get_capabilities round-trips with no parameters", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws, capabilitiesResult());
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.get_capabilities",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 200);
    assert.deepEqual(json.result, capabilitiesResult());
    ws.close();
  });
});

test("an unknown /api/<method> route is reported as not found, not forwarded to the extension", async () => {
  await withService({}, async (_service, port) => {
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.not_a_real_method",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 404);
    assert.equal(json.error.code, "not_found");
  });
});

test("/api/toString and /api/__proto__ 404 rather than crashing the service", async () => {
  await withService({}, async (_service, port) => {
    for (const method of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      const { status, json } = await httpRequest({
        port,
        path: `/api/${method}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(status, 404, `/api/${method} should 404`);
      assert.equal(json.error.code, "not_found");
    }
    // The service must still be healthy afterward.
    const health = await httpRequest({ port, path: "/health" });
    assert.equal(health.status, 200);
  });
});

// Sends a hand-written raw HTTP request line over a plain TCP socket, since
// Node's own `http.request` client will not let a test construct a
// malformed request target (it validates/encodes it first) — this is the
// only way to actually exercise what the *server* does with one.
function sendRawRequest(port, rawRequestLine, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => {
      const headerLines = Object.entries({ Host: "127.0.0.1", Connection: "close", ...headers })
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");
      socket.write(`${rawRequestLine}\r\n${headerLines}\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
}

test("a malformed raw request target is rejected as an explicit 400 invalid_request, not a crash", async () => {
  await withService({}, async (_service, port) => {
    const raw = await sendRawRequest(port, "GET //[ HTTP/1.1", { "X-Protocol-Version": String(PROTOCOL_VERSION) });
    const [head, body] = raw.split("\r\n\r\n");
    const statusLine = head.split("\r\n")[0];
    assert.match(statusLine, /^HTTP\/1\.1 400 /);
    const json = JSON.parse(body);
    assert.equal(json.protocolVersion, PROTOCOL_VERSION);
    assert.equal(json.error.code, ERROR_CODES.INVALID_REQUEST);

    // The service itself must still be healthy and usable afterward.
    const health = await httpRequest({ port, path: "/health" });
    assert.equal(health.status, 200);
  });
});

test("a stale-handle outcome from the extension round-trips through the API unchanged", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws, { ...envelope("browser.read_tab", "error"), code: "stale_handle", detail: "No tab with id: 6." });
    const { status, json } = await httpRequest({
      port,
      path: `/api/browser.read_tab?tabId=6&browserSessionId=${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 200);
    assert.equal(json.result.status, "error");
    assert.equal(json.result.code, "stale_handle");
    ws.close();
  });
});

test("a stale_session outcome from the extension round-trips through the API unchanged", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws, { ...envelope("browser.list_tabs", "error"), code: "stale_session", detail: "mismatch" });
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_tabs?windowId=1&browserSessionId=old-session",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 200);
    assert.equal(json.result.code, "stale_session");
    ws.close();
  });
});

// --- Stage 2 remediation: envelope/shape validation at the service boundary

test("a legacy (pre-Stage-2) bare-array response is rejected as invalid_extension_response, not forwarded as if trustworthy", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws, [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 1 }]);
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 502);
    assert.equal(json.error.code, ERROR_CODES.INVALID_EXTENSION_RESPONSE);
    ws.close();
  });
});

test("a response whose sourceOperation does not match the requested method is rejected as invalid_extension_response", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws, listWindowsResult({ sourceOperation: "browser.list_tabs" }));
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 502);
    assert.equal(json.error.code, ERROR_CODES.INVALID_EXTENSION_RESPONSE);
    ws.close();
  });
});

test("an ok result missing required method-specific fields is rejected as invalid_extension_response", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    const broken = listWindowsResult();
    delete broken.windows;
    autoRespond(ws, broken);
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 502);
    assert.equal(json.error.code, ERROR_CODES.INVALID_EXTENSION_RESPONSE);
    ws.close();
  });
});

test("a non-ok result missing its code is rejected as invalid_extension_response", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws, envelope("browser.list_windows", "error")); // no `code`
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 502);
    assert.equal(json.error.code, ERROR_CODES.INVALID_EXTENSION_RESPONSE);
    ws.close();
  });
});

test("a well-formed incomplete/pagination_limit_reached result round-trips through the API as a valid outcome", async () => {
  await withService({}, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws, { ...envelope("browser.query_history", "incomplete"), code: ERROR_CODES.PAGINATION_LIMIT_REACHED });
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.query_history?startTime=0&endTime=1000&cursor=4999",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 200);
    assert.equal(json.result.status, "incomplete");
    assert.equal(json.result.code, ERROR_CODES.PAGINATION_LIMIT_REACHED);
    ws.close();
  });
});

// --- Service-boundary bounds ---------------------------------------------

test("the service boundary rejects requests over the configured rate limit", async () => {
  await withService({ rateLimitWindowMs: 60_000, rateLimitMaxRequests: 2 }, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws);

    const headers = { authorization: `Bearer ${TOKEN}` };
    const first = await httpRequest({ port, path: "/api/browser.list_windows", headers });
    const second = await httpRequest({ port, path: "/api/browser.list_windows", headers });
    const third = await httpRequest({ port, path: "/api/browser.list_windows", headers });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(third.status, 429);
    assert.equal(third.json.error.code, "rate_limited");
    ws.close();
  });
});

test("the rate limit window resets after it elapses", async () => {
  await withService({ rateLimitWindowMs: 50, rateLimitMaxRequests: 1 }, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws);
    const headers = { authorization: `Bearer ${TOKEN}` };

    const first = await httpRequest({ port, path: "/api/browser.list_windows", headers });
    assert.equal(first.status, 200);
    const second = await httpRequest({ port, path: "/api/browser.list_windows", headers });
    assert.equal(second.status, 429);

    await new Promise((resolve) => setTimeout(resolve, 80));
    const third = await httpRequest({ port, path: "/api/browser.list_windows", headers });
    assert.equal(third.status, 200);
    ws.close();
  });
});

test("the service boundary rejects a response that exceeds the configured size bound", async () => {
  await withService({ maxResponseBytes: 10 }, async (_service, port) => {
    const ws = await openAuthenticated(port);
    autoRespond(ws, listWindowsResult());

    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.list_windows",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 502);
    assert.equal(json.error.code, "response_too_large");
    ws.close();
  });
});

test("a response larger than the 2 MiB HTTP cap but within the 8 MiB WS transport cap still reaches the service and is reported as response_too_large", async () => {
  await withService({}, async (_service, port) => {
    // No overrides: exercises the real production constants. ~3 MiB of text
    // is comfortably below MAX_WS_MESSAGE_BYTES (8 MiB, so the transport
    // must deliver it) but well above MAX_RESPONSE_BYTES (2 MiB, so the
    // service must still report it as too large rather than ever sending
    // it to an HTTP caller).
    const ws = await openAuthenticated(port);
    const bigText = "x".repeat(3 * 1024 * 1024);
    autoRespond(ws, readTabResult({ text: bigText, characterCount: bigText.length, returnedCharacterCount: bigText.length }));

    const { status, json } = await httpRequest({
      port,
      path: `/api/browser.read_tab?tabId=42&browserSessionId=${SESSION_ID}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(status, 502);
    assert.equal(json.error.code, "response_too_large");
    ws.close();
  });
});

test("a response larger than the 8 MiB WS transport cap is rejected at the transport layer, never merely reported as response_too_large", async () => {
  await withService({}, async (_service, port) => {
    // No overrides: exercises the real production MAX_WS_MESSAGE_BYTES (8
    // MiB). ~9 MiB of text exceeds it entirely, so the WebSocket layer must
    // close the connection before the service can even evaluate the
    // response, rather than the HTTP caller ever receiving a
    // response_too_large (or any) reply from that particular request.
    const ws = await openAuthenticated(port);
    const hugeText = "x".repeat(9 * 1024 * 1024);

    const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(
      JSON.stringify({
        type: "response",
        protocolVersion: PROTOCOL_VERSION,
        id: "whatever",
        result: readTabResult({ text: hugeText, characterCount: hugeText.length, returnedCharacterCount: hugeText.length }),
      }),
    );
    const code = await closed;
    assert.equal(typeof code, "number");

    const health = await pollHealthUntilDisconnected({ port });
    assert.equal(health.status, 200);
    assert.equal(health.json.extension.connected, false);
    ws.close();
  });
});

test("an oversized inbound extension WebSocket message is rejected by the transport without crashing the service", async () => {
  await withService({ maxWsMessageBytes: 200 }, async (_service, port) => {
    const ws = await openAuthenticated(port);

    const closed = new Promise((resolve) => ws.once("close", (code) => resolve(code)));
    ws.send(
      JSON.stringify({
        type: "response",
        protocolVersion: PROTOCOL_VERSION,
        id: "whatever",
        result: listWindowsResult({ padding: "x".repeat(1000) }),
      }),
    );
    const code = await closed;
    assert.equal(typeof code, "number");

    // The service itself must still be healthy and usable afterward. The
    // client-side close event can win a race with the server's close handler,
    // so wait until /health observes the settled disconnected state.
    const health = await pollHealthUntilDisconnected({ port });
    assert.equal(health.status, 200);
    assert.equal(health.json.extension.connected, false);
  });
});

test("the authenticated control-stop endpoint invokes the shutdown callback after responding", async () => {
  let stopInvoked = false;
  await withService(
    {
      onControlStop: async () => {
        stopInvoked = true;
      },
    },
    async (_service, port) => {
      const { status, json } = await httpRequest({
        port,
        path: "/control/stop",
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(stopInvoked, true);
    },
  );
});

test("the control-stop endpoint requires authentication and does not invoke the callback otherwise", async () => {
  let stopInvoked = false;
  await withService(
    {
      onControlStop: async () => {
        stopInvoked = true;
      },
    },
    async (_service, port) => {
      const { status, json } = await httpRequest({ port, path: "/control/stop", method: "POST" });
      assert.equal(status, 401);
      assert.equal(json.error.code, "missing_credential");
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(stopInvoked, false);
    },
  );
});
