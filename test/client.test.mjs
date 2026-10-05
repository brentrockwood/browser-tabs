// Stage 4 (remediated): unit tests for the external-agent reference client
// module (client/browser-tabs-client.mjs) in isolation, using a scripted
// fake `fetch` — no real network, no real service. Verifies the client's
// own input validation, strict baseUrl/transport restrictions, response
// envelope validation, and credential loading; test/stage4-e2e.test.mjs
// exercises it against a real, scope-enforcing service.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BrowserTabsAgentClient,
  BrowserTabsAgentClientError,
  DEFAULT_PROTOCOL_VERSION,
  loadAgentCredential,
} from "../client/browser-tabs-client.mjs";

function jsonResponse(status, body, { bodyText } = {}) {
  const text = bodyText ?? JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json" } });
}

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return handler(new URL(url), init);
  };
  impl.calls = calls;
  return impl;
}

test("#request sends an authenticated, versioned, request-id-bearing GET and returns the decoded result", async () => {
  const fetchImpl = fakeFetch((url, init) => {
    assert.equal(url.pathname, "/api/browser.list_windows");
    return jsonResponse(200, { protocolVersion: DEFAULT_PROTOCOL_VERSION, requestId: init.headers["x-request-id"], result: { ok: true } });
  });
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl });
  const result = await client.listWindows();
  assert.deepEqual(result, { ok: true });

  const [{ init }] = fetchImpl.calls;
  assert.equal(init.headers.authorization, "Bearer tok");
  assert.equal(init.headers["x-protocol-version"], String(DEFAULT_PROTOCOL_VERSION));
  assert.equal(typeof init.headers["x-request-id"], "string");
  assert.ok(init.headers["x-request-id"].length > 0);
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "error");
});

test("captureTab calls workflow.capture_tab as a POST with query params and no body", async () => {
  const fetchImpl = fakeFetch((url, init) => {
    assert.equal(url.pathname, "/api/workflow.capture_tab");
    assert.equal(url.searchParams.get("tabId"), "42");
    assert.equal(url.searchParams.get("browserSessionId"), "sess-1");
    assert.equal(init.method, "POST");
    assert.equal(init.body, undefined);
    assert.equal(init.headers["content-type"], undefined);
    return jsonResponse(200, { protocolVersion: DEFAULT_PROTOCOL_VERSION, requestId: init.headers["x-request-id"], result: { id: 1, status: "ok" } });
  });
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl });
  const result = await client.captureTab({ tabId: 42, browserSessionId: "sess-1" });
  assert.deepEqual(result, { id: 1, status: "ok" });
});

test("there is no method on this client corresponding to store.captures.create, store.proposals.update, or any mutation beyond captureTab/createSummary/createProposal", () => {
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl: fakeFetch(() => assert.fail("must not be called")) });
  for (const name of ["createCapture", "updateProposal", "deleteCapture", "clear", "createCollection", "createTag", "call", "request"]) {
    assert.equal(typeof client[name], "undefined", `client must not expose "${name}"`);
  }
});

test("createSummary never sends creatorType/creatorName even if the caller passes them, and preserves modelMetadata verbatim", async () => {
  const fetchImpl = fakeFetch((url, init) => {
    assert.equal(url.pathname, "/api/store.summaries.create");
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ["modelMetadata", "sourceCaptureIds", "text"]);
    assert.equal(body.creatorType, undefined);
    assert.equal(body.creatorName, undefined);
    assert.deepEqual(body.modelMetadata, { model: "m1", prompt: "p1" });
    return jsonResponse(200, { protocolVersion: DEFAULT_PROTOCOL_VERSION, requestId: init.headers["x-request-id"], result: { id: 1 } });
  });
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl });
  await client.createSummary({
    text: "a summary",
    sourceCaptureIds: [1, 2],
    modelMetadata: { model: "m1", prompt: "p1" },
    // Even if a caller tries to assert these, the client has no parameter
    // slot for them — they are simply not forwarded.
    creatorType: "user",
    creatorName: "someone",
  });
});

// These validation failures are all synchronous: the client methods below
// are not themselves `async` and throw immediately, before ever reaching
// an `await` boundary or the private `#request` transport — so the correct
// assertion is `assert.throws` on a plain (non-awaited) function call, not
// `assert.rejects` (which is for a function that returns a rejecting
// Promise). Using `assert.rejects` here does not actually exercise these
// synchronous throws as intended.
test("createSummary requires at least one source capture id and bounds text length", () => {
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl: fakeFetch(() => assert.fail("must not be called")) });
  assert.throws(() => client.createSummary({ text: "x", sourceCaptureIds: [] }), TypeError);
  assert.throws(() => client.createSummary({ text: "", sourceCaptureIds: [1] }), TypeError);
  assert.throws(() => client.createSummary({ text: "x".repeat(50_001), sourceCaptureIds: [1] }), TypeError);
});

