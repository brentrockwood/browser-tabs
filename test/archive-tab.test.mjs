// Phase 2 Action 4 ("archive a tab: save a capture, then close exactly that
// tab"), service side: the action store's fourth kind (binding, results with a
// capture id, append-only audit, migration v6, clear, restart reconciliation),
// the owner-only HTTP routes (preview binding, id-only approve/reject, the
// capture-then-close ordering, every stale/partial/failed/unknown outcome,
// exactly-once execution), and the full path through the real extension worker
// and service client.
//
// Real service, real SQLite-backed store, and a real `ws` client standing in
// for the extension in the HTTP tests; the end-to-end section at the bottom
// replaces the stand-in with the real extension code over a mock browser.
// Actions 1-3 are covered by their own test files.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";

import { MAX_ARCHIVE_URL_LENGTH, PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { createServiceClient } from "../extension/service-client.js";
import { createService } from "../service/server.mjs";
import { DATABASE_FILE_NAME, MIGRATIONS, openStore, runMigrations } from "../service/store.mjs";
import { ACTION_INTERRUPTED_DETAIL, ACTION_MUTATIONS, ACTION_RESULT_STATES, MAX_PENDING_ACTIONS } from "../service/validation.mjs";

const OWNER_TOKEN = "archive-owner-token-0123456789";
const AGENT_TOKEN = "archive-agent-token-0123456789";
const EXTENSION_ORIGIN = "chrome-extension://archive-test-extension";
const SESSION_ID = "archive-session";
const URL_ONE = "https://example.com/page";

const BINDING = { tabId: 5, windowId: 2, url: URL_ONE, groupId: -1, pinned: false, title: "A page" };

async function withTempDir(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-archive-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function withStore(run) {
  await withTempDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    try {
      await run(store, dataDir);
    } finally {
      store.close();
    }
  });
}

const archivePreview = (store, binding = BINDING, overrides = {}) =>
  store.createAction({ kind: "archive_tab", browserSessionId: SESSION_ID, binding, ...overrides });

function closedResult(overrides = {}) {
  return { state: "executed", mutation: "closed", code: null, detail: null, captureId: 1, tabId: 5, windowId: 2, ...overrides };
}

function assertAuditContentFree(events) {
  const allowed = {
    kind: ["open_tab", "configure_group", "move_tabs", "archive_tab"],
    decision: ["approve", "reject"],
    state: ACTION_RESULT_STATES,
    mutation: ACTION_MUTATIONS,
  };
  for (const event of events) {
    for (const [key, value] of Object.entries(event.detail)) {
      assert.ok(Object.hasOwn(allowed, key), `unexpected audit detail key: ${key}`);
      assert.ok(allowed[key].includes(value), `audit detail ${key} must be a fixed enum value, got ${JSON.stringify(value)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Store: previews bind the exact tab and its state
// ---------------------------------------------------------------------------

test("createAction records an archive preview bound to the tab, window, address, group, pinned state, title, and session, executing nothing", async () => {
  await withStore(async (store) => {
    const action = archivePreview(store);
    assert.equal(action.id, 1);
    assert.equal(action.kind, "archive_tab");
    assert.equal(action.url, null);
    assert.deepEqual(action.binding, BINDING);
    assert.equal(action.browserSessionId, SESSION_ID);
    assert.equal(action.state, "previewed");
    assert.equal(action.result, null);
    assert.equal(store.listCaptures({}).total, 0, "a preview saves no capture");

    const pinned = archivePreview(store, { ...BINDING, groupId: 9, pinned: true, title: null });
    assert.deepEqual([pinned.binding.groupId, pinned.binding.pinned, pinned.binding.title], [9, true, null]);
  });
});

test("an archive binding keeps the whole address (up to the maximum) and a bounded title, and ignores unknown fields", async () => {
  await withStore(async (store) => {
    const url = `https://example.com/${"a".repeat(MAX_ARCHIVE_URL_LENGTH - "https://example.com/".length)}`;
    assert.equal(url.length, MAX_ARCHIVE_URL_LENGTH);
    const action = archivePreview(store, { ...BINDING, url, title: "t".repeat(500), junk: "SECRET-JUNK" });
    assert.equal(action.binding.url, url, "stored whole, never clipped: the close compares it for equality");
    assert.equal(action.binding.title.length, 500);
    assert.ok(!JSON.stringify(action.binding).includes("SECRET-JUNK"));
  });
});

test("createAction refuses an invalid archive preview, leaving no record and no audit event", async () => {
  await withStore(async (store) => {
    const bad = [
      null,
      "archive",
      [],
      {},
      { ...BINDING, tabId: -1 },
      { ...BINDING, tabId: "5" },
      { ...BINDING, windowId: undefined },
      { ...BINDING, url: undefined },
      { ...BINDING, url: null },
      { ...BINDING, url: "" },
      { ...BINDING, url: "u".repeat(MAX_ARCHIVE_URL_LENGTH + 1) },
      { ...BINDING, groupId: undefined },
      { ...BINDING, groupId: -2 },
      { ...BINDING, pinned: undefined },
      { ...BINDING, pinned: "no" },
      { ...BINDING, title: 5 },
      { ...BINDING, title: "t".repeat(501) },
    ];
    for (const binding of bad) {
      assert.throws(() => archivePreview(store, binding), (e) => e.code === "validation_error", JSON.stringify(binding)?.slice(0, 80));
    }
    for (const browserSessionId of [undefined, "", 5, "s".repeat(201)]) {
      assert.throws(() => archivePreview(store, BINDING, { browserSessionId }), (e) => e.code === "validation_error");
    }
    assert.equal(store.listActions().total, 0);
    assert.equal(store.listActionAudit().total, 0);
  });
});

test("an archive action's bound fields are immutable even to raw SQL, and the table accepts no malformed kind/url/binding combination", async () => {
  await withStore(async (store) => {
    const { id } = archivePreview(store);
    const raw = new DatabaseSync(store.dbPath);
    try {
      assert.throws(() => raw.exec(`UPDATE actions SET binding = '{}' WHERE id = ${id}`), /immutable/);
      assert.throws(() => raw.exec(`UPDATE actions SET kind = 'move_tabs' WHERE id = ${id}`), /immutable/);
      assert.throws(() => raw.exec("INSERT INTO actions (kind, url, binding, browser_session_id, state, previewed_at) VALUES ('archive_tab', 'https://x/', '{}', 's', 'previewed', 0)"), /CHECK/);
      assert.throws(() => raw.exec("INSERT INTO actions (kind, browser_session_id, state, previewed_at) VALUES ('archive_tab', 's', 'previewed', 0)"), /CHECK/);
      assert.throws(() => raw.exec("INSERT INTO actions (kind, url, binding, browser_session_id, state, previewed_at) VALUES ('delete_tab', NULL, '{}', 's', 'previewed', 0)"), /CHECK/);
    } finally {
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Store: results (a capture id when one was saved)
// ---------------------------------------------------------------------------

test("recordActionResult stores an archive's result with its capture id and the closed tab's handles", async () => {
  await withStore(async (store) => {
    const { id } = archivePreview(store);
    store.decideAction(id, "approve");
    const done = store.recordActionResult(id, closedResult());
    assert.equal(done.state, "executed");
    assert.deepEqual(done.result, { mutation: "closed", code: null, detail: null, captureId: 1, tabId: 5, windowId: 2, observed: null });
    assert.throws(() => store.recordActionResult(id, closedResult()), (e) => e.code === "conflict", "a result is recorded once");
  });
});

test("every archive result state can be recorded with its own consistent shape", async () => {
  await withStore(async (store) => {
    const results = [
      closedResult(),
      { state: "partial", mutation: "none", code: "state_mismatch", detail: "left open", captureId: 3 },
      { state: "stale", mutation: "none", code: "stale_session" },
      { state: "failed", mutation: "none", code: "invalid_extension_response" },
      { state: "failed", mutation: "unknown", code: "close_failed", captureId: 3 },
      { state: "failed", mutation: "unknown", code: "interrupted_by_restart" }, // capture status unknown
    ];
    for (const result of results) {
      const { id } = archivePreview(store);
      store.decideAction(id, "approve");
      assert.equal(store.recordActionResult(id, result).state, result.state);
    }
  });
});

test("recordActionResult validates an archive result: consistent state/mutation/capture/handles", async () => {
  await withStore(async (store) => {
    const { id } = archivePreview(store);
    store.decideAction(id, "approve");
    const bad = [
      { ...closedResult(), mutation: "none" },
      { ...closedResult(), mutation: "unknown" },
      { ...closedResult(), mutation: "created" },
      { ...closedResult(), mutation: "moved" },
      { ...closedResult(), mutation: "bogus" },
      { ...closedResult(), captureId: null }, // a close always follows a saved capture
      { ...closedResult(), captureId: 0 },
      { ...closedResult(), captureId: "1" },
      { ...closedResult(), captureId: 1.5 },
      { ...closedResult(), tabId: null },
      { ...closedResult(), windowId: null },
      { ...closedResult(), observed: {} }, // an archive records no observed state
      { state: "partial", mutation: "closed", code: "x", captureId: 3 },
      { state: "partial", mutation: "unknown", code: "x", captureId: 3 },
      { state: "partial", mutation: "none", captureId: 3 }, // needs a code
      { state: "partial", mutation: "none", code: "x" }, // needs the saved capture's id
      { state: "partial", mutation: "none", code: "x", captureId: 3, tabId: 5 }, // the tab stays open: no closed-tab handles
      { state: "stale", mutation: "closed", code: "x" },
      { state: "stale", mutation: "unknown", code: "x" },
      { state: "stale", mutation: "none", code: "x", captureId: 3 }, // stale means nothing was saved
      { state: "stale", mutation: "none", code: "x", tabId: 5 },
      { state: "failed", mutation: "closed", code: "x", captureId: 3 },
      { state: "failed", mutation: "none", code: "x", captureId: 3 }, // none means no capture was saved
      { state: "failed", mutation: "unknown", code: "x", windowId: 2 },
      { state: "failed", mutation: "unknown", code: "x".repeat(201) },
      { state: "failed", mutation: "unknown", code: "x", detail: "d".repeat(501) },
      { state: "failed", mutation: "none" }, // needs a code
    ];
    for (const input of bad) {
      assert.throws(() => store.recordActionResult(id, input), (e) => e.code === "validation_error", JSON.stringify(input).slice(0, 90));
    }
    assert.equal(store.listActions({ id }).items[0].state, "approved", "no invalid result changed the action");
    assert.equal(store.listActionAudit({ actionId: id }).items.length, 2, "and none was audited");
  });
});

test("the other kinds refuse the new mutation and an archive result shape", async () => {
  await withStore(async (store) => {
    const tab = store.createAction({ url: URL_ONE, browserSessionId: SESSION_ID });
    store.decideAction(tab.id, "approve");
    assert.throws(() => store.recordActionResult(tab.id, { state: "failed", mutation: "closed", code: "x" }), (e) => e.code === "validation_error");
    assert.throws(() => store.recordActionResult(tab.id, closedResult()), (e) => e.code === "validation_error");
    assert.equal(store.recordActionResult(tab.id, { state: "failed", mutation: "none", code: "x" }).state, "failed");
    assert.equal(store.listActions({ id: tab.id }).items[0].result.captureId, undefined, "only an archive's result carries a capture id");
  });
});

// ---------------------------------------------------------------------------
// Store: audit, clear, reconciliation, bounds
// ---------------------------------------------------------------------------

test("the audit log records an archive's events from server enums only — no title, address, handle, session, capture id, or error text", async () => {
  await withStore(async (store) => {
    const a = archivePreview(store, { ...BINDING, url: "https://secret.example/private", title: "SECRET-TITLE" });
    store.decideAction(a.id, "approve");
    store.recordActionResult(a.id, closedResult({ captureId: 4242 }));
    const b = archivePreview(store);
    store.decideAction(b.id, "approve");
    store.recordActionResult(b.id, { state: "partial", mutation: "none", code: "SECRET-CODE", detail: "SECRET-DETAIL", captureId: 4343 });
    const c = archivePreview(store);
    store.decideAction(c.id, "reject");

    const events = store.listActionAudit({ limit: 200 }).items;
    assert.deepEqual(events.filter((e) => e.actionId === a.id).map((e) => [e.event, e.detail]).reverse(), [
      ["preview", { kind: "archive_tab" }],
      ["approve", { decision: "approve" }],
      ["result", { state: "executed", mutation: "closed" }],
    ]);
    assert.deepEqual(events.find((e) => e.actionId === b.id && e.event === "result").detail, { state: "partial", mutation: "none" });
    assertAuditContentFree(events);
    const text = JSON.stringify(events);
    for (const secret of ["SECRET", "secret", "example.com", "A page", "4242", "4343", SESSION_ID]) {
      assert.ok(!text.includes(secret), `the audit log must not contain ${secret}`);
    }
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["actionId", "detail", "event", "id", "occurredAt"]);
  });
});

test("store.clear removes archive action records and captures but never the audit log; ids are not reused", async () => {
  await withStore(async (store) => {
    const read = { ...captureOk(5, 2), url: "https://secret.example/private", title: "RETAINED-TITLE" };
    const capture = store.createCapture(read);
    const a = archivePreview(store, { ...BINDING, title: "RETAINED-TITLE" });
    store.decideAction(a.id, "approve");
    store.recordActionResult(a.id, closedResult({ captureId: capture.id }));
    const auditBefore = store.listActionAudit().items;
    const cleared = store.clearAll();
    assert.equal(cleared.deletedCounts.actions, 1);
    assert.equal(cleared.deletedCounts.captures, 1);
    assert.equal(store.listActions().total, 0);
    assert.equal(store.listCaptures({}).total, 0);
    assert.deepEqual(store.listActionAudit().items, auditBefore);
    assert.equal(archivePreview(store).id, a.id + 1);
  });
});

test("store.clear is refused while an archive is approved and awaiting its result", async () => {
  await withStore(async (store) => {
    const a = archivePreview(store);
    store.decideAction(a.id, "approve");
    assert.throws(() => store.clearAll(), (e) => e.code === "conflict");
    store.recordActionResult(a.id, { state: "failed", mutation: "unknown", code: "x", captureId: null });
    assert.doesNotThrow(() => store.clearAll());
  });
});

test("reconcileInterruptedActions fails an archive found approved, with an unknown outcome — the capture may have been saved and the tab may or may not have closed", async () => {
  await withTempDir(async (dataDir) => {
    let store = await openStore({ dataDir });
    const archive = archivePreview(store);
    store.decideAction(archive.id, "approve");
    store.close();

    store = await openStore({ dataDir });
    try {
      assert.deepEqual(store.reconcileInterruptedActions(), { reconciledCount: 1 });
      const action = store.listActions({ id: archive.id }).items[0];
      assert.equal(action.state, "failed");
      assert.deepEqual(action.result, {
        mutation: "unknown",
        code: "interrupted_by_restart",
        detail: ACTION_INTERRUPTED_DETAIL,
        captureId: null,
        tabId: null,
        windowId: null,
        observed: null,
      });
      assert.deepEqual(store.listActionAudit({ actionId: archive.id }).items[0].detail, { state: "failed", mutation: "unknown" });
    } finally {
      store.close();
    }
  });
});

test("archive previews share the pending bound with the other kinds", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < MAX_PENDING_ACTIONS - 1; i += 1) store.createAction({ url: `https://example.com/${i}`, browserSessionId: SESSION_ID });
    assert.doesNotThrow(() => archivePreview(store));
    assert.throws(() => archivePreview(store), (e) => e.code === "limit_reached");
  });
});

