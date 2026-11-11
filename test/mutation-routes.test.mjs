// HTTP integration tests for the three direct mutation routes
// (POST /api/browser.create_tab_group, browser.update_tab_group,
// browser.move_tabs): the real service on a real loopback socket, with a
// scripted `ws` client standing in for the extension. What this verifies is
// the service boundary — authentication with the one pairing token, body
// bounds and shape validation before anything is forwarded, exactly one
// forwarded request, validation of the extension's answer, and a `changed`
// statement on every response. The extension's own behavior is unit tested
// in test/tab-group-mutations.test.mjs.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import WebSocket from "ws";

import { ERROR_CODES, PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { createService } from "../service/server.mjs";

const TOKEN = "mutation-test-token-0123456789";
const SESSION_ID = "session-1";

function httpRequest({ port, path, method = "POST", headers = {}, body }) {
  const finalHeaders = { "x-protocol-version": String(PROTOCOL_VERSION), authorization: `Bearer ${TOKEN}`, ...headers };
  for (const key of Object.keys(finalHeaders)) {
    if (finalHeaders[key] === undefined) delete finalHeaders[key];
  }
  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: finalHeaders }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // leave json null
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function withService(options, run) {
  const service = createService({ credentialToken: TOKEN, port: 0, host: "127.0.0.1", ...options });
  const address = await service.listen();
  try {
    await run(address.port);
  } finally {
    await service.close().catch(() => {});
  }
}

async function openExtension(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: "chrome-extension://test" });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const authOk = new Promise((resolve) => ws.once("message", resolve));
  ws.send(JSON.stringify({ type: "auth", protocolVersion: PROTOCOL_VERSION, token: TOKEN }));
  await authOk;
  return ws;
}

// Answers each forwarded request with `answer(request)` (or never, if it
// returns undefined) and records every request it received.
function respondWith(ws, answer) {
  const seen = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") return;
    seen.push(message);
    const result = answer(message);
    if (result !== undefined) ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result }));
  });
  return seen;
}

function envelope(sourceOperation, status = "ok", extra = {}) {
  return { schemaVersion: RESULT_SCHEMA_VERSION, browserSessionId: SESSION_ID, sourceOperation, capturedAt: 1_700_000_000_000, status, ...extra };
}

const GROUP = { groupId: 20, windowId: 2, title: "Reading", color: "blue", collapsed: false };
const tabsIn = (ids, groupId) => ids.map((tabId) => ({ tabId, windowId: 2, groupId }));

function createdResult(tabIds = [12, 13]) {
  return envelope("browser.create_tab_group", "ok", { changed: true, group: GROUP, tabs: tabsIn(tabIds, 20) });
}

test("a valid create request is forwarded exactly once, with only its normalized fields, and the observed group is returned", async () => {
  await withService({}, async (port) => {
    const ws = await openExtension(port);
    const seen = respondWith(ws, () => createdResult());
    const { status, json } = await httpRequest({
      port,
      path: "/api/browser.create_tab_group",
      body: { browserSessionId: SESSION_ID, tabIds: [12, 13], title: "Reading", color: "blue" },
    });
    assert.equal(status, 200);
    assert.deepEqual(json.result, createdResult());
    assert.equal(seen.length, 1);
    assert.equal(seen[0].method, "browser.create_tab_group");
    assert.deepEqual(seen[0].params, { tabIds: [12, 13], title: "Reading", color: "blue", browserSessionId: SESSION_ID });
    ws.close();
  });
});

test("update and move requests are forwarded under their public names; groupId null is forwarded as an explicit ungroup", async () => {
  await withService({}, async (port) => {
    const ws = await openExtension(port);
    const seen = respondWith(ws, (request) =>
      request.method === "browser.update_tab_group"
        ? envelope(request.method, "ok", { changed: true, group: { ...GROUP, groupId: 7, title: "" } })
        : envelope(request.method, "ok", { changed: true, group: null, tabs: tabsIn([12], -1) }),
    );
    const updated = await httpRequest({ port, path: "/api/browser.update_tab_group", body: { browserSessionId: SESSION_ID, groupId: 7, title: "" } });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.result.group.title, "");
    const moved = await httpRequest({ port, path: "/api/browser.move_tabs", body: { browserSessionId: SESSION_ID, tabIds: [12], groupId: null } });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.result.group, null);
    assert.deepEqual(
      seen.map((request) => [request.method, request.params]),
      [
        ["browser.update_tab_group", { groupId: 7, title: "", color: null, browserSessionId: SESSION_ID }],
        ["browser.move_tabs", { tabIds: [12], groupId: null, browserSessionId: SESSION_ID }],
      ],
    );
    ws.close();
  });
});