test("createProposal requires kind, rationale, a serializable payload, and at least one source id", () => {
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl: fakeFetch(() => assert.fail("must not be called")) });
  assert.throws(() => client.createProposal({ rationale: "r", payload: {}, sourceCaptureIds: [1] }), TypeError);
  assert.throws(() => client.createProposal({ kind: "tag", rationale: "", payload: {}, sourceCaptureIds: [1] }), TypeError);
  assert.throws(() => client.createProposal({ kind: "tag", rationale: "r", payload: [1, 2], sourceCaptureIds: [1] }), TypeError);
  assert.throws(() => client.createProposal({ kind: "tag", rationale: "r", payload: {} }), TypeError, "no source ids at all");
  assert.throws(() => client.createProposal({ kind: "not-a-kind", rationale: "r", payload: {}, sourceCaptureIds: [1] }), TypeError);
});

test("createProposal accepts a payload shaped like a self-approval or extension-method call as opaque data, sent verbatim", async () => {
  const adversarialPayload = { state: "accepted", method: "browser.list_windows", approved: true };
  const fetchImpl = fakeFetch((_url, init) => {
    const body = JSON.parse(init.body);
    assert.deepEqual(body.payload, adversarialPayload);
    assert.equal(body.creatorType, undefined);
    return jsonResponse(200, { protocolVersion: DEFAULT_PROTOCOL_VERSION, requestId: init.headers["x-request-id"], result: { id: 1, state: "pending" } });
  });
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl });
  const result = await client.createProposal({ kind: "collection", rationale: "r", payload: adversarialPayload, sourceCaptureIds: [1] });
  assert.equal(result.state, "pending");
});

test("listTabs/readTab/readCapture/listCaptures/listProposals reject malformed or out-of-bound arguments before calling fetch", () => {
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl: fakeFetch(() => assert.fail("must not be called")) });
  assert.throws(() => client.listTabs({ windowId: { nested: true } }), TypeError);
  assert.throws(() => client.readTab({ tabId: -1 }), TypeError);
  assert.throws(() => client.readTab({ tabId: 1.5 }), TypeError);
  assert.throws(() => client.readCapture({ id: 0 }), TypeError);
  assert.throws(() => client.readCapture({ id: 1, maxChars: 100_001 }), TypeError);
  assert.throws(() => client.listCaptures({ status: "not-a-status" }), TypeError);
  assert.throws(() => client.listProposals({ limit: 201 }), TypeError);
});

test("captureTab requires both tabId and browserSessionId", () => {
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl: fakeFetch(() => assert.fail("must not be called")) });
  assert.throws(() => client.captureTab({ browserSessionId: "s" }), TypeError);
  assert.throws(() => client.captureTab({ tabId: 1 }), TypeError);
});

test("#request surfaces a non-2xx error response as a BrowserTabsAgentClientError with the stable code/detail", async () => {
  const fetchImpl = fakeFetch((_url, init) =>
    jsonResponse(403, { protocolVersion: DEFAULT_PROTOCOL_VERSION, requestId: init.headers["x-request-id"], error: { code: "forbidden_scope", detail: "nope" } }),
  );
  const client = new BrowserTabsAgentClient({ token: "agent-tok", fetchImpl });
  await assert.rejects(
    () => client.listWindows(),
    (error) => {
      assert.ok(error instanceof BrowserTabsAgentClientError);
      assert.equal(error.status, 403);
      assert.equal(error.code, "forbidden_scope");
      assert.equal(error.detail, "nope");
      return true;
    },
  );
});

test("#request rejects a response with a mismatched protocolVersion", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { protocolVersion: 999, requestId: "r", result: {} }));
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl });
  await assert.rejects(() => client.listWindows(), /protocolVersion mismatch/);
});

test("#request rejects a response carrying both result and error, or neither", async () => {
  const bothFetch = fakeFetch(() => jsonResponse(200, { protocolVersion: DEFAULT_PROTOCOL_VERSION, requestId: "r", result: {}, error: { code: "x" } }));
  const bothClient = new BrowserTabsAgentClient({ token: "tok", fetchImpl: bothFetch });
  await assert.rejects(() => bothClient.listWindows(), /exactly one of result or error/);

  const neitherFetch = fakeFetch(() => jsonResponse(200, { protocolVersion: DEFAULT_PROTOCOL_VERSION, requestId: "r" }));
  const neitherClient = new BrowserTabsAgentClient({ token: "tok", fetchImpl: neitherFetch });
  await assert.rejects(() => neitherClient.listWindows(), /exactly one of result or error/);
});

test("#request rejects a response whose requestId does not match what was sent", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { protocolVersion: DEFAULT_PROTOCOL_VERSION, requestId: "not-the-one-we-sent", result: {} }));
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl });
  await assert.rejects(() => client.listWindows(), /requestId mismatch/);
});

