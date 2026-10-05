// Stage 4 (remediated): integration tests for the distinct owner/
// external-agent credential scopes (service/credential.mjs,
// service/server.mjs's AGENT_ALLOWED_* allowlists and creator-identity
// override). Real service, real SQLite-backed store, and a real `ws`
// client standing in for the extension — no mocked sockets.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { createService } from "../service/server.mjs";
import { openStore } from "../service/store.mjs";

const OWNER_TOKEN = "scoped-auth-owner-token-0123456789";
const AGENT_TOKEN = "scoped-auth-agent-token-0123456789";
const AGENT_CREATOR_NAME = "test-reference-agent";
const EXTENSION_ORIGIN = "chrome-extension://scoped-auth-test-extension";
const SESSION_ID = "scoped-auth-session";

function httpRequest({ port, path, method = "GET", token, body, extraHeaders = {} }) {
  const headers = { "x-protocol-version": String(PROTOCOL_VERSION), ...extraHeaders };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(raw);
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

function connectAsExtension(port) {
  return new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: EXTENSION_ORIGIN });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

async function openAuthenticatedExtension(port, token) {
  const ws = connectAsExtension(port);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ type: "auth", protocolVersion: PROTOCOL_VERSION, token }));
  const message = await reply;
  return { ws, message };
}

function readTabResultFor(tabId) {
  const text = `fixture text for tab ${tabId}`;
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: SESSION_ID,
    sourceOperation: "browser.read_tab",
    capturedAt: 1_700_000_000_000 + tabId,
    status: "ok",
    tabId,
    windowId: 1,
    url: `https://example.com/tab/${tabId}`,
    title: `Tab ${tabId}`,
    documentReadyState: "complete",
    text,
    characterCount: text.length,
    returnedCharacterCount: text.length,
    truncated: false,
  };
}

// tabId 999 is a reserved sentinel in this fake, standing in for a real
// non-"ok" outcome (e.g. a stale/closed tab) — see the dedicated
// non-"ok" persistence test below.
const STALE_TAB_ID = 999;

function envelope(sourceOperation, status = "ok") {
  return { schemaVersion: RESULT_SCHEMA_VERSION, browserSessionId: SESSION_ID, sourceOperation, capturedAt: Date.now(), status };
}

// A minimal, but validateMethodResult-valid, "ok" browser.list_windows
// result — required because the agent-scope allowlist test below actually
// calls this route, and the service rejects any extension response that
// does not match the real Stage 2 envelope+per-method shape
// (extension/protocol.js's validateMethodResult) as 502
// invalid_extension_response, regardless of caller scope. A bare
// `{ status: "error" }` (this fake's previous, too-minimal stand-in) would
// fail that validation and make the route look broken, when it is this
// fake that was incomplete.
function listWindowsResult() {
  return {
    ...envelope("browser.list_windows"),
    windows: [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 1 }],
    returnedCount: 1,
    totalCount: 1,
    truncated: false,
  };
}

function capabilitiesResult() {
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
  };
}

// Covers every browser.* method this test file actually exercises
// (browser.read_tab, browser.list_windows, browser.get_capabilities), each
// with a real, validateMethodResult-valid envelope+shape for its own
// method — never a placeholder shape borrowed from a different method.
function installBrowserFake(ws) {
  ws.requestCount = 0;
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") return;
    ws.requestCount += 1;
    let result;
    if (message.method === "browser.read_tab") {
      result =
        message.params.tabId === STALE_TAB_ID
          ? { ...envelope("browser.read_tab", "error"), code: "stale_handle", tabId: STALE_TAB_ID, windowId: 1 }
          : readTabResultFor(message.params.tabId);
    } else if (message.method === "browser.list_windows") {
      result = listWindowsResult();
    } else if (message.method === "browser.get_capabilities") {
      result = capabilitiesResult();
    } else {
      result = { ...envelope(message.method, "error"), code: "unsupported_in_test_fake" };
    }
    ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result }));
  });
}