test("the one pairing token is required; a missing or wrong token is refused with changed: false and nothing is forwarded", async () => {
  await withService({}, async (port) => {
    const ws = await openExtension(port);
    const seen = respondWith(ws, () => createdResult());
    const body = { browserSessionId: SESSION_ID, tabIds: [12] };
    for (const [authorization, code] of [
      [undefined, ERROR_CODES.MISSING_CREDENTIAL],
      ["Bearer not-the-token", ERROR_CODES.INVALID_CREDENTIAL],
      ["Basic abc", ERROR_CODES.MISSING_CREDENTIAL],
    ]) {
      const { status, json } = await httpRequest({ port, path: "/api/browser.create_tab_group", headers: { authorization }, body });
      assert.equal(status, 401);
      assert.equal(json.error.code, code);
      assert.equal(json.error.changed, false);
    }
    const wrongVersion = await httpRequest({ port, path: "/api/browser.create_tab_group", headers: { "x-protocol-version": "6" }, body });
    assert.equal(wrongVersion.status, 400);
    assert.equal(wrongVersion.json.error.code, ERROR_CODES.UNSUPPORTED_PROTOCOL_VERSION);
    assert.deepEqual(seen, []);
    ws.close();
  });
});

test("malformed, oversized, and invalid bodies are refused before anything is forwarded", async () => {
  await withService({}, async (port) => {
    const ws = await openExtension(port);
    const seen = respondWith(ws, () => createdResult());
    for (const [path, body, status, code] of [
      ["/api/browser.create_tab_group", "{not json", 400, ERROR_CODES.INVALID_REQUEST],
      ["/api/browser.create_tab_group", "", 400, ERROR_CODES.INVALID_REQUEST],
      ["/api/browser.create_tab_group", "[1]", 400, ERROR_CODES.INVALID_REQUEST],
      ["/api/browser.create_tab_group", JSON.stringify({ tabIds: [1], pad: "x".repeat(20_000) }), 413, ERROR_CODES.PAYLOAD_TOO_LARGE],
      ["/api/browser.create_tab_group", { browserSessionId: SESSION_ID, tabIds: [] }, 400, ERROR_CODES.INVALID_PARAMS],
      ["/api/browser.create_tab_group", { browserSessionId: SESSION_ID, tabIds: [1], windowId: 2 }, 400, ERROR_CODES.INVALID_PARAMS],
      ["/api/browser.update_tab_group", { browserSessionId: SESSION_ID, groupId: 7 }, 400, ERROR_CODES.INVALID_PARAMS],
      ["/api/browser.update_tab_group", { browserSessionId: SESSION_ID, groupId: 7, collapsed: true }, 400, ERROR_CODES.INVALID_PARAMS],
      ["/api/browser.move_tabs", { browserSessionId: SESSION_ID, tabIds: [1] }, 400, ERROR_CODES.INVALID_PARAMS],
      ["/api/browser.move_tabs", { browserSessionId: SESSION_ID, tabIds: [1], groupId: 7, index: 0 }, 400, ERROR_CODES.INVALID_PARAMS],
    ]) {
      const response = await httpRequest({ port, path, body });
      assert.equal(response.status, status, `${path} ${String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 60)}`);
      assert.equal(response.json.error.code, code);
      assert.equal(response.json.error.changed, false);
    }
    assert.deepEqual(seen, []);
    ws.close();
  });
});

test("a missing or stale session is decided by the extension, and its refusal is returned as a changed: false result", async () => {
  await withService({}, async (port) => {
    const ws = await openExtension(port);
    const refusal = envelope("browser.move_tabs", "error", { code: ERROR_CODES.STALE_SESSION, detail: "stale", changed: false, browserSessionId: "current" });
    const seen = respondWith(ws, () => refusal);
    const { status, json } = await httpRequest({ port, path: "/api/browser.move_tabs", body: { tabIds: [1], groupId: 7 } });
    assert.equal(status, 200);
    assert.deepEqual(json.result, refusal);
    assert.equal("browserSessionId" in seen[0].params, false);
    ws.close();
  });
});