test("#request rejects a response that omits requestId entirely, not just a wrong one", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { protocolVersion: DEFAULT_PROTOCOL_VERSION, result: {} }));
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl });
  await assert.rejects(() => client.listWindows(), /requestId mismatch/);
});

test("#request bounds how much response body it will buffer, independent of the server's own bound", async () => {
  const bigPayload = JSON.stringify({ protocolVersion: DEFAULT_PROTOCOL_VERSION, requestId: "r", result: { text: "x".repeat(1000) } });
  const fetchImpl = fakeFetch(() => jsonResponse(200, null, { bodyText: bigPayload }));
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl, maxResponseBytes: 10 });
  await assert.rejects(() => client.listWindows(), /response exceeded the maximum allowed size/);
});

test("#request reports malformed JSON explicitly rather than throwing an unrelated error", async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, null, { bodyText: "not json" }));
  const client = new BrowserTabsAgentClient({ token: "tok", fetchImpl });
  await assert.rejects(() => client.listWindows(), /not valid JSON/);
});

test("the constructor requires a non-empty token and strictly validates baseUrl", () => {
  const fetchImpl = fakeFetch(() => assert.fail("must not be reached"));
  assert.throws(() => new BrowserTabsAgentClient({ fetchImpl }), TypeError);
  assert.throws(() => new BrowserTabsAgentClient({ token: "", fetchImpl }), TypeError);

  const invalidBaseUrls = [
    "not a url",
    "https://127.0.0.1:8743/", // wrong scheme
    "http://localhost:8743/", // wrong host
    "http://127.0.0.1/", // missing explicit port
    "http://127.0.0.1:8743/api", // non-root path
    "http://127.0.0.1:8743/?x=1", // query string
    "http://127.0.0.1:8743/#frag", // fragment
    "http://user@127.0.0.1:8743/", // userinfo
  ];
  for (const baseUrl of invalidBaseUrls) {
    assert.throws(() => new BrowserTabsAgentClient({ token: "tok", fetchImpl, baseUrl }), TypeError, `expected baseUrl "${baseUrl}" to be rejected`);
  }

  // The default, and an equivalent explicit root path, must both be accepted.
  assert.doesNotThrow(() => new BrowserTabsAgentClient({ token: "tok", fetchImpl }));
  assert.doesNotThrow(() => new BrowserTabsAgentClient({ token: "tok", fetchImpl, baseUrl: "http://127.0.0.1:9000/" }));
});

test("loadAgentCredential reads BROWSER_TABS_AGENT_TOKEN first, without touching the filesystem", async () => {
  const token = await loadAgentCredential({ env: { BROWSER_TABS_AGENT_TOKEN: " secret-token " } });
  assert.equal(token, "secret-token");
});

test("loadAgentCredential falls back to a bounded file read and rejects an empty file", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-client-cred-"));
  try {
    const credentialPath = join(dataDir, "agent-token");
    await writeFile(credentialPath, "file-token\n");
    const token = await loadAgentCredential({ env: { BROWSER_TABS_AGENT_CREDENTIAL_FILE: credentialPath } });
    assert.equal(token, "file-token");

    const emptyPath = join(dataDir, "empty-credential");
    await writeFile(emptyPath, "   \n");
    await assert.rejects(() => loadAgentCredential({ env: { BROWSER_TABS_AGENT_CREDENTIAL_FILE: emptyPath } }), /is empty/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("loadAgentCredential rejects a credential file larger than the configured bound without reading it in full", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-client-cred-big-"));
  try {
    const credentialPath = join(dataDir, "agent-token");
    // Much larger than the tiny bound below, so this proves the bound is
    // actually enforced (not merely "large files happen to be rejected").
    await writeFile(credentialPath, "a".repeat(10_000));
    await assert.rejects(
      () => loadAgentCredential({ env: { BROWSER_TABS_AGENT_CREDENTIAL_FILE: credentialPath }, maxFileBytes: 16 }),
      /exceeds the maximum allowed size/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("loadAgentCredential never reads the owner credential file or env var", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-client-cred-owner-"));
  try {
    await writeFile(join(dataDir, "credential"), "owner-token-should-never-be-used\n");
    await assert.rejects(
      () => loadAgentCredential({ env: { BROWSER_TABS_TOKEN: "owner-token-should-never-be-used" }, defaultCredentialFile: join(dataDir, "does-not-exist") }),
      /no external-agent credential available/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("loadAgentCredential fails explicitly when nothing is configured", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-client-cred-missing-"));
  try {
    await assert.rejects(
      () => loadAgentCredential({ env: {}, defaultCredentialFile: join(dataDir, "does-not-exist") }),
      /no external-agent credential available/,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