// ---------------------------------------------------------------------------
// Store: migration v6 (rebuilds `actions` again, keeping rows, ids, and audit)
// ---------------------------------------------------------------------------

test("migration v6 keeps every earlier action kind with its binding and result, continues the id counter, and leaves the audit log untouched", async () => {
  await withTempDir(async (dataDir) => {
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const raw = new DatabaseSync(dbPath);
    try {
      runMigrations(raw, dbPath, () => {}, MIGRATIONS.slice(0, 5));
      raw.exec("INSERT INTO actions (kind, url, browser_session_id, state, previewed_at) VALUES ('open_tab', 'https://example.com/a', 's', 'previewed', 10)");
      const insertBound = raw.prepare("INSERT INTO actions (kind, binding, browser_session_id, state, previewed_at, decided_at, completed_at, result) VALUES (?, ?, 's', 'executed', 10, 11, 12, ?)");
      insertBound.run("configure_group", JSON.stringify({ operation: "create", tabId: 5, windowId: 2, title: "x", color: null }), JSON.stringify({ mutation: "created", code: null, detail: null, tabId: 5, groupId: 9, windowId: 2, observed: null }));
      insertBound.run(
        "move_tabs",
        JSON.stringify({ destination: "new", windowId: 2, tabs: [{ tabId: 5, groupId: -1 }], title: null, color: null }),
        JSON.stringify({ mutation: "moved", code: null, detail: null, groupId: 20, tabIds: [5], windowId: 2, observed: null }),
      );
      raw.exec("INSERT INTO actions (kind, url, browser_session_id, state, previewed_at) VALUES ('open_tab', 'https://example.com/c', 's', 'previewed', 10)");
      raw.exec("DELETE FROM actions WHERE id = 4"); // the counter is now ahead of the highest remaining id
      raw.exec("INSERT INTO action_audit (action_id, event, occurred_at, detail) VALUES (4, 'preview', 10, '{\"kind\":\"open_tab\"}')");
      assert.equal(raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 5);
    } finally {
      raw.close();
    }

    const store = await openStore({ dataDir });
    try {
      const items = store.listActions().items;
      assert.deepEqual(items.map((a) => [a.id, a.kind, a.url, a.state]), [
        [3, "move_tabs", null, "executed"],
        [2, "configure_group", null, "executed"],
        [1, "open_tab", "https://example.com/a", "previewed"],
      ]);
      assert.deepEqual(items[0].binding.tabs, [{ tabId: 5, groupId: -1 }]);
      assert.deepEqual(items[0].result.tabIds, [5]);
      assert.equal(items[1].result.groupId, 9);
      assert.equal(archivePreview(store).id, 5, "ids already used (and named by the audit log) are not reused");
      assert.equal(store.listActionAudit({ actionId: 4 }).total, 1);
    } finally {
      store.close();
    }
    const after = new DatabaseSync(dbPath);
    try {
      assert.equal(after.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 6);
      assert.throws(() => after.exec("UPDATE actions SET url = 'https://evil.example/' WHERE id = 1"), /immutable/, "the triggers were recreated");
      assert.throws(() => after.exec("UPDATE actions SET state = 'approved' WHERE id = 2"), /terminal/);
      assert.throws(() => after.exec("DELETE FROM action_audit"), /append-only/, "the audit triggers are untouched");
    } finally {
      after.close();
    }
  });
});

test("migration v6 on a database whose actions were all cleared still keeps the id counter", async () => {
  await withTempDir(async (dataDir) => {
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const raw = new DatabaseSync(dbPath);
    try {
      runMigrations(raw, dbPath, () => {}, MIGRATIONS.slice(0, 5));
      for (let i = 0; i < 3; i += 1) raw.exec("INSERT INTO actions (kind, url, browser_session_id, state, previewed_at) VALUES ('open_tab', 'https://example.com/', 's', 'previewed', 0)");
      raw.exec("DELETE FROM actions");
    } finally {
      raw.close();
    }
    const store = await openStore({ dataDir });
    try {
      assert.equal(archivePreview(store).id, 4);
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP: helpers
// ---------------------------------------------------------------------------

function httpRequest({ port, path, method = "GET", token, body, rawBody, extraHeaders = {} }) {
  const headers = { "x-protocol-version": String(PROTOCOL_VERSION), ...extraHeaders };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const payload = rawBody !== undefined ? rawBody : body === undefined ? undefined : JSON.stringify(body);
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

function nextMessage(ws) {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

async function openAuthenticatedExtension(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: EXTENSION_ORIGIN });
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ type: "auth", protocolVersion: PROTOCOL_VERSION, token: OWNER_TOKEN }));
  assert.equal((await reply).type, "auth_ok");
  return ws;
}

async function waitFor(predicate, { timeoutMs = 5000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function envelope(sourceOperation, status = "ok", browserSessionId = SESSION_ID) {
  return { schemaVersion: RESULT_SCHEMA_VERSION, browserSessionId, sourceOperation, capturedAt: Date.now(), status };
}

// A well-formed browser.read_tab "ok" result for tab `tabId` in window `windowId`.
function captureOk(tabId, windowId, overrides = {}) {
  return {
    ...envelope("browser.read_tab"),
    tabId,
    windowId,
    url: URL_ONE,
    title: "A page",
    documentReadyState: "complete",
    text: "Hello archived world",
    characterCount: 20,
    returnedCharacterCount: 20,
    truncated: false,
    ...overrides,
  };
}

const inspectResult = (params, overrides = {}) => ({
  ...envelope("browser.inspect_archive_target"),
  tab: { tabId: params.tabId, windowId: 2, groupId: -1, pinned: false, title: "A page", url: URL_ONE },
  ...overrides,
});
const readResult = (params, overrides = {}) => captureOk(params.tabId, 2, overrides);
const closeResult = (params, overrides = {}) => ({ ...envelope("browser.close_tab"), changed: true, tabId: params.tabId, windowId: params.windowId, ...overrides });
const protectedRead = (params) => ({ ...envelope("browser.read_tab", "unsupported"), tabId: params.tabId, windowId: 2, code: "injection_rejected", detail: "Cannot access contents of the page" });
const loadingRead = (params) => ({ ...envelope("browser.read_tab", "not_ready"), tabId: params.tabId, windowId: 2, code: "tab_loading" });
const refusal = (code, extra = {}) => ({ ...envelope("browser.close_tab", "error"), code, changed: false, ...extra });
const unknownClose = (extra = {}) => ({ ...envelope("browser.close_tab", "error"), code: "close_failed", detail: "Tabs cannot be edited right now", changed: null, ...extra });

const NO_RESPONSE = Symbol("no response");

function installExtensionFake(ws, { inspect = inspectResult, read = readResult, close = closeResult, delayMs = 0 } = {}) {
  ws.requests = [];
  ws.on("message", async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") return;
    ws.requests.push({ method: message.method, params: message.params });
    let result;
    if (message.method === "browser.inspect_archive_target") {
      result = await inspect(message.params, ws);
    } else if (message.method === "browser.read_tab") {
      result = await read(message.params, ws);
    } else if (message.method === "browser.close_tab") {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await close(message.params, ws);
    } else {
      result = { ...envelope(message.method, "error"), code: "unsupported_in_test_fake" };
    }
    if (result === NO_RESPONSE) return;
    ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result }));
  });
}