test("transport failures state whether the request could have changed the browser", async () => {
  const body = { browserSessionId: SESSION_ID, tabIds: [12], groupId: 7 };
  // Never sent: no extension is connected.
  await withService({}, async (port) => {
    const { status, json } = await httpRequest({ port, path: "/api/browser.move_tabs", body });
    assert.equal(status, 503);
    assert.deepEqual(json.error, { code: ERROR_CODES.DISCONNECTED, changed: false });
  });
  // Sent, but no answer arrived: unknown.
  await withService({ requestTimeoutMs: 100 }, async (port) => {
    const ws = await openExtension(port);
    const seen = respondWith(ws, () => undefined);
    const { status, json } = await httpRequest({ port, path: "/api/browser.move_tabs", body });
    assert.equal(status, 504);
    assert.deepEqual(json.error, { code: ERROR_CODES.REQUEST_TIMEOUT, changed: null });
    assert.equal(seen.length, 1, "sent once and never retried");
    ws.close();
  });
  // Sent, then the extension disconnected: unknown.
  await withService({}, async (port) => {
    const ws = await openExtension(port);
    respondWith(ws, () => {
      ws.close();
      return undefined;
    });
    const { status, json } = await httpRequest({ port, path: "/api/browser.move_tabs", body });
    assert.equal(status, 503);
    assert.deepEqual(json.error, { code: ERROR_CODES.DISCONNECTED, changed: null });
  });
});

test("an unusable extension answer is refused as invalid_extension_response with an unknown outcome", async () => {
  const request = { browserSessionId: SESSION_ID, tabIds: [12, 13], groupId: 20 };
  const moved = (extra) => envelope("browser.move_tabs", "ok", { changed: true, group: GROUP, tabs: tabsIn([12, 13], 20), ...extra });
  for (const answer of [
    envelope("browser.move_tabs", "error", { code: ERROR_CODES.GROUP_FAILED }), // no `changed`
    moved({ sourceOperation: "browser.create_tab_group" }),
    moved({ tabs: tabsIn([12], 20) }), // fewer tabs than requested
    moved({ tabs: tabsIn([13, 12], 20) }), // other order
    moved({ group: { ...GROUP, groupId: 21 }, tabs: tabsIn([12, 13], 21) }), // another group
    moved({ browserSessionId: "another-session" }),
    envelope("browser.move_tabs", "incomplete", { changed: true, code: ERROR_CODES.OBSERVE_FAILED, groupId: 21, windowId: 2, tabIds: null }),
    envelope("browser.move_tabs", "incomplete", { changed: true, code: ERROR_CODES.OBSERVE_FAILED, groupId: 20, windowId: 2, tabIds: [99] }),
  ]) {
    await withService({}, async (port) => {
      const ws = await openExtension(port);
      respondWith(ws, () => answer);
      const { status, json } = await httpRequest({ port, path: "/api/browser.move_tabs", body: request });
      assert.equal(status, 502, JSON.stringify(answer));
      assert.equal(json.error.code, ERROR_CODES.INVALID_EXTENSION_RESPONSE);
      assert.equal(json.error.changed, null);
      ws.close();
    });
  }
});

test("explicit failed, unknown, partial, and unsupported outcomes from the extension are returned unchanged", async () => {
  const outcomes = [
    envelope("browser.create_tab_group", "unsupported", { code: ERROR_CODES.UNSUPPORTED_FEATURE, changed: false }),
    envelope("browser.create_tab_group", "error", { code: ERROR_CODES.PINNED_TAB, changed: false }),
    envelope("browser.create_tab_group", "error", { code: ERROR_CODES.GROUP_FAILED, detail: "rejected", changed: null }),
    envelope("browser.create_tab_group", "incomplete", { code: ERROR_CODES.GROUP_UPDATE_FAILED, changed: true, groupId: 20, windowId: 2, tabIds: null }),
    envelope("browser.create_tab_group", "incomplete", { code: ERROR_CODES.OBSERVE_FAILED, changed: true, groupId: 20, windowId: 2, tabIds: [13] }),
  ];
  await withService({}, async (port) => {
    const ws = await openExtension(port);
    let next = 0;
    respondWith(ws, () => outcomes[next++]);
    for (const outcome of outcomes) {
      const { status, json } = await httpRequest({ port, path: "/api/browser.create_tab_group", body: { browserSessionId: SESSION_ID, tabIds: [12, 13] } });
      assert.equal(status, 200);
      assert.deepEqual(json.result, outcome);
    }
    ws.close();
  });
});

