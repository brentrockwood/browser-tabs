// Real local end-to-end simulation of the Stage 1 bridge: the actual
// service (`createService`) listens on a real loopback socket, and a real
// `ws` client stands in for the extension's WebSocket connection — no
// mocked sockets, no browser required. Covers authentication, origin
// rejection, request correlation (including out-of-order responses),
// timeouts, graceful shutdown with in-flight work, connection replacement
// ownership, the versioned request/response contract, and the
// authenticated control-stop endpoint.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import WebSocket from "ws";

import { createService } from "../service/server.mjs";

const TOKEN = "integration-test-token-0123456789";
const EXTENSION_ORIGIN = "chrome-extension://test-extension-id";

// Defaults every request to a valid X-Protocol-Version header, since the
// service now strictly requires one on every HTTP request; a caller can
// still override it (e.g. to a wrong value) or truly omit it (by passing
// `"x-protocol-version": undefined`) for tests that specifically exercise
// that enforcement. Node's http client does *not* silently drop an
// `undefined`-valued header itself (it throws ERR_HTTP_INVALID_HEADER_
// VALUE), so any such key is deleted here before the request is built.
function httpRequest({ port, path, method = "GET", headers = {} }) {
  const finalHeaders = { "x-protocol-version": "1", ...headers };
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
  ws.send(JSON.stringify({ type: "auth", protocolVersion: 1, token }));
  await authOkPromise;
  return ws;
}

// Auto-replies to any forwarded "request" with a canned result, echoing the
// request's id. Returns the list of requests observed, in arrival order.
function autoRespond(ws, result = [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 1 }]) {
  const seen = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "request") {
      seen.push(message);
      ws.send(JSON.stringify({ type: "response", protocolVersion: 1, id: message.id, result }));
    }
  });
  return seen;
}

test("health reports the extension as disconnected before any extension connects", async () => {
  await withService({}, async (_service, port) => {
    const { status, json } = await httpRequest({ port, path: "/health" });
    assert.equal(status, 200);
    assert.equal(json.protocolVersion, 1);
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
    assert.equal(json.protocolVersion, 1);
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

test("the websocket connection is rejected and closed for an invalid pairing token", async () => {
  await withService({}, async (_service, port) => {
    const ws = connectAsExtension(port);
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    const authErrorPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: "auth", protocolVersion: 1, token: "wrong-token" }));
    const authError = await authErrorPromise;
    assert.deepEqual(authError, { type: "auth_error", protocolVersion: 1, code: "invalid_credential" });
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
    assert.deepEqual(authError, { type: "auth_error", protocolVersion: 1, code: "unsupported_protocol_version" });
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
    assert.deepEqual(authError, { type: "auth_error", protocolVersion: 1, code: "unsupported_protocol_version" });
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
    assert.deepEqual(json.result, [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 1 }]);

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
        ws.send(JSON.stringify({ type: "response", protocolVersion: 1, id: seen[1].id, result: { forId: seen[1].id } }));
        ws.send(JSON.stringify({ type: "response", protocolVersion: 1, id: seen[0].id, result: { forId: seen[0].id } }));
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
    ws.send(JSON.stringify({ type: "ping", protocolVersion: 1 }));
    assert.deepEqual(await pongPromise, { type: "pong", protocolVersion: 1 });
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
    ws.send(JSON.stringify({ type: "ping", protocolVersion: 1 }));
    assert.deepEqual(await pongPromise, { type: "pong", protocolVersion: 1 });
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
    ws.send(JSON.stringify({ type: "response", id: request.id, result: ["no-version"] }));
    ws.send(JSON.stringify({ type: "response", protocolVersion: 999, id: request.id, result: ["wrong-version"] }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    ws.send(JSON.stringify({ type: "response", protocolVersion: 1, id: request.id, result: ["correct-version"] }));
    const { status, json } = await resultPromise;
    assert.equal(status, 200);
    assert.deepEqual(json.result, ["correct-version"]);
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
        second.send(JSON.stringify({ type: "response", protocolVersion: 1, id: message.id, result: ["ok-from-second"] }));
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
    assert.deepEqual(json.result, ["ok-from-second"]);
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