const requestsOf = (ws, method) => ws.requests.filter((r) => r.method === method);
const closeRequests = (ws) => requestsOf(ws, "browser.close_tab");
const readRequests = (ws) => requestsOf(ws, "browser.read_tab");

async function withArchiveService(run, { extension = {}, connectExtension = true, ...serviceOptions } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-archive-http-"));
  const store = await openStore({ dataDir });
  const service = createService({
    credentialToken: OWNER_TOKEN,
    agentCredentialToken: AGENT_TOKEN,
    store,
    rateLimitMaxRequests: 10_000,
    ...serviceOptions,
  });
  const { port } = await service.listen();
  let ws = null;
  if (connectExtension) {
    ws = await openAuthenticatedExtension(port);
    installExtensionFake(ws, extension);
  }
  const owner = (path, options = {}) => httpRequest({ port, path, token: OWNER_TOKEN, ...options });
  const helpers = {
    port,
    store,
    owner,
    get ws() {
      return ws;
    },
    async preview(body = { tabId: 5 }) {
      const response = await owner("/api/action.archive_tab.preview", { method: "POST", body });
      assert.equal(response.status, 200, JSON.stringify(response.json));
      return response.json.result;
    },
    decide: (operation, id) => owner(`/api/action.archive_tab.${operation}?id=${id}`, { method: "POST" }),
  };
  try {
    await run(helpers);
  } finally {
    ws?.close();
    await service.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

// Asserts an approval that must end before anything was saved or closed.
async function assertNothingSavedOrClosed({ decide, ws, store, owner }, id, { state, code }) {
  const response = await decide("approve", id);
  assert.equal(response.status, 200, JSON.stringify(response.json));
  assert.equal(response.json.result.state, state, JSON.stringify(response.json.result));
  assert.equal(response.json.result.result.mutation, "none");
  if (code !== undefined) assert.equal(response.json.result.result.code, code);
  assert.equal(response.json.result.result.captureId, null);
  assert.equal(store.listCaptures({}).total, 0, "no capture was saved");
  assert.equal(closeRequests(ws).length, 0, "and no close was ever sent");
  const audit = (await owner(`/api/store.actions.audit.list?actionId=${id}`)).json.result.items;
  assert.deepEqual(audit[0].detail, { state, mutation: "none" });
  return response.json.result;
}

// ---------------------------------------------------------------------------
// HTTP: preview
// ---------------------------------------------------------------------------

test("preview binds the exact tab, window, address, group, pinned state, title, and the extension's own session — and saves nothing and closes nothing", async () => {
  await withArchiveService(async ({ preview, ws, owner, store }) => {
    const action = await preview({ tabId: 5 });
    assert.equal(action.id, 1);
    assert.equal(action.kind, "archive_tab");
    assert.equal(action.state, "previewed");
    assert.equal(action.url, null);
    assert.equal(action.browserSessionId, SESSION_ID, "the session is the extension's own");
    assert.deepEqual(action.binding, BINDING);
    assert.deepEqual(ws.requests, [{ method: "browser.inspect_archive_target", params: { tabId: 5 } }], "one read-only look; no read_tab, no close");
    assert.equal(store.listCaptures({}).total, 0, "a preview saves no capture");
    assert.deepEqual((await owner("/api/store.actions.list")).json.result.items, [action]);
  });
});

test("preview binds a pinned or grouped tab as it is, and keeps a null title as null", async () => {
  await withArchiveService(
    async ({ preview }) => {
      const action = await preview({ tabId: 6 });
      assert.deepEqual([action.binding.groupId, action.binding.pinned, action.binding.title], [9, true, null]);
    },
    { extension: { inspect: (p) => inspectResult(p, { tab: { tabId: p.tabId, windowId: 2, groupId: 9, pinned: true, title: null, url: URL_ONE } }) } },
  );
});

test("preview accepts exactly {tabId} and contacts the extension for nothing else", async () => {
  await withArchiveService(async ({ owner, ws, store }) => {
    const bodies = [
      { rawBody: "" },
      { rawBody: "not json" },
      { rawBody: "[]" },
      { rawBody: "null" },
      { body: {} },
      { body: { tabId: -1 } },
      { body: { tabId: "5" } },
      { body: { tabId: 1.5 } },
      { body: { tabId: null } },
      { body: { tabId: [5] } },
      { body: { tabId: 5, tabIds: [5] } },
      { body: { tabId: 5, browserSessionId: SESSION_ID } },
      { body: { tabId: 5, windowId: 2 } },
      { body: { tabId: 5, url: URL_ONE } },
      { body: { tabId: 5, groupId: -1 } },
      { body: { tabId: 5, pinned: false } },
      { body: { tabId: 5, extra: 1 } },
    ];
    for (const input of bodies) {
      const response = await owner("/api/action.archive_tab.preview", { method: "POST", ...input });
      assert.equal(response.status, 400, `${JSON.stringify(input).slice(0, 90)} -> ${response.status} ${JSON.stringify(response.json)}`);
      assert.match(response.json.error.code, /^(validation_error|malformed_body)$/);
    }
    assert.equal(ws.requests.length, 0, "an invalid preview never reaches the extension");
    assert.equal(store.listActions().total, 0);
    assert.equal(store.listActionAudit().total, 0);
  });
});

test("preview refuses an oversized body as 413", async () => {
  await withArchiveService(async ({ owner, ws }) => {
    const response = await owner("/api/action.archive_tab.preview", { method: "POST", rawBody: JSON.stringify({ tabId: 5, pad: "p".repeat(40_000) }) });
    assert.equal(response.status, 413);
    assert.equal(ws.requests.length, 0);
  });
});

test("preview refuses, as a conflict storing nothing, a tab with no address yet or one too long to bind whole", async () => {
  for (const [name, url, pattern] of [
    ["no address", null, /no address yet/],
    ["an empty address", "", /no address yet/],
    ["an address over the bound", `https://example.com/${"a".repeat(MAX_ARCHIVE_URL_LENGTH)}`, /cannot be bound exactly/],
  ]) {
    await withArchiveService(
      async ({ owner, store }) => {
        const response = await owner("/api/action.archive_tab.preview", { method: "POST", body: { tabId: 5 } });
        assert.equal(response.status, 409, `${name}: ${JSON.stringify(response.json)}`);
        assert.equal(response.json.error.code, "conflict");
        assert.match(response.json.error.detail, pattern);
        assert.equal(store.listActions().total, 0);
        assert.equal(store.listActionAudit().total, 0);
      },
      { extension: { inspect: (p) => inspectResult(p, { tab: { tabId: p.tabId, windowId: 2, groupId: -1, pinned: false, title: "t", url } }) } },
    );
  }
});

test("preview binds an address of exactly the maximum length", async () => {
  const url = `https://example.com/${"a".repeat(MAX_ARCHIVE_URL_LENGTH - "https://example.com/".length)}`;
  await withArchiveService(
    async ({ preview }) => {
      assert.equal((await preview({ tabId: 5 })).binding.url, url);
    },
    { extension: { inspect: (p) => inspectResult(p, { tab: { tabId: p.tabId, windowId: 2, groupId: -1, pinned: false, title: "t", url } }) } },
  );
});

test("preview reports a missing tab as stale_handle (409) and a browser that cannot close tabs as unsupported_feature (501), storing nothing", async () => {
  const cases = [
    ["stale_handle", 409, { ...envelope("browser.inspect_archive_target", "error"), code: "stale_handle" }],
    ["unsupported_feature", 501, { ...envelope("browser.inspect_archive_target", "unsupported"), code: "unsupported_feature" }],
  ];
  for (const [code, status, answer] of cases) {
    await withArchiveService(
      async ({ owner, store }) => {
        const response = await owner("/api/action.archive_tab.preview", { method: "POST", body: { tabId: 5 } });
        assert.equal(response.status, status, JSON.stringify(response.json));
        assert.equal(response.json.error.code, code);
        assert.equal(store.listActions().total, 0);
      },
      { extension: { inspect: () => answer } },
    );
  }
});

test("preview rejects an inspect answer that is malformed, for another tab, or an unexpected error", async () => {
  const answers = {
    garbage: () => ({ garbage: true }),
    "a legacy-shaped array": () => [],
    "no tab": (p) => inspectResult(p, { tab: undefined }),
    "a tab omitting pinned": (p) => inspectResult(p, { tab: { tabId: p.tabId, windowId: 2, groupId: -1, title: "t", url: URL_ONE } }),
    "a tab with an invalid group id": (p) => inspectResult(p, { tab: { tabId: p.tabId, windowId: 2, groupId: -2, pinned: false, title: "t", url: URL_ONE } }),
    "a different tab": () => inspectResult({ tabId: 6 }),
    "an unexpected error code": () => ({ ...envelope("browser.inspect_archive_target", "error"), code: "internal_error" }),
    "a result for the wrong method": (p) => inspectResult(p, { sourceOperation: "browser.list_tabs" }),
  };
  for (const [name, inspect] of Object.entries(answers)) {
    await withArchiveService(
      async ({ owner, store }) => {
        const response = await owner("/api/action.archive_tab.preview", { method: "POST", body: { tabId: 5 } });
        assert.equal(response.status, 502, `${name}: ${JSON.stringify(response.json)}`);
        assert.equal(response.json.error.code, "invalid_extension_response");
        assert.equal(store.listActions().total, 0, name);
      },
      { extension: { inspect } },
    );
  }
});

test("preview fails explicitly as disconnected when no extension is connected, storing nothing", async () => {
  await withArchiveService(
    async ({ owner, store }) => {
      const response = await owner("/api/action.archive_tab.preview", { method: "POST", body: { tabId: 5 } });
      assert.equal(response.status, 503);
      assert.equal(response.json.error.code, "disconnected");
      assert.equal(store.listActions().total, 0);
    },
    { connectExtension: false },
  );
});

test("preview is refused with limit_reached once too many previews await a decision", async () => {
  await withArchiveService(async ({ preview, owner }) => {
    for (let i = 0; i < MAX_PENDING_ACTIONS; i += 1) await preview({ tabId: 5 });
    const response = await owner("/api/action.archive_tab.preview", { method: "POST", body: { tabId: 5 } });
    assert.equal(response.status, 409);
    assert.equal(response.json.error.code, "limit_reached");
  });
});

// ---------------------------------------------------------------------------
// HTTP: authorization — the owner alone, and no direct mutation route
// ---------------------------------------------------------------------------

test("every archive action route rejects a missing or wrong credential, and the external-agent credential with 403, reaching nothing", async () => {
  await withArchiveService(async ({ port, preview, ws, store }) => {
    const action = await preview();
    const requestsBefore = ws.requests.length;
    const routes = [
      { method: "POST", path: "/api/action.archive_tab.preview", body: { tabId: 5 } },
      { method: "POST", path: `/api/action.archive_tab.approve?id=${action.id}` },
      { method: "POST", path: `/api/action.archive_tab.reject?id=${action.id}` },
    ];
    for (const route of routes) {
      const none = await httpRequest({ port, ...route });
      assert.equal(none.status, 401, route.path);
      assert.equal(none.json.error.code, "missing_credential");
      const wrong = await httpRequest({ port, token: "wrong", ...route });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.json.error.code, "invalid_credential");
      const agent = await httpRequest({ port, token: AGENT_TOKEN, ...route });
      assert.equal(agent.status, 403, `${route.path}: ${JSON.stringify(agent.json)}`);
      assert.equal(agent.json.error.code, "forbidden_scope");
    }
    assert.equal(ws.requests.length, requestsBefore, "a refused request never reaches the extension");
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed", "and decides nothing");
    assert.equal(store.listCaptures({}).total, 0);
  });
});

test("browser.close_tab and browser.inspect_archive_target have no HTTP route at all, for either credential, as a GET or a POST", async () => {
  await withArchiveService(async ({ port, ws, store }) => {
    for (const token of [OWNER_TOKEN, AGENT_TOKEN]) {
      for (const method of ["GET", "POST"]) {
        for (const path of [
          `/api/browser.close_tab?tabId=5&browserSessionId=${SESSION_ID}`,
          "/api/browser.inspect_archive_target?tabId=5",
          "/api/browser.remove_tab?tabId=5",
          "/api/browser.archive_tab?tabId=5",
          "/api/action.archive_tab",
          "/api/action.archive_tab.execute?id=1",
          "/api/action.archive_tab.close?id=1",
          "/api/workflow.archive_tab",
          "/api/action.close_tab.preview",
        ]) {
          const response = await httpRequest({ port, path, method, token, body: method === "POST" ? { tabId: 5 } : undefined });
          assert.equal(response.status, 404, `${method} ${path} as ${token === OWNER_TOKEN ? "owner" : "agent"} -> ${response.status}`);
        }
      }
    }
    assert.equal(ws.requests.length, 0);
    assert.equal(store.listCaptures({}).total, 0);
  });
});

test("the archive action routes accept only POST", async () => {
  await withArchiveService(async ({ owner, preview, store }) => {
    const action = await preview();
    for (const method of ["GET", "PATCH", "DELETE", "PUT"]) {
      for (const path of ["preview", `approve?id=${action.id}`, `reject?id=${action.id}`]) {
        assert.equal((await owner(`/api/action.archive_tab.${path}`, { method })).status, 405, `${method} ${path}`);
      }
    }
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed");
  });
});

test("a request using the previous protocol version (5) is rejected before any archive route runs, and so is an extension speaking it", async () => {
  await withArchiveService(async ({ port, ws }) => {
    const response = await httpRequest({
      port,
      method: "POST",
      path: "/api/action.archive_tab.preview",
      token: OWNER_TOKEN,
      body: { tabId: 5 },
      extraHeaders: { "x-protocol-version": "5" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "unsupported_protocol_version");
    assert.equal(ws.requests.length, 0);

    const old = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: EXTENSION_ORIGIN });
    await new Promise((resolve, reject) => {
      old.on("open", resolve);
      old.on("error", reject);
    });
    const reply = nextMessage(old);
    old.send(JSON.stringify({ type: "auth", protocolVersion: 5, token: OWNER_TOKEN }));
    const message = await reply;
    assert.equal(message.type, "auth_error");
    assert.equal(message.code, "unsupported_protocol_version");
    old.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP: approve — capture first, then close
// ---------------------------------------------------------------------------

test("approving an archive reads the tab afresh, saves exactly one capture, and only then sends one close built from the stored binding", async () => {
  const seen = {};
  await withArchiveService(
    async ({ preview, decide, ws, owner, store }) => {
      seen.store = store;
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const done = response.json.result;
      assert.equal(done.id, action.id);
      assert.equal(done.state, "executed");
      assert.deepEqual(done.binding, action.binding);
      assert.ok(done.decidedAt >= done.previewedAt && done.completedAt >= done.decidedAt);

      const captures = store.listCaptures({});
      assert.equal(captures.total, 1, "exactly one capture");
      assert.equal(captures.items[0].status, "ok");
      assert.equal(captures.items[0].url, URL_ONE);
      assert.equal(store.readCapture({ id: captures.items[0].id }).chunk, "Hello archived world");
      assert.deepEqual(done.result, { mutation: "closed", code: null, detail: null, captureId: captures.items[0].id, tabId: 5, windowId: 2, observed: null });

      assert.deepEqual(
        ws.requests.map((r) => r.method),
        ["browser.inspect_archive_target", "browser.read_tab", "browser.inspect_archive_target", "browser.close_tab"],
        "preview inspection, a fresh read, a fresh inspection (the last check before the capture is saved), then the close",
      );
      assert.deepEqual(readRequests(ws)[0].params, { tabId: 5, browserSessionId: SESSION_ID });
      assert.deepEqual(requestsOf(ws, "browser.inspect_archive_target")[1].params, { tabId: 5 }, "the final check names only the tab");
      assert.deepEqual(closeRequests(ws)[0].params, { browserSessionId: SESSION_ID, tabId: 5, windowId: 2, url: URL_ONE, groupId: -1, pinned: false }, "built from the stored binding; no title");
      assert.equal(seen.capturesWhenCloseArrived, 1, "the capture was already durable when the close was sent");

      const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
      assert.deepEqual(audit.map((e) => e.event), ["result", "approve", "preview"]);
      assert.deepEqual(audit[0].detail, { state: "executed", mutation: "closed" });
    },
    {
      extension: {
        close: (params) => {
          seen.capturesWhenCloseArrived = seen.store.listCaptures({}).total;
          return closeResult(params);
        },
      },
    },
  );
});

test("a protected or still-loading page is archived as exactly that outcome: a saved capture with no page text, then the close", async () => {
  const cases = [
    ["a protected page", protectedRead, "unsupported", "injection_rejected"],
    ["a tab still loading", loadingRead, "not_ready", "tab_loading"],
    ["a read that failed with the tab's handles", (p) => ({ ...envelope("browser.read_tab", "error"), tabId: p.tabId, windowId: 2, code: "invalid_extension_response", detail: "unexpected shape" }), "error", "invalid_extension_response"],
  ];
  for (const [name, read, status, code] of cases) {
    await withArchiveService(
      async ({ preview, decide, ws, store }) => {
        const action = await preview();
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "executed", `${name}: ${JSON.stringify(response.json.result)}`);
        assert.equal(response.json.result.result.mutation, "closed");
        const [capture] = store.listCaptures({}).items;
        assert.equal(store.listCaptures({}).total, 1, name);
        assert.equal(capture.status, status);
        assert.equal(capture.code, code);
        assert.equal(capture.id, response.json.result.result.captureId);
        assert.equal(capture.url, null, "no page content is invented for a non-ok capture");
        assert.equal(capture.textLength, null);
        assert.equal(store.readCapture({ id: capture.id }).chunk, "");
        assert.equal(closeRequests(ws).length, 1, name);
      },
      { extension: { read } },
    );
  }
});

test("a decided archive can never be decided or executed again", async () => {
  await withArchiveService(async ({ preview, decide, ws, store }) => {
    const action = await preview();
    assert.equal((await decide("approve", action.id)).status, 200);
    for (const operation of ["approve", "reject", "approve"]) {
      const again = await decide(operation, action.id);
      assert.equal(again.status, 409, operation);
      assert.equal(again.json.error.code, "conflict");
    }
    assert.equal(closeRequests(ws).length, 1, "no duplicate close");
    assert.equal(readRequests(ws).length, 1);
    assert.equal(store.listCaptures({}).total, 1, "no duplicate capture");
  });
});

test("approve and reject take the action id alone: no body, no other parameter, a valid id", async () => {
  await withArchiveService(async ({ owner, preview, ws, store }) => {
    const action = await preview();
    for (const operation of ["approve", "reject"]) {
      const attempts = [
        { path: `/api/action.archive_tab.${operation}?id=${action.id}`, body: { tabId: 6 } },
        { path: `/api/action.archive_tab.${operation}?id=${action.id}`, rawBody: "{}" },
        { path: `/api/action.archive_tab.${operation}?id=${action.id}&tabId=6` },
        { path: `/api/action.archive_tab.${operation}?id=${action.id}&url=${encodeURIComponent("https://evil.example/")}` },
        { path: `/api/action.archive_tab.${operation}?id=${action.id}&browserSessionId=other` },
        { path: `/api/action.archive_tab.${operation}` },
        { path: `/api/action.archive_tab.${operation}?id=` },
        { path: `/api/action.archive_tab.${operation}?id=0` },
        { path: `/api/action.archive_tab.${operation}?id=-1` },
        { path: `/api/action.archive_tab.${operation}?id=abc` },
        { path: `/api/action.archive_tab.${operation}?tabId=5` },
      ];
      for (const { path, ...input } of attempts) {
        const response = await owner(path, { method: "POST", ...input });
        assert.equal(response.status, 400, `${operation} ${path} ${JSON.stringify(input)} -> ${response.status}`);
        assert.equal(response.json.error.code, "validation_error");
      }
    }
    assert.equal(closeRequests(ws).length + readRequests(ws).length, 0);
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed", "none of the refused requests decided anything");
    assert.equal(store.listCaptures({}).total, 0);
  });
});

test("approve and reject of an unknown action id are 404 and change nothing", async () => {
  await withArchiveService(async ({ decide, ws, store }) => {
    for (const operation of ["approve", "reject"]) {
      const response = await decide(operation, 12345);
      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, "not_found");
    }
    assert.equal(ws.requests.length, 0);
    assert.equal(store.listCaptures({}).total, 0);
  });
});

test("each route decides only its own kind: another kind's action id on the archive route (and the reverse) is a 404 that decides nothing", async () => {
  await withArchiveService(async ({ preview, decide, owner, ws, store }) => {
    const archive = await preview();
    const tab = store.createAction({ url: URL_ONE, browserSessionId: SESSION_ID });
    const move = store.createAction({
      kind: "move_tabs",
      browserSessionId: SESSION_ID,
      binding: { destination: "new", windowId: 2, tabs: [{ tabId: 5, groupId: -1 }], title: null, color: null },
    });
    for (const operation of ["approve", "reject"]) {
      assert.equal((await decide(operation, tab.id)).status, 404, `archive ${operation} of a tab action`);
      assert.equal((await decide(operation, move.id)).status, 404, `archive ${operation} of a move action`);
      assert.equal((await owner(`/api/action.open_tab.${operation}?id=${archive.id}`, { method: "POST" })).status, 404);
      assert.equal((await owner(`/api/action.move_tabs.${operation}?id=${archive.id}`, { method: "POST" })).status, 404);
    }
    for (const action of [archive, tab, move]) assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed");
    assert.equal(ws.requests.filter((r) => r.method !== "browser.inspect_archive_target").length, 0, "nothing was read, saved, or closed");
    assert.equal(store.listCaptures({}).total, 0);
  });
});

test("reject records the decision and neither saves a capture nor closes anything, and a rejected preview cannot then be approved", async () => {
  await withArchiveService(async ({ preview, decide, ws, owner, store }) => {
    const action = await preview();
    const response = await decide("reject", action.id);
    assert.equal(response.status, 200);
    assert.equal(response.json.result.state, "rejected");
    assert.equal(response.json.result.result, null);
    assert.equal((await decide("approve", action.id)).status, 409);
    assert.equal(ws.requests.filter((r) => r.method !== "browser.inspect_archive_target").length, 0, "no read and no close");
    assert.equal(store.listCaptures({}).total, 0);
    const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
    assert.deepEqual(audit.map((e) => e.event), ["reject", "preview"]);
  });
});

test("approve while the extension is disconnected is refused without consuming the preview", async () => {
  await withArchiveService(async ({ preview, decide, ws, store, port }) => {
    const action = await preview();
    ws.close();
    await waitFor(async () => (await httpRequest({ port, path: "/health" })).json.extension.connected === false, { what: "extension disconnect" });
    const refused = await decide("approve", action.id);
    assert.equal(refused.status, 503);
    assert.equal(refused.json.error.code, "disconnected");
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed", "the preview is still awaiting a decision");
    assert.equal(store.listCaptures({}).total, 0);
  });
});

// ---------------------------------------------------------------------------
// HTTP: refused or failed before the capture — nothing saved, nothing closed
// ---------------------------------------------------------------------------

test("a stale session or a tab that no longer exists, found when reading it, is a 'stale' outcome: no capture and no close", async () => {
  for (const code of ["stale_session", "stale_handle"]) {
    await withArchiveService(
      async (service) => {
        const action = await service.preview();
        await assertNothingSavedOrClosed(service, action.id, { state: "stale", code });
      },
      { extension: { read: () => ({ ...envelope("browser.read_tab", "error", "a-newer-session"), code }) } },
    );
  }
});

test("a tab that moved window, or whose readable page is at another address, since the preview is stale: no capture and no close", async () => {
  const cases = {
    "moved window": (p) => readResult(p, { windowId: 4 }),
    "a protected page that moved window": (p) => ({ ...protectedRead(p), windowId: 4 }),
    "navigated to another address": (p) => readResult(p, { url: "https://example.com/elsewhere" }),
    "the same address plus a fragment": (p) => readResult(p, { url: `${URL_ONE}#section` }),
  };
  for (const [name, read] of Object.entries(cases)) {
    await withArchiveService(
      async (service) => {
        const action = await service.preview();
        const result = await assertNothingSavedOrClosed(service, action.id, { state: "stale", code: "state_mismatch" });
        assert.equal(result.state, "stale", name);
      },
      { extension: { read } },
    );
  }
});

test("a failed or unusable read leaves nothing saved and nothing closed (failed, mutation none)", async () => {
  const cases = {
    "an error that names no tab": [() => ({ ...envelope("browser.read_tab", "error"), code: "invalid_params", detail: "tabId must be a non-negative safe integer" }), "invalid_params"],
    "an answer for a different tab": [(p) => readResult({ tabId: p.tabId + 1 }), "invalid_extension_response"],
    "an answer for a different session": [(p) => readResult(p, { browserSessionId: "some-other-session" }), "invalid_extension_response"],
    "a result for the wrong method": [(p) => readResult(p, { sourceOperation: "browser.list_tabs" }), "invalid_extension_response"],
    "garbage": [() => ({ garbage: true }), "invalid_extension_response"],
    "a non-object": [() => "ok", "invalid_extension_response"],
    "an ok result with inconsistent counts": [(p) => readResult(p, { characterCount: 3 }), "invalid_extension_response"],
  };
  for (const [name, [read, code]] of Object.entries(cases)) {
    await withArchiveService(
      async (service) => {
        const action = await service.preview();
        const result = await assertNothingSavedOrClosed(service, action.id, { state: "failed", code });
        assert.equal(result.state, "failed", name);
      },
      { extension: { read } },
    );
  }
});

test("a non-ok read that carries invented page content is not savable: failed, mutation none, no capture, no close", async () => {
  await withArchiveService(
    async (service) => {
      const action = await service.preview();
      const result = await assertNothingSavedOrClosed(service, action.id, { state: "failed", code: "validation_error" });
      assert.match(result.result.detail, /could not be saved/);
    },
    { extension: { read: (p) => ({ ...protectedRead(p), url: URL_ONE, text: "invented" }) } },
  );
});

test("a lost read reply, or a disconnect during the read, leaves nothing saved and nothing closed", async () => {
  await withArchiveService(
    async (service) => {
      const action = await service.preview();
      const result = await assertNothingSavedOrClosed(service, action.id, { state: "failed", code: "request_timeout" });
      assert.match(result.result.detail, /nothing was saved/);
    },
    { requestTimeoutMs: 150, extension: { read: () => NO_RESPONSE } },
  );
  await withArchiveService(
    async (service) => {
      const action = await service.preview();
      await assertNothingSavedOrClosed(service, action.id, { state: "failed", code: "disconnected" });
    },
    {
      extension: {
        read: (_params, ws) => {
          ws.close();
          return NO_RESPONSE;
        },
      },
    },
  );
});

test("when the capture cannot be saved, the close is never sent and the tab stays open", async () => {
  await withArchiveService(async (service) => {
    const { preview, decide, ws, store, owner } = service;
    const action = await preview();
    // The real store, made to refuse the capture's insert at the database.
    const raw = new DatabaseSync(store.dbPath);
    try {
      raw.exec("CREATE TRIGGER fail_capture_insert BEFORE INSERT ON captures BEGIN SELECT RAISE(ABORT, 'SECRET-DETAIL no space'); END;");
    } finally {
      raw.close();
    }
    const result = await decide("approve", action.id);
    assert.equal(result.status, 200, JSON.stringify(result.json));
    assert.equal(result.json.result.state, "failed");
    assert.equal(result.json.result.result.mutation, "none");
    assert.equal(result.json.result.result.captureId, null);
    assert.doesNotMatch(JSON.stringify(result.json), /SECRET-DETAIL/, "database error text is not echoed");
    assert.match(result.json.result.result.detail, /could not be saved, so the tab was not closed/);
    assert.equal(closeRequests(ws).length, 0, "no capture, no close");
    assert.deepEqual((await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items[0].detail, { state: "failed", mutation: "none" });
  });
});

// ---------------------------------------------------------------------------
// HTTP: the final state check, made after the read and before anything is saved
// ---------------------------------------------------------------------------

// The first inspection (the preview) reports the tab as it is; every later one
// (the final check made while approving) is answered by `later`.
const changingInspect = (later) => {
  let calls = 0;
  return (params, ws) => (++calls === 1 ? inspectResult(params) : later(params, ws));
};
const TAB_NOW = { windowId: 2, groupId: -1, pinned: false, title: "A page", url: URL_ONE };
const inspectedAs = (changes) => (p) => inspectResult(p, { tab: { tabId: p.tabId, ...TAB_NOW, ...changes } });

test("a pin, group, address, or window change since the preview, seen by the final check, saves no capture and sends no close — on a readable, a protected, and a loading read alike", async () => {
  const changes = {
    "the tab was pinned": inspectedAs({ pinned: true }),
    "the tab was grouped": inspectedAs({ groupId: 9 }),
    "the address changed": inspectedAs({ url: "https://example.com/elsewhere" }),
    "the address gained a fragment": inspectedAs({ url: `${URL_ONE}#section` }),
    "the address is gone": inspectedAs({ url: null }),
    "the tab moved window": inspectedAs({ windowId: 4 }),
  };
  // Non-ok reads carry no address at all, so only the final check can notice any of this for them.
  const reads = { "a readable page": readResult, "a protected page": protectedRead, "a still-loading tab": loadingRead };
  for (const [changeName, later] of Object.entries(changes)) {
    for (const [readName, read] of Object.entries(reads)) {
      await withArchiveService(
        async (service) => {
          const action = await service.preview();
          const result = await assertNothingSavedOrClosed(service, action.id, { state: "stale", code: "state_mismatch" });
          assert.match(result.result.detail, /nothing was saved/, `${changeName} / ${readName}`);
          assert.deepEqual(
            service.ws.requests.map((r) => r.method),
            ["browser.inspect_archive_target", "browser.read_tab", "browser.inspect_archive_target"],
            `${changeName} / ${readName}: preview, read, final check — and nothing after`,
          );
        },
        { extension: { read, inspect: changingInspect(later) } },
      );
    }
  }
});

test("a final check that finds the tab gone or the session replaced is stale: no capture, no close", async () => {
  await withArchiveService(
    async (service) => {
      const action = await service.preview();
      await assertNothingSavedOrClosed(service, action.id, { state: "stale", code: "stale_handle" });
    },
    { extension: { inspect: changingInspect(() => ({ ...envelope("browser.inspect_archive_target", "error"), code: "stale_handle" })) } },
  );
  await withArchiveService(
    async (service) => {
      const action = await service.preview();
      await assertNothingSavedOrClosed(service, action.id, { state: "stale", code: "stale_session" });
    },
    { extension: { inspect: changingInspect((p) => inspectResult(p, { browserSessionId: "a-newer-session" })) } },
  );
});

test("a final check from a browser that cannot close tabs is failed (mutation none): no capture, no close", async () => {
  await withArchiveService(
    async (service) => {
      const action = await service.preview();
      await assertNothingSavedOrClosed(service, action.id, { state: "failed", code: "unsupported_feature" });
    },
    { extension: { inspect: changingInspect(() => ({ ...envelope("browser.inspect_archive_target", "unsupported"), code: "unsupported_feature" })) } },
  );
});

test("a malformed or unexpected final-check answer is failed (mutation none): no capture, no close", async () => {
  const answers = {
    garbage: () => ({ garbage: true }),
    "a legacy-shaped array": () => [],
    "a non-object": () => "ok",
    "no tab": (p) => inspectResult(p, { tab: undefined }),
    "a tab omitting pinned": (p) => inspectResult(p, { tab: { tabId: p.tabId, windowId: 2, groupId: -1, title: "t", url: URL_ONE } }),
    "a tab with an invalid group id": (p) => inspectResult(p, { tab: { tabId: p.tabId, ...TAB_NOW, groupId: -2 } }),
    "a different tab": () => inspectResult({ tabId: 6 }),
    "a result for the wrong method": (p) => inspectResult(p, { sourceOperation: "browser.list_tabs" }),
    "an unexpected error code": () => ({ ...envelope("browser.inspect_archive_target", "error"), code: "internal_error" }),
  };
  for (const [name, later] of Object.entries(answers)) {
    await withArchiveService(
      async (service) => {
        const action = await service.preview();
        const result = await assertNothingSavedOrClosed(service, action.id, { state: "failed", code: "invalid_extension_response" });
        assert.equal(result.state, "failed", name);
      },
      { extension: { inspect: changingInspect(later) } },
    );
  }
});

test("a lost final-check reply, or a disconnect during it, is failed (mutation none): no capture, no close", async () => {
  await withArchiveService(
    async (service) => {
      const action = await service.preview();
      const result = await assertNothingSavedOrClosed(service, action.id, { state: "failed", code: "request_timeout" });
      assert.match(result.result.detail, /nothing was saved/);
    },
    { requestTimeoutMs: 150, extension: { inspect: changingInspect(() => NO_RESPONSE) } },
  );
  await withArchiveService(
    async (service) => {
      const action = await service.preview();
      await assertNothingSavedOrClosed(service, action.id, { state: "failed", code: "disconnected" });
    },
    {
      extension: {
        inspect: changingInspect((_params, ws) => {
          ws.close();
          return NO_RESPONSE;
        }),
      },
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP: after the capture — it is kept whatever happens to the tab
// ---------------------------------------------------------------------------

test("a close the extension refuses because the tab changed after the capture keeps the capture and leaves the tab open: partial, mutation none, captureId", async () => {
  for (const code of ["state_mismatch", "stale_handle", "stale_session", "unsupported_feature", "invalid_params"]) {
    await withArchiveService(
      async ({ preview, decide, ws, owner, store }) => {
        const action = await preview();
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, code);
        assert.equal(response.json.result.state, "partial", code);
        const [capture] = store.listCaptures({}).items;
        assert.equal(store.listCaptures({}).total, 1, "the capture is kept");
        assert.deepEqual(response.json.result.result, { mutation: "none", code, detail: "the tab changed", captureId: capture.id, tabId: null, windowId: null, observed: null });
        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(closeRequests(ws).length, 1, "the close is not retried");
        const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
        assert.deepEqual(audit[0].detail, { state: "partial", mutation: "none" });
      },
      { extension: { close: () => refusal(code, { detail: "the tab changed" }) } },
    );
  }
});

test("a tabs.remove whose effect is unknown (changed:null) is failed with mutation unknown and the capture id — never none, never closed — and is not retried", async () => {
  await withArchiveService(
    async ({ preview, decide, ws, owner, store }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200);
      assert.equal(response.json.result.state, "failed");
      const [capture] = store.listCaptures({}).items;
      assert.deepEqual(response.json.result.result, {
        mutation: "unknown",
        code: "close_failed",
        detail: "Tabs cannot be edited right now",
        captureId: capture.id,
        tabId: null,
        windowId: null,
        observed: null,
      });
      assert.equal((await decide("approve", action.id)).status, 409);
      assert.equal(closeRequests(ws).length, 1, "no retry");
      const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
      assert.deepEqual(audit[0].detail, { state: "failed", mutation: "unknown" });
    },
    { extension: { close: () => unknownClose() } },
  );
});

test("a lost or unusable close reply is failed with mutation unknown and the capture id, never recorded as closed or as 'nothing happened'", async () => {
  const cases = {
    "a legacy peer's bare unknown_method error (no changed flag)": () => ({ ...envelope("browser.close_tab", "error"), code: "unknown_method" }),
    "a result for the wrong method": (p) => closeResult(p, { sourceOperation: "browser.open_tab" }),
    "an ok result that says nothing changed": (p) => closeResult(p, { changed: false }),
    "an ok result with no tab handle": (p) => closeResult(p, { tabId: undefined }),
    "an answer for a different session": (p) => closeResult(p, { browserSessionId: "some-other-session" }),
    "an answer for a different tab": (p) => closeResult(p, { tabId: p.tabId + 1 }),
    "an answer for a different window": (p) => closeResult(p, { windowId: p.windowId + 1 }),
    "an unknown-effect answer for a different session": () => unknownClose({ browserSessionId: "other-session" }),
    "an incomplete answer": () => unknownClose({ status: "incomplete" }),
    "a non-object": () => "ok",
  };
  for (const [name, close] of Object.entries(cases)) {
    await withArchiveService(
      async ({ preview, decide, store }) => {
        const action = await preview();
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, name);
        const [capture] = store.listCaptures({}).items;
        assert.equal(response.json.result.state, "failed", name);
        assert.equal(response.json.result.result.mutation, "unknown", name);
        assert.equal(response.json.result.result.code, "invalid_extension_response", name);
        assert.equal(response.json.result.result.captureId, capture.id, name);
        assert.equal(response.json.result.result.tabId, null, name);
      },
      { extension: { close } },
    );
  }
});

test("a close that never answers, or a disconnect mid-close, is failed/unknown with the capture id; the capture is kept and nothing is retried", async () => {
  await withArchiveService(
    async ({ preview, decide, ws, store }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.json.result.state, "failed");
      assert.equal(response.json.result.result.mutation, "unknown");
      assert.equal(response.json.result.result.code, "request_timeout");
      assert.match(response.json.result.result.detail, /may or may not have been closed/);
      assert.equal(response.json.result.result.captureId, store.listCaptures({}).items[0].id);
      assert.equal((await decide("approve", action.id)).status, 409);
      assert.equal(closeRequests(ws).length, 1);
    },
    { requestTimeoutMs: 150, extension: { close: () => NO_RESPONSE } },
  );
  await withArchiveService(
    async ({ preview, decide, store }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.json.result.state, "failed");
      assert.equal(response.json.result.result.mutation, "unknown");
      assert.equal(response.json.result.result.code, "disconnected");
      assert.equal(response.json.result.result.captureId, store.listCaptures({}).items[0].id);
    },
    {
      extension: {
        close: (_params, ws) => {
          ws.close();
          return NO_RESPONSE;
        },
      },
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP: exactly-once, audit content, clear
// ---------------------------------------------------------------------------

test("concurrent approve and reject requests for one preview yield exactly one decision, at most one capture, and at most one close", async () => {
  await withArchiveService(
    async ({ preview, decide, ws, store }) => {
      const plans = [
        ["approve", "approve", "approve", "approve", "approve", "approve"],
        ["reject", "approve", "approve", "reject"],
        ["approve", "reject", "reject", "approve", "approve"],
        ["reject", "reject", "reject"],
      ];
      for (const plan of plans) {
        const action = await preview();
        const closesBefore = closeRequests(ws).length;
        const capturesBefore = store.listCaptures({}).total;
        const responses = await Promise.all(plan.map((operation) => decide(operation, action.id)));
        const winners = responses.filter((r) => r.status === 200);
        assert.equal(winners.length, 1, `plan ${plan.join(",")}: exactly one decision wins`);
        for (const loser of responses.filter((r) => r.status !== 200)) {
          assert.equal(loser.status, 409);
          assert.equal(loser.json.error.code, "conflict");
        }
        const state = winners[0].json.result.state;
        assert.ok(state === "executed" || state === "rejected", state);
        assert.equal(closeRequests(ws).length - closesBefore, state === "executed" ? 1 : 0, "closed at most once, and only if approved");
        assert.equal(store.listCaptures({}).total - capturesBefore, state === "executed" ? 1 : 0, "captured at most once, and only if approved");
        assert.deepEqual(
          store.listActionAudit({ actionId: action.id }).items.map((e) => e.event),
          state === "executed" ? ["result", "approve", "preview"] : ["reject", "preview"],
        );
      }
    },
    { extension: { delayMs: 60 } },
  );
});

test("a hostile extension's codes, details, titles, and addresses reach the action record (clipped) but never the audit log", async () => {
  await withArchiveService(
    async ({ preview, decide, owner }) => {
      const refusedRead = await preview();
      const refusedClose = await preview();
      const unknown = await preview();
      assert.equal((await decide("approve", refusedRead.id)).json.result.result.code, "SECRET-READ-CODE");
      assert.equal((await decide("approve", refusedClose.id)).json.result.result.code, "SECRET-CLOSE-CODE");
      assert.equal((await decide("approve", unknown.id)).json.result.result.code, "SECRET-UNKNOWN-CODE");

      const audit = (await owner("/api/store.actions.audit.list")).json.result;
      assert.equal(audit.total, 3 + 3 + 3);
      assertAuditContentFree(audit.items);
      const text = JSON.stringify(audit);
      for (const secret of ["SECRET", "secret", "evil.example", "A page", "example.com", SESSION_ID]) {
        assert.ok(!text.includes(secret), `the audit log leaked ${secret}`);
      }
    },
    {
      extension: {
        inspect: (p) => inspectResult(p, { tab: { tabId: p.tabId, windowId: 2, groupId: -1, pinned: false, title: "A page", url: URL_ONE } }),
        read: (() => {
          let calls = 0;
          return (p) => {
            calls += 1;
            return calls === 1 ? { ...envelope("browser.read_tab", "error"), code: "SECRET-READ-CODE", detail: "SECRET-DETAIL" } : readResult(p);
          };
        })(),
        close: (() => {
          let calls = 0;
          return (p) => {
            calls += 1;
            return calls === 1 ? refusal("SECRET-CLOSE-CODE", { detail: "SECRET-DETAIL" }) : unknownClose({ code: "SECRET-UNKNOWN-CODE", detail: "https://evil.example/SECRET-DETAIL" });
          };
        })(),
      },
    },
  );
});

test("store.clear is refused with 409 while an archive approval is in flight, then proceeds once its result is recorded and removes the capture too", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withArchiveService(
    async ({ preview, decide, owner, ws, store }) => {
      const action = await preview();
      const approval = decide("approve", action.id);
      await waitFor(() => closeRequests(ws).length === 1, { what: "the close request to reach the extension" });
      assert.equal(store.listCaptures({}).total, 1, "the capture was saved before the close was sent");
      const refused = await owner("/api/store.clear", { method: "POST" });
      assert.equal(refused.status, 409);
      assert.equal(store.listActions({ id: action.id }).items[0].state, "approved");
      assert.equal(store.listCaptures({}).total, 1, "a refused clear deleted nothing");
      release();
      assert.equal((await approval).json.result.state, "executed");
      assert.equal((await owner("/api/store.clear", { method: "POST" })).status, 200);
      assert.equal(store.listActions().total, 0);
      assert.equal(store.listCaptures({}).total, 0, "the capture is cleared like any other");
      assert.deepEqual(store.listActionAudit({ actionId: action.id }).items.map((e) => e.event), ["result", "approve", "preview"], "the audit log is not");
    },
    { extension: { close: async (params) => (await gate, closeResult(params)) } },
  );
});

test("archive previews and results are never written to the service log", async () => {
  const lines = [];
  await withArchiveService(
    async ({ preview, decide }) => {
      const action = await preview();
      await decide("approve", action.id);
      for (const line of lines) {
        assert.ok(!String(line).includes("example.com") && !String(line).includes("A page") && !String(line).includes("Hello archived") && !String(line).includes(OWNER_TOKEN), `log line leaked content: ${line}`);
      }
    },
    { log: (line) => lines.push(line) },
  );
});

// ---------------------------------------------------------------------------
// End to end: real service, real service client, real extension worker code
// ---------------------------------------------------------------------------

class OriginWebSocket extends WebSocket {
  constructor(url) {
    super(url, { origin: EXTENSION_ORIGIN });
  }
}

let workerCase = 0;

// Tab 5 (window 2, ungrouped, not pinned) at URL_ONE; tab 6 (window 2, pinned,
// in group 3) at another address; tab 8 loading. `scripting.executeScript`
// returns a page snapshot of the tab's current address (or throws, like a
// protected page); `tabs.remove` really closes the tab. Hooks let a test
// change the browser at the exact moment between the capture and the close.
//
// An approval reads the browser in this order: tabs.get + executeScript (the
// capture's read), tabs.get (the final check before the capture is saved), then
// tabs.get (the close's own re-check). `afterSnapshot` runs right after the page
// was read, so the final check sees its effect; `beforeCloseRead` runs just as
// the close re-reads the tab, i.e. after the capture was saved.
function mockBrowser({ supported = true, protectedPages = false, afterSnapshot, beforeCloseRead, removeOverride } = {}) {
  let stage = 0; // 0: before the page was read; 1: read, final check next; 2: final check done, close's re-read next
  const calls = { remove: [], get: [], script: [] };
  const tabs = new Map([
    [5, { id: 5, windowId: 2, groupId: -1, pinned: false, status: "complete", title: "A page", url: URL_ONE }],
    [6, { id: 6, windowId: 2, groupId: 3, pinned: true, status: "complete", title: "Pinned", url: "https://example.com/pinned" }],
    [8, { id: 8, windowId: 2, groupId: -1, pinned: false, status: "loading", title: "", url: URL_ONE }],
  ]);
  const api = {
    windows: { getAll: async () => [], get: async () => ({ id: 0 }) },
    runtime: { onMessage: { addListener: () => {} } },
    scripting: {
      executeScript: async ({ target }) => {
        calls.script.push(target.tabId);
        if (protectedPages) throw new Error("Cannot access contents of the page");
        const tab = tabs.get(target.tabId);
        const snapshot = { status: "ok", title: tab.title, url: tab.url, text: "Hello archived world", characterCount: 20, truncated: false, documentReadyState: "complete" };
        afterSnapshot?.({ tabs, tab });
        stage = 1;
        return [{ result: snapshot }];
      },
    },
    tabs: {
      query: async () => [],
      get: async (id) => {
        calls.get.push(id);
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        if (stage === 2) {
          stage = 3;
          beforeCloseRead?.(tab);
        } else if (stage === 1) {
          stage = 2;
        }
        return { ...tab };
      },
    },
  };
  if (supported) {
    api.tabs.remove = async (id) => {
      calls.remove.push(id);
      if (removeOverride) return removeOverride(id, tabs);
      tabs.delete(id);
    };
  }
  return { api, calls, tabs };
}

async function startRealExtension(port, browser = mockBrowser()) {
  globalThis.chrome = browser.api;
  workerCase += 1;
  const worker = await import(`../extension/service-worker.js?archive-e2e=${workerCase}`);
  const sessionId = (await worker.getCapabilities()).browserSessionId;
  const client = createServiceClient({
    storage: { get: async () => ({ serviceToken: OWNER_TOKEN }) },
    routeMessage: worker.routeServiceMessage,
    WebSocketImpl: OriginWebSocket,
    serviceUrl: `ws://127.0.0.1:${port}/extension`,
    getBrowserSessionId: () => sessionId,
  });
  client.start();
  await waitFor(() => client.getState() === "connected", { what: "extension client to connect" });
  await waitFor(async () => (await httpRequest({ port, path: "/health" })).json.extension.connected === true, { what: "service to see the extension" });
  return { ...browser, sessionId, stop: () => client.stop() };
}

test("end to end: preview changes nothing; approve saves exactly one capture, then closes exactly the previewed tab", async () => {
  await withArchiveService(
    async ({ port, preview, decide, owner, store }) => {
      let capturesAtRemove = null;
      const browser = mockBrowser({
        removeOverride: (id, tabs) => {
          capturesAtRemove = store.listCaptures({}).total;
          tabs.delete(id);
        },
      });
      const extension = await startRealExtension(port, browser);
      try {
        const action = await preview({ tabId: 5 });
        assert.equal(action.browserSessionId, extension.sessionId);
        assert.deepEqual(action.binding, BINDING);
        assert.deepEqual(extension.calls.remove, [], "a preview closes nothing");
        assert.deepEqual(extension.calls.script, [], "and reads no page");
        assert.equal(store.listCaptures({}).total, 0);

        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, JSON.stringify(response.json));
        assert.equal(response.json.result.state, "executed", JSON.stringify(response.json.result));
        assert.deepEqual(extension.calls.remove, [5], "exactly one tabs.remove, for exactly that tab");
        assert.equal(extension.tabs.has(5), false);
        assert.equal(extension.tabs.has(6), true, "no other tab is touched");
        assert.equal(capturesAtRemove, 1, "the capture was durable before the tab was removed");

        const [capture] = store.listCaptures({}).items;
        assert.equal(store.listCaptures({}).total, 1);
        assert.deepEqual(response.json.result.result, { mutation: "closed", code: null, detail: null, captureId: capture.id, tabId: 5, windowId: 2, observed: null });
        assert.equal(capture.url, URL_ONE);
        assert.equal(store.readCapture({ id: capture.id }).chunk, "Hello archived world");

        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(extension.calls.remove.length, 1);
        assert.equal(store.listCaptures({}).total, 1);
        const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
        assert.deepEqual(audit.map((e) => e.event), ["result", "approve", "preview"]);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a protected page and a still-loading tab are each archived as their own outcome, with no page text", async () => {
  for (const [name, options, tabId, status] of [
    ["a protected page", { protectedPages: true }, 5, "unsupported"],
    ["a loading tab", {}, 8, "not_ready"],
  ]) {
    await withArchiveService(
      async ({ port, preview, decide, store }) => {
        const extension = await startRealExtension(port, mockBrowser(options));
        try {
          const action = await preview({ tabId });
          const response = await decide("approve", action.id);
          assert.equal(response.json.result.state, "executed", `${name}: ${JSON.stringify(response.json.result)}`);
          const [capture] = store.listCaptures({}).items;
          assert.equal(capture.status, status, name);
          assert.equal(capture.id, response.json.result.result.captureId);
          assert.equal(capture.textLength, null);
          assert.equal(store.readCapture({ id: capture.id }).chunk, "");
          assert.deepEqual(extension.calls.remove, [tabId]);
        } finally {
          extension.stop();
        }
      },
      { connectExtension: false },
    );
  }
});

test("end to end: a pinned tab and a grouped tab can be archived when that is the state they are bound to", async () => {
  await withArchiveService(
    async ({ port, preview, decide, store }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ tabId: 6 });
        assert.deepEqual([action.binding.groupId, action.binding.pinned], [3, true]);
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "executed");
        assert.deepEqual(extension.calls.remove, [6]);
        assert.equal(store.listCaptures({}).total, 1);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: reject neither saves a capture nor closes the tab", async () => {
  await withArchiveService(
    async ({ port, preview, decide, store }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ tabId: 5 });
        assert.equal((await decide("reject", action.id)).json.result.state, "rejected");
        assert.equal((await decide("approve", action.id)).status, 409);
        assert.deepEqual(extension.calls.remove, []);
        assert.deepEqual(extension.calls.script, []);
        assert.equal(store.listCaptures({}).total, 0);
        assert.equal(extension.tabs.has(5), true);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a preview taken in an earlier browser session is refused as stale before any capture, and closes nothing", async () => {
  await withArchiveService(
    async ({ port, preview, decide, store }) => {
      const before = await startRealExtension(port);
      const action = await preview({ tabId: 5 });
      assert.equal(action.browserSessionId, before.sessionId);
      before.stop();
      await waitFor(async () => (await httpRequest({ port, path: "/health" })).json.extension.connected === false, { what: "old session to disconnect" });

      const after = await startRealExtension(port);
      try {
        assert.notEqual(after.sessionId, before.sessionId);
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, JSON.stringify(response.json));
        assert.equal(response.json.result.state, "stale");
        assert.equal(response.json.result.result.mutation, "none");
        assert.equal(response.json.result.result.code, "stale_session");
        assert.equal(response.json.result.result.captureId, null);
        assert.equal(store.listCaptures({}).total, 0, "no capture of a tab in a session the preview was not about");
        assert.deepEqual(after.calls.remove, []);
        assert.deepEqual(after.calls.script, []);
      } finally {
        after.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a tab that changed after the preview is refused before any capture and stays open", async () => {
  const scenarios = [
    ["the address changed", (b) => (b.tabs.get(5).url = "https://example.com/elsewhere"), "state_mismatch"],
    ["the tab moved window", (b) => (b.tabs.get(5).windowId = 4), "state_mismatch"],
    ["the tab was closed", (b) => b.tabs.delete(5), "stale_handle"],
  ];
  for (const [name, change, code] of scenarios) {
    await withArchiveService(
      async ({ port, preview, decide, store }) => {
        const extension = await startRealExtension(port);
        try {
          const action = await preview({ tabId: 5 });
          change(extension);
          const response = await decide("approve", action.id);
          assert.equal(response.json.result.state, "stale", `${name}: ${JSON.stringify(response.json.result)}`);
          assert.equal(response.json.result.result.mutation, "none", name);
          assert.equal(response.json.result.result.code, code, name);
          assert.equal(response.json.result.result.captureId, null, name);
          assert.equal(store.listCaptures({}).total, 0, `${name}: no capture was saved`);
          assert.deepEqual(extension.calls.remove, [], name);
        } finally {
          extension.stop();
        }
      },
      { connectExtension: false },
    );
  }
});

test("end to end: a tab that changes after the page was read but before the capture is saved is caught by the final check: no capture, tab open", async () => {
  const scenarios = [
    ["navigated", (tab) => (tab.url = "https://example.com/elsewhere")],
    ["pinned", (tab) => (tab.pinned = true)],
    ["grouped", (tab) => (tab.groupId = 7)],
    ["moved window", (tab) => (tab.windowId = 4)],
  ];
  for (const [name, change] of scenarios) {
    await withArchiveService(
      async ({ port, preview, decide, store }) => {
        const extension = await startRealExtension(port, mockBrowser({ afterSnapshot: ({ tab }) => change(tab) }));
        try {
          const action = await preview({ tabId: 5 });
          const response = await decide("approve", action.id);
          assert.equal(response.json.result.state, "stale", `${name}: ${JSON.stringify(response.json.result)}`);
          assert.equal(response.json.result.result.mutation, "none", name);
          assert.equal(response.json.result.result.code, "state_mismatch", name);
          assert.equal(response.json.result.result.captureId, null, name);
          assert.equal(store.listCaptures({}).total, 0, `${name}: nothing was saved`);
          assert.deepEqual(extension.calls.remove, [], `${name}: tabs.remove was never called`);
          assert.equal(extension.tabs.has(5), true, `${name}: the tab stays open`);
        } finally {
          extension.stop();
        }
      },
      { connectExtension: false },
    );
  }
});

// Chrome keeps the committed address in `url` while a navigation is under way and
// puts the address being loaded in `pendingUrl`; the archive binds, checks, and
// closes by the effective address (a non-empty pendingUrl, else url).
const PENDING_URL = "https://example.com/next";

test("end to end: a navigation to B pending since the preview of A is refused before any capture — readable, protected, and loading reads alike — and closes nothing", async () => {
  const scenarios = [
    ["a readable page", {}, (tab) => (tab.pendingUrl = PENDING_URL)],
    ["a protected page", { protectedPages: true }, (tab) => (tab.pendingUrl = PENDING_URL)],
    ["a loading tab", {}, (tab) => ((tab.status = "loading"), (tab.pendingUrl = PENDING_URL))],
  ];
  for (const [name, options, navigate] of scenarios) {
    await withArchiveService(
      async ({ port, preview, decide, store }) => {
        const extension = await startRealExtension(port, mockBrowser(options));
        try {
          const action = await preview({ tabId: 5 });
          assert.equal(action.binding.url, URL_ONE, "bound to the committed address A");
          navigate(extension.tabs.get(5)); // url is still A; the navigation to B is pending
          assert.equal(extension.tabs.get(5).url, URL_ONE);
          const response = await decide("approve", action.id);
          assert.equal(response.json.result.state, "stale", `${name}: ${JSON.stringify(response.json.result)}`);
          assert.equal(response.json.result.result.code, "state_mismatch", name);
          assert.equal(response.json.result.result.mutation, "none", name);
          assert.equal(response.json.result.result.captureId, null, name);
          assert.equal(store.listCaptures({}).total, 0, `${name}: nothing was saved`);
          assert.deepEqual(extension.calls.remove, [], `${name}: nothing was closed`);
          assert.equal(extension.tabs.has(5), true);
        } finally {
          extension.stop();
        }
      },
      { connectExtension: false },
    );
  }
});

test("end to end: a preview taken while B is pending binds B, and proceeds only while the tab is still going to B", async () => {
  // Still pending B at approval: the loading read is a not_ready capture, the close matches B, the tab closes.
  await withArchiveService(
    async ({ port, preview, decide, store }) => {
      const extension = await startRealExtension(port);
      try {
        const tab = extension.tabs.get(5);
        tab.status = "loading";
        tab.pendingUrl = PENDING_URL;
        const action = await preview({ tabId: 5 });
        assert.equal(action.binding.url, PENDING_URL, "bound to the pending address, not the committed one");
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "executed", JSON.stringify(response.json.result));
        assert.equal(store.listCaptures({}).items[0].status, "not_ready");
        assert.deepEqual(extension.calls.remove, [5]);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
  // The navigation committed to B, or was redirected, before approval: B is no longer what the tab shows as pending.
  for (const [name, settle] of [
    ["committed to B (no pending address; url B)", (tab) => ((tab.pendingUrl = ""), (tab.url = PENDING_URL), (tab.status = "complete"))],
    ["redirected elsewhere", (tab) => (tab.pendingUrl = "https://example.com/redirected")],
    ["abandoned back to A", (tab) => ((tab.pendingUrl = ""), (tab.status = "complete"))],
  ]) {
    await withArchiveService(
      async ({ port, preview, decide, store }) => {
        const extension = await startRealExtension(port);
        try {
          const tab = extension.tabs.get(5);
          tab.status = "loading";
          tab.pendingUrl = PENDING_URL;
          const action = await preview({ tabId: 5 });
          settle(tab);
          const response = await decide("approve", action.id);
          if (name.startsWith("committed")) {
            // Committed at B: the effective address is still B, so the bound state holds and the archive proceeds.
            assert.equal(response.json.result.state, "executed", `${name}: ${JSON.stringify(response.json.result)}`);
          } else {
            assert.equal(response.json.result.state, "stale", `${name}: ${JSON.stringify(response.json.result)}`);
            assert.equal(response.json.result.result.code, "state_mismatch", name);
            assert.equal(store.listCaptures({}).total, 0, `${name}: nothing was saved`);
            assert.deepEqual(extension.calls.remove, [], `${name}: nothing was closed`);
          }
        } finally {
          extension.stop();
        }
      },
      { connectExtension: false },
    );
  }
});

test("end to end: a navigation that becomes pending between the capture and the close keeps the capture and leaves the tab open", async () => {
  await withArchiveService(
    async ({ port, preview, decide, store }) => {
      const extension = await startRealExtension(port, mockBrowser({ beforeCloseRead: (tab) => (tab.pendingUrl = PENDING_URL) }));
      try {
        const action = await preview({ tabId: 5 });
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "partial", JSON.stringify(response.json.result));
        assert.equal(response.json.result.result.mutation, "none");
        assert.equal(response.json.result.result.code, "state_mismatch");
        assert.equal(store.listCaptures({}).total, 1, "the capture is kept");
        assert.deepEqual(extension.calls.remove, []);
        assert.equal(extension.tabs.has(5), true);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a tab that changes between the capture and the close keeps the capture and stays open (partial, mutation none)", async () => {
  const scenarios = [
    ["navigated", (tab) => (tab.url = "https://example.com/elsewhere")],
    ["pinned", (tab) => (tab.pinned = true)],
    ["grouped", (tab) => (tab.groupId = 7)],
    ["moved window", (tab) => (tab.windowId = 4)],
  ];
  for (const [name, change] of scenarios) {
    await withArchiveService(
      async ({ port, preview, decide, store }) => {
        const extension = await startRealExtension(
          port,
          mockBrowser({
            beforeCloseRead: (tab) => change(tab), // after the capture was saved, just as the close re-reads the tab
          }),
        );
        try {
          const action = await preview({ tabId: 5 });
          const response = await decide("approve", action.id);
          // The page was read and the final check passed (and the capture saved) as
          // previewed; the change lands only afterwards, so it is the close that refuses.
          assert.equal(response.json.result.state, "partial", `${name}: ${JSON.stringify(response.json.result)}`);
          assert.equal(response.json.result.result.mutation, "none", name);
          assert.deepEqual(extension.calls.remove, [], `${name}: tabs.remove was never called`);
          assert.equal(extension.tabs.has(5), true, `${name}: the tab stays open`);
          const [capture] = store.listCaptures({}).items;
          assert.equal(store.listCaptures({}).total, 1, `${name}: the capture is kept`);
          assert.equal(response.json.result.result.captureId, capture.id);
          assert.equal(response.json.result.result.code, "state_mismatch");
        } finally {
          extension.stop();
        }
      },
      { connectExtension: false },
    );
  }
});

test("end to end: a tabs.remove that rejects after closing the tab is failed/unknown with the capture id, with one call and no retry", async () => {
  await withArchiveService(
    async ({ port, preview, decide, store }) => {
      const extension = await startRealExtension(
        port,
        mockBrowser({
          removeOverride: async (id, tabs) => {
            tabs.delete(id); // the browser closes the tab, then reports failure
            throw new Error("Tabs cannot be edited right now");
          },
        }),
      );
      try {
        const action = await preview({ tabId: 5 });
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "failed", JSON.stringify(response.json.result));
        assert.equal(response.json.result.result.mutation, "unknown");
        assert.equal(response.json.result.result.code, "close_failed");
        const [capture] = store.listCaptures({}).items;
        assert.equal(response.json.result.result.captureId, capture.id);
        assert.equal(extension.calls.remove.length, 1);
        assert.equal(extension.tabs.has(5), false, "the tab really was closed — which is why 'nothing happened' was never claimed");
        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(extension.calls.remove.length, 1, "no retry");
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a browser without tabs.remove answers unsupported at preview, and an approved archive there saves nothing", async () => {
  await withArchiveService(
    async ({ port, owner, decide, store }) => {
      const extension = await startRealExtension(port, mockBrowser({ supported: false }));
      try {
        const response = await owner("/api/action.archive_tab.preview", { method: "POST", body: { tabId: 5 } });
        assert.equal(response.status, 501, JSON.stringify(response.json));
        assert.equal(response.json.error.code, "unsupported_feature");
        assert.equal(store.listActions().total, 0);
        // Even a preview that somehow exists is stopped by the final check, before anything is saved.
        const action = store.createAction({ kind: "archive_tab", browserSessionId: extension.sessionId, binding: BINDING });
        const approved = await decide("approve", action.id);
        assert.equal(approved.json.result.state, "failed");
        assert.equal(approved.json.result.result.mutation, "none");
        assert.equal(approved.json.result.result.code, "unsupported_feature");
        assert.equal(approved.json.result.result.captureId, null);
        assert.equal(store.listCaptures({}).total, 0, "no capture is saved by a browser that could not then close the tab");
        assert.deepEqual(extension.calls.remove, []);
        assert.equal(extension.tabs.has(5), true);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: the agent credential cannot archive or close a tab by any route, and the browser is never asked to", async () => {
  await withArchiveService(
    async ({ port, preview, store }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ tabId: 5 });
        for (const [path, body] of [
          [`/api/action.archive_tab.approve?id=${action.id}`, undefined],
          ["/api/action.archive_tab.preview", { tabId: 5 }],
          ["/api/browser.close_tab", { ...BINDING, browserSessionId: extension.sessionId }],
        ]) {
          const response = await httpRequest({ port, method: "POST", path, token: AGENT_TOKEN, body });
          assert.ok(response.status === 403 || response.status === 404, `${path} -> ${response.status}`);
        }
        assert.deepEqual(extension.calls.remove, []);
        assert.deepEqual(extension.calls.script, []);
        assert.equal(store.listCaptures({}).total, 0);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});