test("mutation requests count against the same rate limit as reads", async () => {
  await withService({ rateLimitMaxRequests: 1, rateLimitWindowMs: 60_000 }, async (port) => {
    const ws = await openExtension(port);
    const seen = respondWith(ws, () => createdResult([12]));
    const body = { browserSessionId: SESSION_ID, tabIds: [12] };
    assert.equal((await httpRequest({ port, path: "/api/browser.create_tab_group", body })).status, 200);
    const limited = await httpRequest({ port, path: "/api/browser.create_tab_group", body });
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.json.error, { code: ERROR_CODES.RATE_LIMITED, changed: false });
    assert.equal(seen.length, 1);
    ws.close();
  });
});

const CREATED_TAB = {
  tabId: 5, windowId: 2, index: 0, active: true, pinned: false, audible: false,
  discarded: false, groupId: -1, status: "loading", title: null, url: "https://example.com/",
};

for (const [method, body] of [
  ["browser.create_tab", { windowId: 2, url: "https://example.com/", pinned: true }],
  ["browser.set_tab_pinned", { tabId: 5, pinned: true }],
]) {
  const path = `/api/${method}`;
  const request = { browserSessionId: SESSION_ID, ...body };
  const good = () => envelope(method, "ok", { changed: true, tab: { ...CREATED_TAB, pinned: true } });

  test(`${method}: authenticated POST forwards normalized fields once and binds the result`, async () => {
    await withService({}, async (port) => {
      const ws = await openExtension(port);
      const seen = respondWith(ws, good);
      for (const authorization of [undefined, "Bearer wrong"]) {
        const denied = await httpRequest({ port, path, body: request, headers: { authorization } });
        assert.equal(denied.status, 401);
        assert.equal(denied.json.error.changed, false);
      }
      const version = await httpRequest({ port, path, body: request, headers: { "x-protocol-version": "0" } });
      assert.equal(version.status, 400);
      const invalid = await httpRequest({ port, path, body: { ...request, active: false } });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.json.error.changed, false);
      assert.equal(seen.length, 0);
      const response = await httpRequest({ port, path, body: request });
      assert.equal(response.status, 200);
      assert.deepEqual(response.json.result, good());
      assert.equal(seen.length, 1);
      assert.deepEqual(seen[0].params, method === "browser.create_tab" ? { ...request, groupId: null } : request);
      ws.close();
    });
  });

  test(`${method}: wrong session, identity, pin state and malformed results become unknown outcomes`, async () => {
    await withService({}, async (port) => {
      const ws = await openExtension(port);
      let result;
      const seen = respondWith(ws, () => result);
      const patches = [
        { browserSessionId: "other" }, { sourceOperation: "browser.list_tabs" },
        { tab: { ...good().tab, pinned: false } }, { tab: {} },
        { tab: { ...good().tab, [method === "browser.create_tab" ? "windowId" : "tabId"]: 999 } },
        { status: "incomplete", code: "observe_failed", tabId: method === "browser.create_tab" ? 5 : 999, windowId: 999 },
      ];
      if (method === "browser.create_tab") patches.push({ tab: { ...good().tab, pinned: false, groupId: 3 } });
      for (const patch of patches) {
        result = { ...good(), ...patch };
        const response = await httpRequest({ port, path, body: request });
        assert.equal(response.status, 502, JSON.stringify(patch));
        assert.equal(response.json.error.code, "invalid_extension_response");
        assert.equal(response.json.error.changed, null);
      }
      assert.equal(seen.length, patches.length);
      ws.close();
    });
  });

  test(`${method}: timeout is unknown and is not retried`, async () => {
    await withService({ requestTimeoutMs: 30 }, async (port) => {
      const ws = await openExtension(port);
      const seen = respondWith(ws, () => undefined);
      const response = await httpRequest({ port, path, body: request });
      assert.equal(response.status, 504);
      assert.equal(response.json.error.changed, null);
      assert.equal(seen.length, 1);
      ws.close();
    });
  });
}

test("create_tab: grouped success binds membership and partial grouping failure retains the created tab", async () => {
  await withService({}, async (port) => {
    const ws = await openExtension(port);
    let result = envelope("browser.create_tab", "ok", { changed: true, tab: { ...CREATED_TAB, groupId: 3 } });
    const seen = respondWith(ws, () => result);
    const send = () => httpRequest({ port, path: "/api/browser.create_tab", body: {
      browserSessionId: SESSION_ID, url: "https://example.com/", windowId: 2, groupId: 3,
    } });
    assert.equal((await send()).status, 200);
    result.tab.groupId = 4;
    assert.equal((await send()).status, 502);
    result = envelope("browser.create_tab", "incomplete", {
      changed: true, code: "group_failed", tabId: 5, windowId: 2,
    });
    assert.deepEqual((await send()).json.result, result);
    assert.equal(seen.length, 3);
    ws.close();
  });
});