async function withScopedService(run, { agentCredentialToken = AGENT_TOKEN } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-scoped-auth-"));
  const store = await openStore({ dataDir });
  const service = createService({
    credentialToken: OWNER_TOKEN,
    agentCredentialToken,
    agentCreatorName: AGENT_CREATOR_NAME,
    store,
  });
  const address = await service.listen();
  const extension = await openAuthenticatedExtension(address.port, OWNER_TOKEN);
  installBrowserFake(extension.ws);
  try {
    await run({ port: address.port, store, extensionWs: extension.ws });
  } finally {
    extension.ws.close();
    await service.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

// ---- browser.* allowlist ----

test("agent scope can call every allowlisted browser.* read route", async () => {
  await withScopedService(async ({ port }) => {
    const windows = await httpRequest({ port, path: "/api/browser.list_windows", token: AGENT_TOKEN });
    assert.equal(windows.status, 200);

    const capabilities = await httpRequest({ port, path: "/api/browser.get_capabilities", token: AGENT_TOKEN });
    assert.equal(capabilities.status, 200);

    const readTab = await httpRequest({ port, path: `/api/browser.read_tab?tabId=5&browserSessionId=${SESSION_ID}`, token: AGENT_TOKEN });
    assert.equal(readTab.status, 200);
    assert.equal(readTab.json.result.status, "ok");
  });
});

// ---- workflow.capture_tab: the only agent capture-creation path ----

test("workflow.capture_tab persists the server's own freshly-fetched browser.read_tab result for agent scope", async () => {
  await withScopedService(async ({ port }) => {
    const response = await httpRequest({
      port,
      method: "POST",
      path: `/api/workflow.capture_tab?tabId=7&browserSessionId=${SESSION_ID}`,
      token: AGENT_TOKEN,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.result.status, "ok");
    assert.equal(response.json.result.tabId, 7);
    assert.equal(response.json.result.text, undefined, "the bounded create projection must omit raw text");

    const listed = await httpRequest({ port, path: "/api/store.captures.list", token: OWNER_TOKEN });
    assert.equal(listed.json.result.total, 1);
    assert.equal(listed.json.result.items[0].tabId, 7);
  });
});

test("workflow.capture_tab also persists a non-ok browser.read_tab outcome, never inventing page content", async () => {
  await withScopedService(async ({ port }) => {
    const response = await httpRequest({
      port,
      method: "POST",
      path: `/api/workflow.capture_tab?tabId=${STALE_TAB_ID}&browserSessionId=${SESSION_ID}`,
      token: AGENT_TOKEN,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.result.status, "error");
    assert.equal(response.json.result.code, "stale_handle");
    // The bounded create/list projection (rowToCaptureListItem in
    // service/store.mjs) always has a `text` key replaced by `textLength`
    // regardless of status, so it is simply absent (`undefined`) here —
    // never invented page content, but also not the same normalization as
    // the fields below. `url`/`title`/`documentReadyState`/
    // `characterCount` remain present keys on every capture row (the
    // database columns are nullable, not absent), explicitly normalized to
    // `null` for a non-"ok" capture rather than any invented value — this
    // is the documented, consistent "absent" representation
    // (service/validation.mjs's optionalNullableString/
    // optionalNullableNonNegativeInteger), not invented "ok"-only content.
    assert.equal(response.json.result.text, undefined, 'the bounded projection never includes raw "text"');
    for (const field of ["url", "title", "documentReadyState", "characterCount"]) {
      assert.equal(response.json.result[field], null, `a non-"ok" capture normalizes "${field}" to null, never an invented value`);
    }

    const listed = await httpRequest({ port, path: `/api/store.captures.list?tabId=${STALE_TAB_ID}`, token: OWNER_TOKEN });
    assert.equal(listed.json.result.total, 1);
    assert.equal(listed.json.result.items[0].status, "error");
    assert.equal(listed.json.result.items[0].code, "stale_handle");
  });
});

test("workflow.capture_tab rejects a forged request body with a stable 400 invalid_request, never contacting the extension or persisting a capture", async () => {
  await withScopedService(async ({ port, extensionWs }) => {
    const response = await httpRequest({
      port,
      method: "POST",
      path: `/api/workflow.capture_tab?tabId=11&browserSessionId=${SESSION_ID}`,
      token: AGENT_TOKEN,
      body: { schemaVersion: 1, browserSessionId: SESSION_ID, sourceOperation: "browser.read_tab", capturedAt: 0, status: "ok", tabId: 11, text: "forged" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "invalid_request");
    assert.equal(extensionWs.requestCount, 0, "the extension must never be contacted for a rejected forged-body request");

    const listed = await httpRequest({ port, path: "/api/store.captures.list", token: OWNER_TOKEN });
    assert.equal(listed.json.result.total, 0, "no capture must be persisted for a rejected forged-body request");
  });
});

test("workflow.capture_tab's normal no-body POST still works, unaffected by the forged-body rejection above", async () => {
  await withScopedService(async ({ port, extensionWs }) => {
    const response = await httpRequest({
      port,
      method: "POST",
      path: `/api/workflow.capture_tab?tabId=12&browserSessionId=${SESSION_ID}`,
      token: AGENT_TOKEN,
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.result.status, "ok");
    assert.equal(extensionWs.requestCount, 1);
  });
});

// ---- store.* allowlist ----

test("agent scope can create and list summaries/proposals and list/read captures", async () => {
  await withScopedService(async ({ port }) => {
    const capture = await httpRequest({
      port,
      method: "POST",
      path: `/api/workflow.capture_tab?tabId=1&browserSessionId=${SESSION_ID}`,
      token: AGENT_TOKEN,
    });
    const captureId = capture.json.result.id;

    const readCapture = await httpRequest({ port, path: `/api/store.captures.read?id=${captureId}`, token: AGENT_TOKEN });
    assert.equal(readCapture.status, 200);

    const summary = await httpRequest({
      port,
      method: "POST",
      path: "/api/store.summaries.create",
      token: AGENT_TOKEN,
      body: { text: "agent summary", sourceCaptureIds: [captureId] },
    });
    assert.equal(summary.status, 200);

    const listSummaries = await httpRequest({ port, path: "/api/store.summaries.list", token: AGENT_TOKEN });
    assert.equal(listSummaries.status, 200);

    const proposal = await httpRequest({
      port,
      method: "POST",
      path: "/api/store.proposals.create",
      token: AGENT_TOKEN,
      body: { kind: "collection", rationale: "r", payload: {}, sourceCaptureIds: [captureId] },
    });
    assert.equal(proposal.status, 200);

    const listProposals = await httpRequest({ port, path: "/api/store.proposals.list", token: AGENT_TOKEN });
    assert.equal(listProposals.status, 200);
  });
});

// ---- the forbidden set: everything else ----

test("agent scope is rejected with 403 forbidden_scope for store.captures.create (direct), updates, deletes, tags/collections/queue, retention, and clear", async () => {
  await withScopedService(async ({ port }) => {
    const forbidden = [
      { method: "POST", path: "/api/store.captures.create", body: { schemaVersion: 1, browserSessionId: "x", sourceOperation: "browser.read_tab", capturedAt: 0, status: "error", code: "x" } },
      { method: "PATCH", path: "/api/store.summaries.update?id=1", body: { text: "x" } },
      { method: "DELETE", path: "/api/store.summaries.delete?id=1" },
      { method: "DELETE", path: "/api/store.captures.delete?id=1" },
      { method: "PATCH", path: "/api/store.proposals.update?id=1", body: { state: "accepted", creatorType: "user" } },
      { method: "DELETE", path: "/api/store.proposals.delete?id=1" },
      { method: "POST", path: "/api/store.tags.create", body: { name: "t" } },
      { method: "POST", path: "/api/store.collections.create", body: { name: "c" } },
      { method: "POST", path: "/api/store.queue.create", body: { recordType: "capture", recordId: 1, state: "new" } },
      { method: "GET", path: "/api/store.retention.get" },
      { method: "POST", path: "/api/store.clear" },
    ];
    for (const { method, path, body } of forbidden) {
      const response = await httpRequest({ port, method, path, token: AGENT_TOKEN, body });
      assert.equal(response.status, 403, `${method} ${path} should be 403 for agent scope, got ${response.status}: ${JSON.stringify(response.json)}`);
      assert.equal(response.json.error.code, "forbidden_scope", `${method} ${path}`);
    }
  });
});

test("agent scope is rejected with 403 for POST /control/stop, never shutting the service down", async () => {
  await withScopedService(async ({ port }) => {
    const response = await httpRequest({ port, method: "POST", path: "/control/stop", token: AGENT_TOKEN });
    assert.equal(response.status, 403);
    assert.equal(response.json.error.code, "forbidden_scope");

    // Confirm the service really is still up.
    const health = await httpRequest({ port, path: "/health" });
    assert.equal(health.status, 200);
  });
});

test("an unknown route is 404 regardless of scope, never 403 (no arbitrary generic route is reachable)", async () => {
  await withScopedService(async ({ port }) => {
    for (const token of [AGENT_TOKEN, OWNER_TOKEN]) {
      const response = await httpRequest({ port, path: "/api/store.nonexistent_method", token });
      assert.equal(response.status, 404);
    }
  });
});

test("the agent token cannot authenticate as the extension's WebSocket connection", async () => {
  await withScopedService(async ({ port }) => {
    const { message } = await openAuthenticatedExtension(port, AGENT_TOKEN);
    assert.equal(message.type, "auth_error");
    assert.equal(message.code, "invalid_credential");
  });
});

// ---- creator-identity override ----

test("an agent-scoped summary/proposal creation always records the fixed external-agent identity, regardless of a claimed creatorType", async () => {
  await withScopedService(async ({ port }) => {
    const capture = await httpRequest({
      port,
      method: "POST",
      path: `/api/workflow.capture_tab?tabId=3&browserSessionId=${SESSION_ID}`,
      token: AGENT_TOKEN,
    });
    const captureId = capture.json.result.id;

    const summary = await httpRequest({
      port,
      method: "POST",
      path: "/api/store.summaries.create",
      token: AGENT_TOKEN,
      body: { text: "s", sourceCaptureIds: [captureId], creatorType: "user", creatorName: "attacker-claimed-name" },
    });
    assert.equal(summary.status, 200);
    assert.equal(summary.json.result.creatorType, "agent");
    assert.equal(summary.json.result.creatorName, AGENT_CREATOR_NAME);

    const proposal = await httpRequest({
      port,
      method: "POST",
      path: "/api/store.proposals.create",
      token: AGENT_TOKEN,
      body: { kind: "tag", rationale: "r", payload: { state: "accepted" }, sourceCaptureIds: [captureId], creatorType: "user", creatorName: "attacker-claimed-name" },
    });
    assert.equal(proposal.status, 200);
    assert.equal(proposal.json.result.creatorType, "agent");
    assert.equal(proposal.json.result.creatorName, AGENT_CREATOR_NAME);
    // The payload itself is still stored verbatim (opaque data) — only the
    // creator identity fields are overridden, and the state must still be
    // the service's own default, never the payload's claim.
    assert.deepEqual(proposal.json.result.payload, { state: "accepted" });
    assert.equal(proposal.json.result.state, "pending");
  });
});

// ---- owner scope is unaffected by any of the above ----

test("owner scope retains full, unscoped access even when an agent credential is also configured", async () => {
  await withScopedService(async ({ port }) => {
    const retention = await httpRequest({ port, path: "/api/store.retention.get", token: OWNER_TOKEN });
    assert.equal(retention.status, 200);

    const tag = await httpRequest({ port, method: "POST", path: "/api/store.tags.create", token: OWNER_TOKEN, body: { name: "owner-tag", creatorType: "user" } });
    assert.equal(tag.status, 200);

    const cleared = await httpRequest({ port, method: "POST", path: "/api/store.clear", token: OWNER_TOKEN });
    assert.equal(cleared.status, 200);

    const stopResponse = await httpRequest({ port, method: "POST", path: "/control/stop", token: OWNER_TOKEN });
    assert.equal(stopResponse.status, 200);
  });
});

// ---- createService fails fast on a misconfigured, shared credential ----

test("createService throws synchronously if agentCredentialToken equals credentialToken, never granting owner scope to the agent token", () => {
  assert.throws(
    () => createService({ credentialToken: OWNER_TOKEN, agentCredentialToken: OWNER_TOKEN, store: null }),
    /agentCredentialToken must not equal credentialToken/,
  );
});

test("createService is unaffected when agentCredentialToken is distinct from credentialToken, or absent entirely", () => {
  assert.doesNotThrow(() => createService({ credentialToken: OWNER_TOKEN, agentCredentialToken: AGENT_TOKEN, store: null }));
  assert.doesNotThrow(() => createService({ credentialToken: OWNER_TOKEN, store: null }));
  assert.doesNotThrow(() => createService({ credentialToken: OWNER_TOKEN, agentCredentialToken: null, store: null }));
});

// ---- backward compatibility: no agent credential configured at all ----

test("with no agentCredentialToken configured, only the owner token authenticates at all (unchanged from before Stage 4)", async () => {
  await withScopedService(
    async ({ port }) => {
      const response = await httpRequest({ port, path: "/api/browser.list_windows", token: AGENT_TOKEN });
      assert.equal(response.status, 401);
      assert.equal(response.json.error.code, "invalid_credential");
    },
    { agentCredentialToken: null },
  );
});
