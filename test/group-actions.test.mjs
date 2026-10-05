// Phase 2 Action 2 ("create, rename, or recolor a tab group"), service side:
// the action store's second kind (binding, results, append-only audit,
// migration v4, clear, restart reconciliation), the owner-only HTTP routes
// (preview binding, id-only approve/reject, stale/partial/failed/unsupported
// outcomes, exactly-once execution), and the full path through the real
// extension worker and service client.
//
// Real service, real SQLite-backed store, and a real `ws` client standing in
// for the extension in the HTTP tests; the end-to-end section at the bottom
// replaces the stand-in with the real extension code over a recorded mock
// browser. Action 1's own behavior is covered by test/actions.test.mjs.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";

import { PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { createServiceClient } from "../extension/service-client.js";
import { createService } from "../service/server.mjs";
import { DATABASE_FILE_NAME, MIGRATIONS, openStore, runMigrations } from "../service/store.mjs";
import { ACTION_INTERRUPTED_DETAIL, ACTION_MUTATIONS, ACTION_RESULT_STATES, MAX_PENDING_ACTIONS } from "../service/validation.mjs";

const OWNER_TOKEN = "group-owner-token-0123456789";
const AGENT_TOKEN = "group-agent-token-0123456789";
const EXTENSION_ORIGIN = "chrome-extension://group-test-extension";
const SESSION_ID = "group-session";
const URL_ONE = "https://example.com/page";

const CREATE_BINDING = { operation: "create", tabId: 5, windowId: 2, title: "Work", color: "red", tabTitle: "A page", tabUrl: URL_ONE };
const UPDATE_BINDING = { operation: "update", groupId: 9, windowId: 2, expectedTitle: "Old", expectedColor: "blue", title: "New", color: null };

async function withTempDir(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-groups-"));
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

const groupPreview = (store, binding = CREATE_BINDING, overrides = {}) =>
  store.createAction({ kind: "configure_group", browserSessionId: SESSION_ID, binding, ...overrides });

const observedGroup = (overrides = {}) => ({ windowId: 2, title: "Work", color: "red", collapsed: false, ...overrides });

function createdResult(overrides = {}) {
  return { state: "executed", mutation: "created", code: null, detail: null, tabId: 5, groupId: 9, windowId: 2, observed: observedGroup(), ...overrides };
}

function updatedResult(overrides = {}) {
  return createdResult({ mutation: "updated", tabId: null, observed: observedGroup({ title: "New", color: "blue" }), ...overrides });
}

// Every audit detail is built from server-controlled enums alone.
function assertAuditContentFree(events) {
  const allowed = {
    kind: ["open_tab", "configure_group"],
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
// Store: previews bind the exact handles and bound state
// ---------------------------------------------------------------------------

test("createAction records a group preview bound to its handles, bound state, requested change, and session, executing nothing", async () => {
  await withStore(async (store) => {
    const created = groupPreview(store, CREATE_BINDING);
    assert.equal(created.id, 1);
    assert.equal(created.kind, "configure_group");
    assert.equal(created.url, null);
    assert.deepEqual(created.binding, CREATE_BINDING);
    assert.equal(created.browserSessionId, SESSION_ID);
    assert.equal(created.state, "previewed");
    assert.equal(created.result, null);

    const updated = groupPreview(store, UPDATE_BINDING);
    assert.deepEqual(updated.binding, UPDATE_BINDING);
    assert.equal(updated.url, null);
    assert.deepEqual(store.listActions().items.map((a) => a.id), [2, 1]);
  });
});

test("an open_tab action is unchanged by the generalization: it still has its url and no binding", async () => {
  await withStore(async (store) => {
    const action = store.createAction({ url: "HTTPS://Example.com/x", browserSessionId: SESSION_ID });
    assert.equal(action.kind, "open_tab");
    assert.equal(action.url, "https://example.com/x");
    assert.equal(action.binding, null);
    assert.equal(store.listActionAudit().items[0].detail.kind, "open_tab");
    assert.throws(() => store.createAction({ kind: "nonsense", url: URL_ONE, browserSessionId: SESSION_ID }), (e) => e.code === "validation_error");
  });
});

test("createAction refuses an invalid or non-binding group preview, leaving no record and no audit event", async () => {
  await withStore(async (store) => {
    const bad = [
      undefined,
      null,
      "create",
      [],
      {},
      { ...CREATE_BINDING, operation: "move" },
      { ...CREATE_BINDING, tabId: -1 },
      { ...CREATE_BINDING, tabId: "5" },
      { ...CREATE_BINDING, windowId: undefined },
      { ...CREATE_BINDING, title: "" }, // a new group cannot be created with an empty title
      { ...CREATE_BINDING, title: "t".repeat(101) },
      { ...CREATE_BINDING, title: "a\nb" },
      { ...CREATE_BINDING, color: "gray" },
      { ...CREATE_BINDING, tabTitle: 5 },
      { ...CREATE_BINDING, tabTitle: "t".repeat(501) },
      { ...CREATE_BINDING, tabUrl: "u".repeat(2049) },
      { ...UPDATE_BINDING, title: null }, // changes nothing
      { ...UPDATE_BINDING, title: "Old" }, // same title
      { ...UPDATE_BINDING, title: null, color: "blue" }, // same color
      { ...UPDATE_BINDING, expectedTitle: undefined },
      { ...UPDATE_BINDING, expectedColor: "gray" },
      { ...UPDATE_BINDING, groupId: -1 },
    ];
    for (const binding of bad) {
      assert.throws(
        () => store.createAction({ kind: "configure_group", browserSessionId: SESSION_ID, binding }),
        (e) => e.code === "validation_error",
        JSON.stringify(binding)?.slice(0, 80),
      );
    }
    for (const browserSessionId of [undefined, "", 5, "s".repeat(201)]) {
      assert.throws(() => groupPreview(store, CREATE_BINDING, { browserSessionId }), (e) => e.code === "validation_error");
    }
    assert.equal(store.listActions().total, 0);
    assert.equal(store.listActionAudit().total, 0);
  });
});

test("a group action's bound fields are immutable even to raw SQL, and the table accepts no malformed kind/url/binding combination", async () => {
  await withStore(async (store) => {
    const { id } = groupPreview(store);
    const raw = new DatabaseSync(store.dbPath);
    try {
      assert.throws(() => raw.exec(`UPDATE actions SET binding = '{}' WHERE id = ${id}`), /immutable/);
      assert.throws(() => raw.exec(`UPDATE actions SET url = 'https://evil.example/' WHERE id = ${id}`), /immutable/);
      assert.throws(() => raw.exec(`UPDATE actions SET kind = 'open_tab' WHERE id = ${id}`), /immutable/);
      assert.throws(
        () => raw.exec("INSERT INTO actions (kind, url, binding, browser_session_id, state, previewed_at) VALUES ('configure_group', 'https://x/', '{}', 's', 'previewed', 0)"),
        /CHECK/,
      );
      assert.throws(
        () => raw.exec("INSERT INTO actions (kind, browser_session_id, state, previewed_at) VALUES ('configure_group', 's', 'previewed', 0)"),
        /CHECK/,
      );
      assert.throws(
        () => raw.exec("INSERT INTO actions (kind, url, binding, browser_session_id, state, previewed_at) VALUES ('open_tab', 'https://x/', '{}', 's', 'previewed', 0)"),
        /CHECK/,
      );
      assert.throws(() => raw.exec("INSERT INTO actions (kind, url, browser_session_id, state, previewed_at) VALUES ('close_tab', 'https://x/', 's', 'previewed', 0)"), /CHECK/);
    } finally {
      raw.close();
    }
    store.decideAction(id, "approve");
    store.recordActionResult(id, createdResult());
    const again = new DatabaseSync(store.dbPath);
    try {
      assert.throws(() => again.exec(`UPDATE actions SET state = 'previewed' WHERE id = ${id}`), /terminal/);
    } finally {
      again.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Store: results
// ---------------------------------------------------------------------------

test("recordActionResult stores a group action's result with its group handle and observed group", async () => {
  await withStore(async (store) => {
    const { id } = groupPreview(store);
    store.decideAction(id, "approve");
    const done = store.recordActionResult(id, createdResult());
    assert.equal(done.state, "executed");
    assert.deepEqual(done.result, {
      mutation: "created",
      code: null,
      detail: null,
      tabId: 5,
      groupId: 9,
      windowId: 2,
      observed: { windowId: 2, title: "Work", color: "red", collapsed: false },
    });
    assert.throws(() => store.recordActionResult(id, createdResult()), (e) => e.code === "conflict", "a result is recorded once");
  });
});

test("every group result state can be recorded with its own consistent shape", async () => {
  await withStore(async (store) => {
    const results = [
      createdResult(),
      updatedResult(),
      { state: "partial", mutation: "created", code: "group_update_failed", detail: "boom", tabId: 5, groupId: 9, windowId: 2 },
      { state: "partial", mutation: "created", code: "observe_failed", tabId: 5, groupId: null, windowId: 2 },
      { state: "partial", mutation: "updated", code: "observe_failed", tabId: null, groupId: 9, windowId: 2 },
      { state: "stale", mutation: "none", code: "state_mismatch" },
      { state: "failed", mutation: "none", code: "unsupported_feature" },
      { state: "failed", mutation: "unknown", code: "request_timeout" },
    ];
    for (const result of results) {
      const { id } = groupPreview(store);
      store.decideAction(id, "approve");
      assert.equal(store.recordActionResult(id, result).state, result.state);
    }
  });
});

test("recordActionResult validates a group result: consistent state/mutation/handles/observation, bounded fields", async () => {
  await withStore(async (store) => {
    const { id } = groupPreview(store);
    store.decideAction(id, "approve");
    const bad = [
      { ...createdResult(), mutation: "none" },
      { ...createdResult(), mutation: "unknown" },
      { ...createdResult(), mutation: "bogus" },
      { ...createdResult(), observed: null },
      { ...createdResult(), groupId: null },
      { ...createdResult(), windowId: null },
      { ...createdResult(), observed: observedGroup({ collapsed: "no" }) },
      { ...createdResult(), observed: observedGroup({ windowId: -1 }) },
      { ...createdResult(), observed: observedGroup({ title: "t".repeat(501) }) },
      { ...createdResult(), observed: observedGroup({ color: "c".repeat(51) }) },
      { ...createdResult(), observed: { index: 1, active: true, status: "loading", title: "", url: "", pendingUrl: null } }, // an open_tab observation
      { state: "partial", mutation: "none", code: "observe_failed" },
      { state: "partial", mutation: "unknown", code: "observe_failed" },
      { state: "partial", mutation: "created" }, // a partial outcome needs a code
      { state: "stale", mutation: "created", code: "stale_session" },
      { state: "stale", mutation: "updated", code: "stale_session" },
      { state: "stale", mutation: "none", code: "stale_session", groupId: 9 },
      { state: "failed", mutation: "created", code: "x" },
      { state: "failed", mutation: "updated", code: "x" },
      { state: "failed", mutation: "none", code: "x", tabId: 5 },
      { state: "failed", mutation: "none", code: "x", observed: observedGroup() },
      { state: "failed", mutation: "none", code: "x".repeat(201) },
      { state: "failed", mutation: "none", code: "x", detail: "d".repeat(501) },
    ];
    for (const input of bad) {
      assert.throws(() => store.recordActionResult(id, input), (e) => e.code === "validation_error", JSON.stringify(input).slice(0, 90));
    }
    assert.equal(store.listActions({ id }).items[0].state, "approved", "no invalid result changed the action");
    assert.equal(store.listActionAudit({ actionId: id }).items.length, 2, "and none was audited");
  });
});

test("an open_tab result still cannot claim an update, and a group result cannot be a tab observation", async () => {
  await withStore(async (store) => {
    const tab = store.createAction({ url: URL_ONE, browserSessionId: SESSION_ID });
    store.decideAction(tab.id, "approve");
    assert.throws(
      () => store.recordActionResult(tab.id, { state: "failed", mutation: "updated", code: "x" }),
      (e) => e.code === "validation_error",
    );
    assert.throws(() => store.recordActionResult(tab.id, createdResult()), (e) => e.code === "validation_error", "a group-shaped result is not a tab result");
    assert.equal(store.recordActionResult(tab.id, { state: "failed", mutation: "none", code: "x" }).state, "failed");
    assert.equal(store.listActions({ id: tab.id }).items[0].result.groupId, undefined, "an open_tab result never carries a group handle");
  });
});

// ---------------------------------------------------------------------------
// Store: audit, clear, reconciliation, bounds
// ---------------------------------------------------------------------------

test("the audit log records a group action's events from server enums only, with no title, handle, color, or session", async () => {
  await withStore(async (store) => {
    const a = groupPreview(store, { ...CREATE_BINDING, title: "SECRET-TITLE", tabTitle: "SECRET-TAB-TITLE", tabUrl: "https://secret.example/private" });
    store.decideAction(a.id, "approve");
    store.recordActionResult(a.id, createdResult({ observed: observedGroup({ title: "SECRET-TITLE", color: "secret-color" }) }));
    const b = groupPreview(store, UPDATE_BINDING);
    store.decideAction(b.id, "approve");
    store.recordActionResult(b.id, updatedResult());
    const c = groupPreview(store, UPDATE_BINDING);
    store.decideAction(c.id, "reject");

    const events = store.listActionAudit({ limit: 200 }).items;
    assert.deepEqual(events.filter((e) => e.actionId === a.id).map((e) => [e.event, e.detail]).reverse(), [
      ["preview", { kind: "configure_group" }],
      ["approve", { decision: "approve" }],
      ["result", { state: "executed", mutation: "created" }],
    ]);
    assert.deepEqual(events.find((e) => e.actionId === b.id && e.event === "result").detail, { state: "executed", mutation: "updated" });
    assert.deepEqual(events.find((e) => e.actionId === c.id && e.event === "reject").detail, { decision: "reject" });
    assertAuditContentFree(events);
    const text = JSON.stringify(events);
    for (const secret of ["SECRET", "secret", "example.com", "Work", "New", "Old", "blue", SESSION_ID]) {
      assert.ok(!text.includes(secret), `the audit log must not contain ${secret}`);
    }
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["actionId", "detail", "event", "id", "occurredAt"]);
  });
});

test("store.clear removes group action records (which hold the chosen tab's title and address) but never the audit log", async () => {
  await withStore(async (store) => {
    const a = groupPreview(store, { ...CREATE_BINDING, tabTitle: "RETAINED-TITLE" });
    store.decideAction(a.id, "approve");
    store.recordActionResult(a.id, createdResult());
    const auditBefore = store.listActionAudit().items;
    assert.equal(store.clearAll().deletedCounts.actions, 1);
    assert.equal(store.listActions().total, 0);
    assert.deepEqual(store.listActionAudit().items, auditBefore);
    assert.equal(groupPreview(store).id, a.id + 1, "action ids are never reused after a clear");
  });
});

test("store.clear is refused while a group action is approved and awaiting its result", async () => {
  await withStore(async (store) => {
    const a = groupPreview(store);
    store.decideAction(a.id, "approve");
    assert.throws(() => store.clearAll(), (e) => e.code === "conflict");
    store.recordActionResult(a.id, createdResult());
    assert.doesNotThrow(() => store.clearAll());
  });
});

test("reconcileInterruptedActions fails a group action found approved, with an unknown outcome and a result event, alongside a tab action", async () => {
  await withTempDir(async (dataDir) => {
    let store = await openStore({ dataDir });
    const group = groupPreview(store);
    store.decideAction(group.id, "approve");
    const tab = store.createAction({ url: URL_ONE, browserSessionId: SESSION_ID });
    store.decideAction(tab.id, "approve");
    store.close();

    store = await openStore({ dataDir });
    try {
      assert.deepEqual(store.reconcileInterruptedActions(), { reconciledCount: 2 });
      const action = store.listActions({ id: group.id }).items[0];
      assert.equal(action.state, "failed");
      assert.deepEqual(action.result, {
        mutation: "unknown",
        code: "interrupted_by_restart",
        detail: ACTION_INTERRUPTED_DETAIL,
        tabId: null,
        groupId: null,
        windowId: null,
        observed: null,
      });
      assert.deepEqual(store.listActionAudit({ actionId: group.id }).items[0].detail, { state: "failed", mutation: "unknown" });
      assert.equal(store.listActions({ id: tab.id }).items[0].result.groupId, undefined);
      assert.doesNotThrow(() => store.clearAll());
    } finally {
      store.close();
    }
  });
});

test("group previews share the pending bound with tab previews", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < MAX_PENDING_ACTIONS - 1; i += 1) store.createAction({ url: `https://example.com/${i}`, browserSessionId: SESSION_ID });
    assert.doesNotThrow(() => groupPreview(store));
    assert.throws(() => groupPreview(store), (e) => e.code === "limit_reached");
    assert.throws(() => store.createAction({ url: URL_ONE, browserSessionId: SESSION_ID }), (e) => e.code === "limit_reached");
  });
});

// ---------------------------------------------------------------------------
// Store: migration v4 (rebuilds `actions`, keeping rows, ids, and the audit log)
// ---------------------------------------------------------------------------

test("migration v4 keeps existing tab actions, continues their id sequence, and leaves the audit log untouched", async () => {
  await withTempDir(async (dataDir) => {
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const raw = new DatabaseSync(dbPath);
    try {
      runMigrations(raw, dbPath, () => {}, MIGRATIONS.slice(0, 3));
      const insert = raw.prepare("INSERT INTO actions (kind, url, browser_session_id, state, previewed_at, decided_at, completed_at, result) VALUES ('open_tab', ?, 's', ?, 10, ?, ?, ?)");
      insert.run("https://example.com/a", "executed", 11, 12, JSON.stringify({ mutation: "created", code: null, detail: null, tabId: 1, windowId: 1, observed: null }));
      insert.run("https://example.com/b", "previewed", null, null, null);
      insert.run("https://example.com/c", "previewed", null, null, null);
      raw.exec("DELETE FROM actions WHERE id = 3"); // the counter is now ahead of the highest remaining id
      raw.exec("INSERT INTO action_audit (action_id, event, occurred_at, detail) VALUES (3, 'preview', 10, '{\"kind\":\"open_tab\"}')");
      assert.equal(raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 3);
    } finally {
      raw.close();
    }

    const store = await openStore({ dataDir });
    try {
      const items = store.listActions().items;
      assert.deepEqual(items.map((a) => [a.id, a.kind, a.url, a.binding, a.state]), [
        [2, "open_tab", "https://example.com/b", null, "previewed"],
        [1, "open_tab", "https://example.com/a", null, "executed"],
      ]);
      assert.deepEqual(items[1].result, { mutation: "created", code: null, detail: null, tabId: 1, windowId: 1, observed: null });
      assert.equal(groupPreview(store).id, 4, "ids already used (and named by the audit log) are not reused");
      assert.equal(store.listActionAudit({ actionId: 3 }).total, 1);
      assert.equal(store.decideAction(2, "approve").state, "approved");
    } finally {
      store.close();
    }
    const after = new DatabaseSync(dbPath);
    try {
      assert.equal(after.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, MIGRATIONS.at(-1).version);
      assert.throws(() => after.exec("UPDATE actions SET url = 'https://evil.example/' WHERE id = 1"), /immutable/, "the triggers were recreated");
      assert.throws(() => after.exec("UPDATE actions SET state = 'approved' WHERE id = 1"), /terminal/);
      assert.throws(() => after.exec("DELETE FROM action_audit"), /append-only/, "the audit triggers are untouched");
    } finally {
      after.close();
    }
  });
});

test("migration v4 on a database whose actions were all cleared still keeps the id counter", async () => {
  await withTempDir(async (dataDir) => {
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const raw = new DatabaseSync(dbPath);
    try {
      runMigrations(raw, dbPath, () => {}, MIGRATIONS.slice(0, 3));
      for (let i = 0; i < 3; i += 1) {
        raw.exec("INSERT INTO actions (kind, url, browser_session_id, state, previewed_at) VALUES ('open_tab', 'https://example.com/', 's', 'previewed', 0)");
      }
      raw.exec("DELETE FROM actions");
    } finally {
      raw.close();
    }
    const store = await openStore({ dataDir });
    try {
      assert.equal(store.listActions().total, 0);
      assert.equal(groupPreview(store).id, 4);
    } finally {
      store.close();
    }
  });
});

test("migration v4 on a database that never had an action starts ids at 1", async () => {
  await withStore(async (store) => {
    assert.equal(groupPreview(store).id, 1);
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

function inspectResult(params, overrides = {}) {
  if (params.tabId !== undefined) {
    return {
      ...envelope("browser.inspect_group_target"),
      tab: { tabId: params.tabId, windowId: 2, grouped: false, pinned: false, title: "A page", url: URL_ONE },
      group: null,
      ...overrides,
    };
  }
  return {
    ...envelope("browser.inspect_group_target"),
    tab: null,
    group: { groupId: params.groupId, windowId: 2, title: "Old", color: "blue", collapsed: false },
    ...overrides,
  };
}

// A well-formed answer for whatever `params` the service sent.
function configureResult(params, overrides = {}) {
  const creating = params.operation === "create";
  return {
    ...envelope("browser.configure_group"),
    changed: true,
    operation: params.operation,
    tabId: creating ? params.tabId : null,
    group: {
      groupId: creating ? 9 : params.groupId,
      windowId: params.windowId,
      title: params.title ?? (creating ? "" : params.expectedTitle),
      color: params.color ?? (creating ? "grey" : params.expectedColor),
      collapsed: false,
    },
    ...overrides,
  };
}

const refusal = (code, extra = {}) => ({ ...envelope("browser.configure_group", "error"), code, changed: false, ...extra });

const NO_RESPONSE = Symbol("no response");

// A stand-in extension. Every request it receives is recorded so a test can
// assert exactly what the service asked of the browser.
function installExtensionFake(ws, { inspect = inspectResult, configure = configureResult, delayMs = 0 } = {}) {
  ws.requests = [];
  ws.on("message", async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") return;
    ws.requests.push({ method: message.method, params: message.params });
    let result;
    if (message.method === "browser.inspect_group_target") {
      result = await inspect(message.params, ws);
    } else if (message.method === "browser.configure_group") {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await configure(message.params, ws);
    } else {
      result = { ...envelope(message.method, "error"), code: "unsupported_in_test_fake" };
    }
    if (result === NO_RESPONSE) return;
    ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result }));
  });
}

const requestsOf = (ws, method) => ws.requests.filter((r) => r.method === method);
const configureRequests = (ws) => requestsOf(ws, "browser.configure_group");

async function withGroupService(run, { extension = {}, connectExtension = true, ...serviceOptions } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-groups-http-"));
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
    async preview(body = { operation: "create", tabId: 5, title: "Work", color: "red" }) {
      const response = await owner("/api/action.configure_group.preview", { method: "POST", body });
      assert.equal(response.status, 200, JSON.stringify(response.json));
      return response.json.result;
    },
    decide: (operation, id) => owner(`/api/action.configure_group.${operation}?id=${id}`, { method: "POST" }),
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

// ---------------------------------------------------------------------------
// HTTP: preview
// ---------------------------------------------------------------------------

test("preview of a create binds the exact tab, its window, the requested change, and the extension's own session, and changes nothing", async () => {
  await withGroupService(async ({ preview, ws, owner }) => {
    const action = await preview({ operation: "create", tabId: 5, title: "Work", color: "red" });
    assert.equal(action.id, 1);
    assert.equal(action.kind, "configure_group");
    assert.equal(action.state, "previewed");
    assert.equal(action.url, null);
    assert.equal(action.browserSessionId, SESSION_ID, "the session is the extension's own");
    assert.deepEqual(action.binding, CREATE_BINDING);
    assert.deepEqual(ws.requests, [{ method: "browser.inspect_group_target", params: { tabId: 5 } }], "one read-only look at the one tab; nothing changed");
    assert.deepEqual((await owner("/api/store.actions.list")).json.result.items, [action]);
  });
});

test("preview of an update binds the group's current window, title, and color", async () => {
  await withGroupService(async ({ preview, ws }) => {
    const action = await preview({ operation: "update", groupId: 9, title: "New" });
    assert.deepEqual(action.binding, UPDATE_BINDING);
    assert.deepEqual(ws.requests, [{ method: "browser.inspect_group_target", params: { groupId: 9 } }]);
  });
});

test("preview allows a create with no title or color, and clearing a title on an update (title '')", async () => {
  await withGroupService(async ({ preview }) => {
    const plain = await preview({ operation: "create", tabId: 5 });
    assert.equal(plain.binding.title, null);
    assert.equal(plain.binding.color, null);
    const cleared = await preview({ operation: "update", groupId: 9, title: "" });
    assert.equal(cleared.binding.title, "");
    assert.equal(cleared.binding.color, null);
    const recolored = await preview({ operation: "update", groupId: 9, color: "green" });
    assert.equal(recolored.binding.title, null);
    assert.equal(recolored.binding.color, "green");
  });
});

test("preview accepts only an operation, one handle, and a title/color, and contacts the extension for nothing else", async () => {
  await withGroupService(async ({ owner, ws, store }) => {
    const bodies = [
      { rawBody: "" },
      { rawBody: "not json" },
      { rawBody: "[]" },
      { rawBody: "null" },
      { body: {} },
      { body: { operation: "move", tabId: 5 } },
      { body: { operation: "create" } },
      { body: { operation: "update" } },
      { body: { operation: "create", groupId: 9 } },
      { body: { operation: "update", tabId: 5, title: "x" } },
      { body: { operation: "create", tabId: 5, groupId: 9 } },
      { body: { operation: "create", tabId: 5, browserSessionId: SESSION_ID } },
      { body: { operation: "create", tabId: 5, windowId: 2 } },
      { body: { operation: "update", groupId: 9, title: "x", expectedTitle: "Old" } },
      { body: { operation: "create", tabId: 5, tabIds: [5, 6] } },
      { body: { operation: "create", tabId: [5, 6] } },
      { body: { operation: "create", tabId: -1 } },
      { body: { operation: "create", tabId: "5" } },
      { body: { operation: "create", tabId: 1.5 } },
      { body: { operation: "create", tabId: null } },
      { body: { operation: "create", tabId: 5, title: 5 } },
      { body: { operation: "create", tabId: 5, title: null } },
      { body: { operation: "create", tabId: 5, title: "" } },
      { body: { operation: "create", tabId: 5, title: "t".repeat(101) } },
      { body: { operation: "create", tabId: 5, title: "line\nbreak" } },
      { body: { operation: "update", groupId: 9, title: "a\u0000b" } },
      { body: { operation: "create", tabId: 5, color: "gray" } },
      { body: { operation: "create", tabId: 5, color: "" } },
      { body: { operation: "create", tabId: 5, color: null } },
      { body: { operation: "update", groupId: 9, color: "#ff0000" } },
      { body: { operation: "update", groupId: 9, color: ["red"] } },
    ];
    for (const input of bodies) {
      const response = await owner("/api/action.configure_group.preview", { method: "POST", ...input });
      assert.equal(response.status, 400, `${JSON.stringify(input).slice(0, 90)} -> ${response.status} ${JSON.stringify(response.json)}`);
      assert.match(response.json.error.code, /^(validation_error|malformed_body)$/);
    }
    assert.equal(ws.requests.length, 0, "an invalid preview never reaches the extension");
    assert.equal(store.listActions().total, 0);
    assert.equal(store.listActionAudit().total, 0);
  });
});

test("preview accepts every native color and a title of the maximum length", async () => {
  await withGroupService(async ({ preview }) => {
    for (const color of ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]) {
      assert.equal((await preview({ operation: "create", tabId: 5, color })).binding.color, color);
    }
    assert.equal((await preview({ operation: "create", tabId: 5, title: "t".repeat(100) })).binding.title.length, 100);
  });
});

test("preview refuses an oversized body as 413", async () => {
  await withGroupService(async ({ owner, ws }) => {
    const response = await owner("/api/action.configure_group.preview", {
      method: "POST",
      rawBody: JSON.stringify({ operation: "create", tabId: 5, title: "t".repeat(40_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal(ws.requests.length, 0);
  });
});

test("preview of a create is refused as a conflict when the tab is already grouped, storing nothing", async () => {
  await withGroupService(
    async ({ owner, store }) => {
      const response = await owner("/api/action.configure_group.preview", { method: "POST", body: { operation: "create", tabId: 5 } });
      assert.equal(response.status, 409);
      assert.equal(response.json.error.code, "conflict");
      assert.equal(store.listActions().total, 0);
      assert.equal(store.listActionAudit().total, 0);
    },
    { extension: { inspect: (params) => inspectResult(params, { tab: { tabId: 5, windowId: 2, grouped: true, pinned: false, title: "t", url: "u" } }) } },
  );
});

test("preview of a create is refused as a conflict when the tab is pinned, storing nothing and never reaching the mutation", async () => {
  await withGroupService(
    async ({ owner, store, ws }) => {
      const response = await owner("/api/action.configure_group.preview", { method: "POST", body: { operation: "create", tabId: 5 } });
      assert.equal(response.status, 409);
      assert.equal(response.json.error.code, "conflict");
      assert.match(response.json.error.detail, /pinned/);
      assert.equal(store.listActions().total, 0);
      assert.deepEqual(ws.requests.map((r) => r.method), ["browser.inspect_group_target"]);
    },
    { extension: { inspect: (params) => inspectResult(params, { tab: { tabId: 5, windowId: 2, grouped: false, pinned: true, title: "t", url: "u" } }) } },
  );
});

test("preview rejects an inspect answer for a tab that omits pinned (a peer that cannot be trusted to refuse pinned tabs)", async () => {
  await withGroupService(
    async ({ owner, store }) => {
      const response = await owner("/api/action.configure_group.preview", { method: "POST", body: { operation: "create", tabId: 5 } });
      assert.equal(response.status, 502);
      assert.equal(response.json.error.code, "invalid_extension_response");
      assert.equal(store.listActions().total, 0);
    },
    { extension: { inspect: (params) => inspectResult(params, { tab: { tabId: 5, windowId: 2, grouped: false, title: "t", url: "u" } }) } },
  );
});

test("preview of an update that changes nothing is refused as a validation error, storing nothing", async () => {
  await withGroupService(async ({ owner, store }) => {
    for (const body of [
      { operation: "update", groupId: 9, title: "Old" },
      { operation: "update", groupId: 9, color: "blue" },
      { operation: "update", groupId: 9, title: "Old", color: "blue" },
      { operation: "update", groupId: 9 },
    ]) {
      const response = await owner("/api/action.configure_group.preview", { method: "POST", body });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(response.json.error.code, "validation_error");
    }
    assert.equal(store.listActions().total, 0);
  });
});

test("preview reports a missing target as stale_handle (409) and a browser without tab groups as unsupported_feature (501), storing nothing", async () => {
  const cases = [
    ["stale_handle", 409, { ...envelope("browser.inspect_group_target", "error"), code: "stale_handle" }],
    ["unsupported_feature", 501, { ...envelope("browser.inspect_group_target", "unsupported"), code: "unsupported_feature" }],
  ];
  for (const [code, status, answer] of cases) {
    for (const body of [{ operation: "create", tabId: 5 }, { operation: "update", groupId: 9, title: "x" }]) {
      await withGroupService(
        async ({ owner, store }) => {
          const response = await owner("/api/action.configure_group.preview", { method: "POST", body });
          assert.equal(response.status, status, JSON.stringify(response.json));
          assert.equal(response.json.error.code, code);
          assert.equal(store.listActions().total, 0);
        },
        { extension: { inspect: () => answer } },
      );
    }
  }
});

test("preview rejects an extension answer that is malformed, for another handle, or an unexpected error", async () => {
  const answers = {
    "garbage": () => ({ garbage: true }),
    "a legacy-shaped array": () => [],
    "both tab and group": () => inspectResult({ tabId: 5 }, { group: { groupId: 9, windowId: 2, title: "", color: "red", collapsed: false } }),
    "a group with a non-native color": () => inspectResult({ groupId: 9 }, { group: { groupId: 9, windowId: 2, title: "", color: "mauve", collapsed: false } }),
    "a different tab than requested": () => inspectResult({ tabId: 6 }),
    "a different group than requested": () => inspectResult({ groupId: 10 }),
    "an unexpected error code": () => ({ ...envelope("browser.inspect_group_target", "error"), code: "internal_error" }),
    "a result for the wrong method": (p) => inspectResult(p, { sourceOperation: "browser.list_tabs" }),
  };
  for (const [name, inspect] of Object.entries(answers)) {
    await withGroupService(
      async ({ owner, store }) => {
        const tab = await owner("/api/action.configure_group.preview", { method: "POST", body: { operation: "create", tabId: 5 } });
        const group = await owner("/api/action.configure_group.preview", { method: "POST", body: { operation: "update", groupId: 9, title: "x" } });
        assert.equal(tab.status, 502, `${name}: tab ${JSON.stringify(tab.json)}`);
        assert.equal(group.status, 502, `${name}: group ${JSON.stringify(group.json)}`);
        assert.equal(tab.json.error.code, "invalid_extension_response");
        assert.equal(store.listActions().total, 0, name);
      },
      { extension: { inspect } },
    );
  }
});

test("preview fails explicitly as disconnected when no extension is connected, storing nothing", async () => {
  await withGroupService(
    async ({ owner, store }) => {
      const response = await owner("/api/action.configure_group.preview", { method: "POST", body: { operation: "create", tabId: 5 } });
      assert.equal(response.status, 503);
      assert.equal(response.json.error.code, "disconnected");
      assert.equal(store.listActions().total, 0);
    },
    { connectExtension: false },
  );
});

test("preview is refused with limit_reached once too many previews await a decision", async () => {
  await withGroupService(async ({ preview, owner }) => {
    for (let i = 0; i < MAX_PENDING_ACTIONS; i += 1) await preview({ operation: "create", tabId: 5 });
    const response = await owner("/api/action.configure_group.preview", { method: "POST", body: { operation: "create", tabId: 5 } });
    assert.equal(response.status, 409);
    assert.equal(response.json.error.code, "limit_reached");
  });
});

// ---------------------------------------------------------------------------
// HTTP: authorization — the owner alone, and no direct mutation route
// ---------------------------------------------------------------------------

test("every group action route rejects a missing or wrong credential, and the external-agent credential with 403, reaching nothing", async () => {
  await withGroupService(async ({ port, preview, ws, store }) => {
    const action = await preview();
    const requestsBefore = ws.requests.length;
    const routes = [
      { method: "POST", path: "/api/action.configure_group.preview", body: { operation: "create", tabId: 5 } },
      { method: "POST", path: `/api/action.configure_group.approve?id=${action.id}` },
      { method: "POST", path: `/api/action.configure_group.reject?id=${action.id}` },
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
    assert.equal(store.listActions().total, 1);
  });
});

test("browser.configure_group and browser.inspect_group_target have no HTTP route at all, for either credential, as a GET or a POST", async () => {
  await withGroupService(async ({ port, ws }) => {
    for (const token of [OWNER_TOKEN, AGENT_TOKEN]) {
      for (const method of ["GET", "POST"]) {
        for (const path of [
          `/api/browser.configure_group?operation=update&groupId=9&title=x&browserSessionId=${SESSION_ID}`,
          `/api/browser.inspect_group_target?tabId=5`,
          "/api/browser.group_tab",
          "/api/browser.move_tabs",
          "/api/action.configure_group",
          "/api/action.configure_group.execute?id=1",
          "/api/action.configure_group.move?id=1",
          "/api/workflow.configure_group",
          "/api/store.actions.create",
          "/api/store.actions.update?id=1",
          "/api/store.actions.delete?id=1",
        ]) {
          const response = await httpRequest({ port, path, method, token, body: method === "POST" ? { operation: "update", groupId: 9, title: "x" } : undefined });
          assert.equal(response.status, 404, `${method} ${path} as ${token === OWNER_TOKEN ? "owner" : "agent"} -> ${response.status}`);
        }
      }
    }
    assert.equal(ws.requests.length, 0);
  });
});

test("the group action routes accept only POST", async () => {
  await withGroupService(async ({ owner, preview, store }) => {
    const action = await preview();
    for (const method of ["GET", "PATCH", "DELETE", "PUT"]) {
      for (const path of ["preview", `approve?id=${action.id}`, `reject?id=${action.id}`]) {
        assert.equal((await owner(`/api/action.configure_group.${path}`, { method })).status, 405, `${method} ${path}`);
      }
    }
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed");
  });
});

test("a request using the previous protocol version (3) is rejected before any group route runs", async () => {
  await withGroupService(async ({ port, ws }) => {
    const response = await httpRequest({
      port,
      method: "POST",
      path: "/api/action.configure_group.preview",
      token: OWNER_TOKEN,
      body: { operation: "create", tabId: 5 },
      extraHeaders: { "x-protocol-version": "3" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "unsupported_protocol_version");
    assert.equal(ws.requests.length, 0);
  });
});

test("an extension still speaking protocol version 3 is refused at the handshake", async () => {
  await withGroupService(
    async ({ port }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: EXTENSION_ORIGIN });
      await new Promise((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      });
      const reply = nextMessage(ws);
      ws.send(JSON.stringify({ type: "auth", protocolVersion: 3, token: OWNER_TOKEN }));
      const message = await reply;
      assert.equal(message.type, "auth_error");
      assert.equal(message.code, "unsupported_protocol_version");
      ws.close();
    },
    { connectExtension: false },
  );
});

// ---------------------------------------------------------------------------
// HTTP: approve / reject
// ---------------------------------------------------------------------------

test("approving a create sends exactly the previewed handles, state, and change, once, and records the observed group", async () => {
  await withGroupService(async ({ preview, decide, ws, owner }) => {
    const action = await preview({ operation: "create", tabId: 5, title: "Work", color: "red" });
    const response = await decide("approve", action.id);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const done = response.json.result;
    assert.equal(done.id, action.id);
    assert.equal(done.state, "executed");
    assert.deepEqual(done.binding, action.binding);
    assert.equal(done.browserSessionId, action.browserSessionId);
    assert.ok(done.decidedAt >= done.previewedAt && done.completedAt >= done.decidedAt);
    assert.deepEqual(done.result, {
      mutation: "created",
      code: null,
      detail: null,
      tabId: 5,
      groupId: 9,
      windowId: 2,
      observed: { windowId: 2, title: "Work", color: "red", collapsed: false },
    });
    const sent = configureRequests(ws);
    assert.equal(sent.length, 1, "exactly one browser.configure_group request");
    assert.deepEqual(sent[0].params, { browserSessionId: SESSION_ID, operation: "create", tabId: 5, windowId: 2, title: "Work", color: "red" });

    const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
    assert.deepEqual(audit.map((e) => e.event), ["result", "approve", "preview"]);
    assert.deepEqual(audit[0].detail, { state: "executed", mutation: "created" });
  });
});

test("approving an update sends the group's bound window, title, and color for the extension to re-check, and records the observed group", async () => {
  await withGroupService(async ({ preview, decide, ws }) => {
    const action = await preview({ operation: "update", groupId: 9, title: "New" });
    const response = await decide("approve", action.id);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.result.state, "executed");
    assert.deepEqual(response.json.result.result, {
      mutation: "updated",
      code: null,
      detail: null,
      tabId: null,
      groupId: 9,
      windowId: 2,
      observed: { windowId: 2, title: "New", color: "blue", collapsed: false },
    });
    assert.deepEqual(configureRequests(ws).map((r) => r.params), [
      { browserSessionId: SESSION_ID, operation: "update", groupId: 9, windowId: 2, expectedTitle: "Old", expectedColor: "blue", title: "New", color: null },
    ]);
  });
});

test("a decided action can never be decided or executed again", async () => {
  await withGroupService(async ({ preview, decide, ws }) => {
    const action = await preview();
    assert.equal((await decide("approve", action.id)).status, 200);
    for (const operation of ["approve", "reject", "approve"]) {
      const again = await decide(operation, action.id);
      assert.equal(again.status, 409, operation);
      assert.equal(again.json.error.code, "conflict");
    }
    assert.equal(configureRequests(ws).length, 1, "no duplicate execution");
  });
});

test("approve and reject take the action id alone: no body, no other parameter, a valid id", async () => {
  await withGroupService(async ({ owner, preview, ws, store }) => {
    const action = await preview();
    for (const operation of ["approve", "reject"]) {
      const attempts = [
        { path: `/api/action.configure_group.${operation}?id=${action.id}`, body: { title: "evil" } },
        { path: `/api/action.configure_group.${operation}?id=${action.id}`, rawBody: "{}" },
        { path: `/api/action.configure_group.${operation}?id=${action.id}&title=evil` },
        { path: `/api/action.configure_group.${operation}?id=${action.id}&browserSessionId=other` },
        { path: `/api/action.configure_group.${operation}?id=${action.id}&groupId=1` },
        { path: `/api/action.configure_group.${operation}` },
        { path: `/api/action.configure_group.${operation}?id=` },
        { path: `/api/action.configure_group.${operation}?id=0` },
        { path: `/api/action.configure_group.${operation}?id=-1` },
        { path: `/api/action.configure_group.${operation}?id=abc` },
        { path: `/api/action.configure_group.${operation}?tabId=5` },
      ];
      for (const { path, ...input } of attempts) {
        const response = await owner(path, { method: "POST", ...input });
        assert.equal(response.status, 400, `${operation} ${path} ${JSON.stringify(input)} -> ${response.status}`);
        assert.equal(response.json.error.code, "validation_error");
      }
    }
    assert.equal(configureRequests(ws).length, 0);
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed", "none of the refused requests decided anything");
    assert.equal(store.listActionAudit({ actionId: action.id }).total, 1);
  });
});

test("approve and reject of an unknown action id are 404 and change nothing", async () => {
  await withGroupService(async ({ decide, ws }) => {
    for (const operation of ["approve", "reject"]) {
      const response = await decide(operation, 12345);
      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, "not_found");
    }
    assert.equal(configureRequests(ws).length, 0);
  });
});

test("each route decides only its own kind: a tab action's id on the group route (and the reverse) is a 404 that decides nothing", async () => {
  await withGroupService(async ({ preview, decide, owner, ws, store }) => {
    const group = await preview();
    const tab = store.createAction({ url: URL_ONE, browserSessionId: SESSION_ID });
    for (const operation of ["approve", "reject"]) {
      const wrongForTab = await decide(operation, tab.id);
      assert.equal(wrongForTab.status, 404, `group ${operation} of a tab action`);
      const wrongForGroup = await owner(`/api/action.open_tab.${operation}?id=${group.id}`, { method: "POST" });
      assert.equal(wrongForGroup.status, 404, `tab ${operation} of a group action`);
    }
    assert.equal(store.listActions({ id: tab.id }).items[0].state, "previewed");
    assert.equal(store.listActions({ id: group.id }).items[0].state, "previewed");
    assert.equal(ws.requests.filter((r) => r.method !== "browser.inspect_group_target").length, 0, "nothing was sent to the browser");
    assert.equal(store.listActionAudit({ actionId: tab.id }).total, 1);
    assert.equal(store.listActionAudit({ actionId: group.id }).total, 1);
  });
});

test("reject records the decision and changes nothing, and a rejected preview cannot then be approved", async () => {
  await withGroupService(async ({ preview, decide, ws, owner }) => {
    const action = await preview();
    const response = await decide("reject", action.id);
    assert.equal(response.status, 200);
    assert.equal(response.json.result.state, "rejected");
    assert.equal(response.json.result.result, null);
    assert.equal((await decide("approve", action.id)).status, 409);
    assert.equal(configureRequests(ws).length, 0, "a rejected preview is never executed");
    const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
    assert.deepEqual(audit.map((e) => e.event), ["reject", "preview"]);
  });
});

test("approve while the extension is disconnected is refused without consuming the preview", async () => {
  await withGroupService(async ({ preview, decide, ws, store, port }) => {
    const action = await preview();
    ws.close();
    await waitFor(async () => (await httpRequest({ port, path: "/health" })).json.extension.connected === false, { what: "extension disconnect" });
    const refused = await decide("approve", action.id);
    assert.equal(refused.status, 503);
    assert.equal(refused.json.error.code, "disconnected");
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed", "the preview is still awaiting a decision");
    assert.equal(store.listActionAudit({ actionId: action.id }).total, 1);
  });
});

test("the extension refusing because the session, handle, or bound state no longer holds is a terminal 'stale' outcome with no change", async () => {
  for (const code of ["stale_session", "stale_handle", "state_mismatch"]) {
    await withGroupService(
      async ({ preview, decide, ws, owner }) => {
        const action = await preview();
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, code);
        assert.equal(response.json.result.state, "stale", code);
        assert.deepEqual(response.json.result.result, { mutation: "none", code, detail: "since the preview", tabId: null, groupId: null, windowId: null, observed: null });
        assert.equal((await decide("approve", action.id)).status, 409, "a stale action is terminal; a new preview is needed");
        assert.equal(configureRequests(ws).length, 1, "and is not retried");
        const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
        assert.deepEqual(audit[0].detail, { state: "stale", mutation: "none" });
      },
      { extension: { configure: () => refusal(code, { detail: "since the preview" }) } },
    );
  }
});

test("a browser without tab groups, or any other refusal that changed nothing, is a terminal 'failed' outcome with mutation none", async () => {
  const cases = [
    ["unsupported_feature", { ...envelope("browser.configure_group", "unsupported"), code: "unsupported_feature", changed: false }],
    ["group_failed", refusal("group_failed", { detail: "Tabs cannot be edited right now" })],
    ["group_update_failed", refusal("group_update_failed")],
    ["invalid_params", refusal("invalid_params", { detail: "the request must change the group's title or color" })],
  ];
  for (const [code, answer] of cases) {
    await withGroupService(
      async ({ preview, decide }) => {
        const action = await preview({ operation: "update", groupId: 9, title: "New" });
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, code);
        assert.equal(response.json.result.state, "failed", code);
        assert.equal(response.json.result.result.mutation, "none");
        assert.equal(response.json.result.result.code, code);
        assert.equal(response.json.result.result.observed, null);
      },
      { extension: { configure: () => answer } },
    );
  }
});

test("a partial outcome after a change is reported as partial with the handles known, and never retried", async () => {
  const cases = [
    {
      body: { operation: "create", tabId: 5, title: "Work" },
      answer: { ...envelope("browser.configure_group", "incomplete"), code: "group_update_failed", detail: "No group with id: 9", changed: true, groupId: 9, windowId: 2, tabId: 5 },
      expected: { mutation: "created", code: "group_update_failed", detail: "No group with id: 9", tabId: 5, groupId: 9, windowId: 2, observed: null },
    },
    {
      body: { operation: "create", tabId: 5 },
      answer: { ...envelope("browser.configure_group", "incomplete"), code: "observe_failed", changed: true, groupId: null, windowId: 2, tabId: 5 },
      expected: { mutation: "created", code: "observe_failed", detail: null, tabId: 5, groupId: null, windowId: 2, observed: null },
    },
    {
      body: { operation: "update", groupId: 9, color: "green" },
      answer: { ...envelope("browser.configure_group", "incomplete"), code: "observe_failed", detail: "No group with id: 9", changed: true, groupId: 9, windowId: 2, tabId: null },
      expected: { mutation: "updated", code: "observe_failed", detail: "No group with id: 9", tabId: null, groupId: 9, windowId: 2, observed: null },
    },
  ];
  for (const { body, answer, expected } of cases) {
    await withGroupService(
      async ({ preview, decide, ws, owner }) => {
        const action = await preview(body);
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200);
        assert.equal(response.json.result.state, "partial");
        assert.deepEqual(response.json.result.result, expected);
        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(configureRequests(ws).length, 1, "a partial outcome is not retried");
        const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
        assert.deepEqual(audit[0].detail, { state: "partial", mutation: expected.mutation });
      },
      { extension: { configure: () => answer } },
    );
  }
});

test("an unusable extension answer is a 'failed' outcome with mutation unknown, never forwarded as success", async () => {
  const cases = {
    "a legacy peer's bare unknown_method error (no changed flag)": () => ({ ...envelope("browser.configure_group", "error"), code: "unknown_method" }),
    "a result for the wrong method": (p) => configureResult(p, { sourceOperation: "browser.open_tab" }),
    "an ok result with no observed group": (p) => configureResult(p, { group: undefined }),
    "an ok result that says nothing changed": (p) => configureResult(p, { changed: false }),
    "an answer for a different session": (p) => configureResult(p, { browserSessionId: "some-other-session" }),
    "an answer for the other operation": (p) => configureResult(p, { operation: "update", tabId: null }),
    "an answer for a different group": (p) => configureResult(p, { group: { groupId: 9, windowId: p.windowId + 1, title: "", color: "red", collapsed: false } }),
    "an answer for a different tab": (p) => configureResult(p, { tabId: 6 }),
    "a partial answer for a different session": (p) => ({ ...envelope("browser.configure_group", "incomplete", "other-session"), code: "observe_failed", changed: true, groupId: 9, windowId: p.windowId, tabId: p.tabId }),
    "a partial create for another tab": (p) => ({ ...envelope("browser.configure_group", "incomplete"), code: "observe_failed", changed: true, groupId: 9, windowId: p.windowId, tabId: p.tabId + 1 }),
    "a partial create for another window": (p) => ({ ...envelope("browser.configure_group", "incomplete"), code: "group_update_failed", changed: true, groupId: 9, windowId: p.windowId + 1, tabId: p.tabId }),
    "a partial create naming no tab": (p) => ({ ...envelope("browser.configure_group", "incomplete"), code: "observe_failed", changed: true, groupId: 9, windowId: p.windowId, tabId: null }),
    "a partial create naming no window": (p) => ({ ...envelope("browser.configure_group", "incomplete"), code: "observe_failed", changed: true, groupId: 9, windowId: null, tabId: p.tabId }),
    "an invented partial code": (p) => ({ ...envelope("browser.configure_group", "incomplete"), code: "whatever", changed: true, groupId: 9, windowId: p.windowId, tabId: p.tabId }),
    "a non-object": () => "ok",
  };
  for (const [name, configure] of Object.entries(cases)) {
    await withGroupService(
      async ({ preview, decide }) => {
        const action = await preview({ operation: "create", tabId: 5, title: "Work" });
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, name);
        assert.equal(response.json.result.state, "failed", name);
        assert.equal(response.json.result.result.mutation, "unknown", name);
        assert.equal(response.json.result.result.code, "invalid_extension_response", name);
        assert.equal(response.json.result.result.observed, null, name);
      },
      { extension: { configure } },
    );
  }
  await withGroupService(
    async ({ preview, decide }) => {
      const action = await preview({ operation: "update", groupId: 9, title: "New" });
      const response = await decide("approve", action.id);
      assert.equal(response.json.result.state, "failed", "an update answered for a different group id");
      assert.equal(response.json.result.result.mutation, "unknown");
    },
    { extension: { configure: (p) => configureResult(p, { group: { groupId: 10, windowId: 2, title: "New", color: "blue", collapsed: false } }) } },
  );

  // A hostile extension's partial update: handles that are not the preview's own.
  const partialUpdate = (p, overrides) => ({
    ...envelope("browser.configure_group", "incomplete"),
    code: "observe_failed",
    changed: true,
    groupId: p.groupId,
    windowId: p.windowId,
    tabId: null,
    ...overrides,
  });
  const hostilePartials = {
    "a partial update for another group": (p) => partialUpdate(p, { groupId: p.groupId + 1 }),
    "a partial update with no group": (p) => partialUpdate(p, { groupId: null }),
    "a partial update for another window": (p) => partialUpdate(p, { windowId: p.windowId + 1 }),
    "a partial update naming a tab": (p) => partialUpdate(p, { tabId: 5 }),
  };
  for (const [name, configure] of Object.entries(hostilePartials)) {
    await withGroupService(
      async ({ preview, decide, store }) => {
        const action = await preview({ operation: "update", groupId: 9, title: "New" });
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "failed", name);
        assert.equal(response.json.result.result.mutation, "unknown", name);
        assert.equal(response.json.result.result.code, "invalid_extension_response", name);
        assert.equal(response.json.result.result.groupId, null, name);
        assert.equal(store.listActions({ id: action.id }).items[0].state, "failed");
      },
      { extension: { configure } },
    );
  }
});

test("an extension that never answers yields a failed outcome with mutation unknown, and the action is not retried", async () => {
  await withGroupService(
    async ({ preview, decide, ws }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200);
      assert.equal(response.json.result.state, "failed");
      assert.equal(response.json.result.result.mutation, "unknown");
      assert.equal(response.json.result.result.code, "request_timeout");
      assert.match(response.json.result.result.detail, /may or may not/);
      assert.equal((await decide("approve", action.id)).status, 409);
      assert.equal(configureRequests(ws).length, 1);
    },
    { requestTimeoutMs: 150, extension: { configure: () => NO_RESPONSE } },
  );
});

test("an extension that disconnects mid-request yields a failed outcome with mutation unknown", async () => {
  await withGroupService(
    async ({ preview, decide }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200);
      assert.equal(response.json.result.state, "failed");
      assert.equal(response.json.result.result.mutation, "unknown");
      assert.equal(response.json.result.result.code, "disconnected");
    },
    {
      extension: {
        configure: (_params, ws) => {
          ws.close();
          return NO_RESPONSE;
        },
      },
    },
  );
});

test("an observed title, color, and detail are clipped to their bounds before being stored", async () => {
  await withGroupService(
    async ({ preview, decide, store }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const { observed } = response.json.result.result;
      assert.equal(observed.title.length, 500);
      assert.equal(observed.color.length, 50);
      assert.equal(store.listActions({ id: action.id }).items[0].state, "executed");
    },
    { extension: { configure: (p) => configureResult(p, { group: { groupId: 9, windowId: p.windowId, title: "T".repeat(10_000), color: "c".repeat(500), collapsed: true } }) } },
  );
});

// ---------------------------------------------------------------------------
// HTTP: exactly-once, audit content, clear
// ---------------------------------------------------------------------------

test("concurrent approve and reject requests for one preview yield exactly one decision and at most one execution", async () => {
  await withGroupService(
    async ({ preview, decide, ws, store }) => {
      const plans = [
        ["approve", "approve", "approve", "approve", "approve", "approve"],
        ["reject", "approve", "approve", "reject"],
        ["approve", "reject", "reject", "approve", "approve"],
        ["reject", "reject", "reject"],
      ];
      for (const plan of plans) {
        const action = await preview({ operation: "create", tabId: 5, title: plan.join("-").slice(0, 20) });
        const before = configureRequests(ws).length;
        const responses = await Promise.all(plan.map((operation) => decide(operation, action.id)));
        const winners = responses.filter((r) => r.status === 200);
        assert.equal(winners.length, 1, `plan ${plan.join(",")}: exactly one decision wins`);
        for (const loser of responses.filter((r) => r.status !== 200)) {
          assert.equal(loser.status, 409);
          assert.equal(loser.json.error.code, "conflict");
        }
        const state = winners[0].json.result.state;
        assert.ok(state === "executed" || state === "rejected", state);
        assert.equal(configureRequests(ws).length - before, state === "executed" ? 1 : 0, "executed at most once, and only if approved");
        assert.deepEqual(
          store.listActionAudit({ actionId: action.id }).items.map((e) => e.event),
          state === "executed" ? ["result", "approve", "preview"] : ["reject", "preview"],
        );
      }
    },
    { extension: { delayMs: 60 } },
  );
});

test("a hostile extension's codes, details, titles, colors, and handles reach the action record (clipped) but never the audit log", async () => {
  await withGroupService(
    async ({ preview, decide, owner }) => {
      const refused = await preview({ operation: "create", tabId: 5, title: "refused" });
      const opened = await preview({ operation: "create", tabId: 5, title: "opened" });
      const partial = await preview({ operation: "create", tabId: 5, title: "partial" });
      assert.equal((await decide("approve", refused.id)).json.result.result.code, "SECRET-CODE");
      assert.equal((await decide("approve", opened.id)).json.result.state, "executed");
      assert.equal((await decide("approve", partial.id)).json.result.state, "partial");

      const audit = (await owner("/api/store.actions.audit.list")).json.result;
      assert.equal(audit.total, 3 + 3 + 3);
      assertAuditContentFree(audit.items);
      const text = JSON.stringify(audit);
      for (const secret of ["SECRET", "secret", "evil.example", "refused", "opened", "A page", SESSION_ID]) {
        assert.ok(!text.includes(secret), `the audit log leaked ${secret}`);
      }
      const record = (await owner(`/api/store.actions.list?id=${opened.id}`)).json.result.items[0];
      assert.equal(record.result.observed.title, "SECRET-TITLE");
      assert.equal(record.result.groupId, 4242);
    },
    {
      extension: {
        configure: (params) => {
          if (params.title === "refused") return refusal("SECRET-CODE", { detail: "SECRET-DETAIL" });
          if (params.title === "partial") {
            return { ...envelope("browser.configure_group", "incomplete"), code: "observe_failed", detail: "SECRET-DETAIL", changed: true, groupId: 4343, windowId: params.windowId, tabId: 5 };
          }
          return configureResult(params, { group: { groupId: 4242, windowId: params.windowId, title: "SECRET-TITLE", color: "secret-color", collapsed: false } });
        },
      },
    },
  );
});

test("store.clear is refused with 409 while a group approval is in flight, then proceeds once its result is recorded", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withGroupService(
    async ({ preview, decide, owner, ws, store }) => {
      const action = await preview();
      const approval = decide("approve", action.id);
      await waitFor(() => configureRequests(ws).length === 1, { what: "the mutation request to reach the extension" });
      const refused = await owner("/api/store.clear", { method: "POST" });
      assert.equal(refused.status, 409);
      assert.equal(store.listActions({ id: action.id }).items[0].state, "approved");
      release();
      assert.equal((await approval).json.result.state, "executed");
      assert.equal((await owner("/api/store.clear", { method: "POST" })).status, 200);
      assert.equal(store.listActions().total, 0);
      assert.deepEqual(store.listActionAudit({ actionId: action.id }).items.map((e) => e.event), ["result", "approve", "preview"]);
    },
    { extension: { configure: async (params) => (await gate, configureResult(params)) } },
  );
});

test("group action previews and results are never written to the service log", async () => {
  const lines = [];
  await withGroupService(
    async ({ preview, decide }) => {
      const action = await preview({ operation: "create", tabId: 5, title: "secret-group-title" });
      await decide("approve", action.id);
      for (const line of lines) {
        assert.ok(!String(line).includes("secret-group-title") && !String(line).includes("example.com") && !String(line).includes(OWNER_TOKEN), `log line leaked content: ${line}`);
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

// A recorded mock browser with one ungrouped tab (id 5, window 2) and one
// group (id 9, window 2, "Old"/blue). `state` can be changed by a test between
// preview and approval to simulate the user changing the browser meanwhile.
function mockBrowser({ supported = true, overrides = {} } = {}) {
  const calls = { group: [], update: [], tabsGet: [], groupsGet: [] };
  const state = { tabGroupId: -1, tabWindowId: 2, tabPinned: false, group: { id: 9, windowId: 2, title: "Old", color: "blue", collapsed: false } };
  const api = {
    windows: { getAll: async () => [], get: async () => ({ id: 0 }) },
    scripting: { executeScript: async () => [] },
    runtime: { onMessage: { addListener: () => {} } },
    tabs: {
      query: async () => [],
      get: async (id) => {
        calls.tabsGet.push(id);
        if (id !== 5) throw new Error(`No tab with id: ${id}`);
        return { id: 5, windowId: state.tabWindowId, groupId: state.tabGroupId, pinned: state.tabPinned, title: "A page", url: URL_ONE };
      },
    },
  };
  if (supported) {
    api.tabs.group = async (options) => {
      calls.group.push(options);
      state.tabGroupId = 9;
      state.group = { id: 9, windowId: options.createProperties?.windowId ?? 2, title: "", color: "grey", collapsed: false };
      return 9;
    };
    api.tabGroups = {
      get: async (id) => {
        calls.groupsGet.push(id);
        if (id !== 9) throw new Error(`No group with id: ${id}`);
        return { ...state.group };
      },
      update: async (id, props) => {
        calls.update.push({ id, props });
        if (overrides.update) return overrides.update(id, props);
        Object.assign(state.group, props);
        return { ...state.group };
      },
    };
  }
  return { api, calls, state };
}

// Loads a fresh instance of the real extension worker against `browser` and
// connects it to `port` through the real service client. Each instance has its
// own browserSessionId, like a browser session of its own.
async function startRealExtension(port, browser = mockBrowser()) {
  globalThis.chrome = browser.api;
  workerCase += 1;
  const worker = await import(`../extension/service-worker.js?groups-e2e=${workerCase}`);
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

const noMutation = (browser) => {
  assert.deepEqual(browser.calls.group, [], "tabs.group was never called");
  assert.deepEqual(browser.calls.update, [], "tabGroups.update was never called");
};

test("end to end: preview then approve creates one group around exactly the previewed tab and reports the browser's observed group", async () => {
  await withGroupService(
    async ({ port, preview, decide, owner }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ operation: "create", tabId: 5, title: "Work", color: "red" });
        assert.equal(action.browserSessionId, extension.sessionId);
        assert.deepEqual(action.binding, { ...CREATE_BINDING, tabTitle: "A page", tabUrl: URL_ONE });
        noMutation(extension);

        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, JSON.stringify(response.json));
        assert.equal(response.json.result.state, "executed");
        assert.deepEqual(extension.calls.group, [{ tabIds: [5], createProperties: { windowId: 2 } }], "exactly one tab, by id, kept in the previewed window");
        assert.deepEqual(extension.calls.update, [{ id: 9, props: { title: "Work", color: "red" } }]);
        assert.deepEqual(response.json.result.result, {
          mutation: "created",
          code: null,
          detail: null,
          tabId: 5,
          groupId: 9,
          windowId: 2,
          observed: { windowId: 2, title: "Work", color: "red", collapsed: false },
        });

        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(extension.calls.group.length, 1);
        const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
        assert.deepEqual(audit.map((e) => e.event), ["result", "approve", "preview"]);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: preview then approve renames and recolors an existing group once", async () => {
  await withGroupService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ operation: "update", groupId: 9, title: "New", color: "green" });
        noMutation(extension);
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "executed", JSON.stringify(response.json));
        assert.equal(response.json.result.result.mutation, "updated");
        assert.deepEqual(extension.calls.group, [], "an update never creates a group");
        assert.deepEqual(extension.calls.update, [{ id: 9, props: { title: "New", color: "green" } }]);
        assert.deepEqual(response.json.result.result.observed, { windowId: 2, title: "New", color: "green", collapsed: false });
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: clearing a title sends the explicit empty string and reports the group untitled", async () => {
  await withGroupService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ operation: "update", groupId: 9, title: "" });
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "executed");
        assert.deepEqual(extension.calls.update, [{ id: 9, props: { title: "" } }]);
        assert.equal(response.json.result.result.observed.title, "");
        assert.equal(response.json.result.result.observed.color, "blue", "the color was left alone");
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: reject changes nothing at all", async () => {
  await withGroupService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(port);
      try {
        for (const body of [{ operation: "create", tabId: 5, title: "x" }, { operation: "update", groupId: 9, title: "x" }]) {
          const action = await preview(body);
          assert.equal((await decide("reject", action.id)).json.result.state, "rejected");
          assert.equal((await decide("approve", action.id)).status, 409);
        }
        noMutation(extension);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a preview taken in an earlier browser session is refused as stale and changes nothing", async () => {
  await withGroupService(
    async ({ port, preview, decide }) => {
      const before = await startRealExtension(port);
      const action = await preview({ operation: "update", groupId: 9, title: "New" });
      assert.equal(action.browserSessionId, before.sessionId);
      before.stop(); // the "browser restarted": a different worker instance, a different session id
      await waitFor(async () => (await httpRequest({ port, path: "/health" })).json.extension.connected === false, { what: "old session to disconnect" });

      const after = await startRealExtension(port);
      try {
        assert.notEqual(after.sessionId, before.sessionId);
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, JSON.stringify(response.json));
        assert.equal(response.json.result.state, "stale");
        assert.equal(response.json.result.result.mutation, "none");
        assert.equal(response.json.result.result.code, "stale_session");
        noMutation(after);
        assert.deepEqual(after.calls.tabsGet, []);
        assert.deepEqual(after.calls.groupsGet, [], "the new session's browser was not even read");
        noMutation(before);
      } finally {
        after.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a tab that was grouped, or a group that was renamed or moved, after the preview is refused as stale and changes nothing", async () => {
  const scenarios = [
    ["tab grouped meanwhile", { operation: "create", tabId: 5, title: "x" }, (b) => (b.state.tabGroupId = 3)],
    ["tab moved to another window", { operation: "create", tabId: 5 }, (b) => (b.state.tabWindowId = 7)],
    ["tab pinned meanwhile", { operation: "create", tabId: 5 }, (b) => (b.state.tabPinned = true)],
    ["group renamed meanwhile", { operation: "update", groupId: 9, title: "New" }, (b) => (b.state.group.title = "Someone else's")],
    ["group recolored meanwhile", { operation: "update", groupId: 9, title: "New" }, (b) => (b.state.group.color = "red")],
    ["group moved to another window", { operation: "update", groupId: 9, title: "New" }, (b) => (b.state.group.windowId = 7)],
  ];
  for (const [name, body, change] of scenarios) {
    await withGroupService(
      async ({ port, preview, decide }) => {
        const extension = await startRealExtension(port);
        try {
          const action = await preview(body);
          change(extension);
          const response = await decide("approve", action.id);
          assert.equal(response.status, 200, name);
          assert.equal(response.json.result.state, "stale", `${name}: ${JSON.stringify(response.json.result)}`);
          assert.equal(response.json.result.result.mutation, "none", name);
          assert.equal(response.json.result.result.code, "state_mismatch", name);
          noMutation(extension);
        } finally {
          extension.stop();
        }
      },
      { connectExtension: false },
    );
  }
});

test("end to end: a closed tab or group after the preview is refused as a stale handle", async () => {
  await withGroupService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ operation: "create", tabId: 5 });
        extension.api.tabs.get = async () => {
          throw new Error("No tab with id: 5");
        };
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "stale");
        assert.equal(response.json.result.result.code, "stale_handle");
        noMutation(extension);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a browser without tab groups answers unsupported at preview, and an approved action there fails without mutation", async () => {
  await withGroupService(
    async ({ port, owner, decide, store }) => {
      const extension = await startRealExtension(port, mockBrowser({ supported: false }));
      try {
        for (const body of [{ operation: "create", tabId: 5 }, { operation: "update", groupId: 9, title: "x" }]) {
          const response = await owner("/api/action.configure_group.preview", { method: "POST", body });
          assert.equal(response.status, 501, JSON.stringify(response.json));
          assert.equal(response.json.error.code, "unsupported_feature");
        }
        assert.equal(store.listActions().total, 0);

        // Even a preview that somehow exists (made in another session, or by a
        // since-downgraded browser) executes as an explicit unsupported failure.
        const action = store.createAction({ kind: "configure_group", browserSessionId: extension.sessionId, binding: CREATE_BINDING });
        const approved = await decide("approve", action.id);
        assert.equal(approved.json.result.state, "failed");
        assert.equal(approved.json.result.result.mutation, "none");
        assert.equal(approved.json.result.result.code, "unsupported_feature");
        assert.deepEqual(extension.calls.tabsGet, [], "nothing in the browser was even read");
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a pinned tab is refused at preview, so it is never unpinned or reordered by grouping", async () => {
  await withGroupService(
    async ({ port, owner, store }) => {
      const browser = mockBrowser();
      browser.state.tabPinned = true;
      const extension = await startRealExtension(port, browser);
      try {
        const response = await owner("/api/action.configure_group.preview", { method: "POST", body: { operation: "create", tabId: 5, title: "x" } });
        assert.equal(response.status, 409, JSON.stringify(response.json));
        assert.equal(response.json.error.code, "conflict");
        assert.equal(store.listActions().total, 0);
        noMutation(extension);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a create keeps the tab in its own window even when the browser's current window is another one", async () => {
  await withGroupService(
    async ({ port, preview, decide }) => {
      const browser = mockBrowser();
      browser.state.tabWindowId = 7; // the tab lives in window 7; the mock's "current" window would be another
      const extension = await startRealExtension(port, browser);
      try {
        const action = await preview({ operation: "create", tabId: 5, title: "x" });
        assert.equal(action.binding.windowId, 7);
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "executed", JSON.stringify(response.json));
        assert.equal(response.json.result.result.windowId, 7);
        assert.deepEqual(extension.calls.group, [{ tabIds: [5], createProperties: { windowId: 7 } }]);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a create whose title/color update fails is a partial outcome with the new group's handle, and one group was made", async () => {
  await withGroupService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(
        port,
        mockBrowser({
          overrides: {
            update: async () => {
              throw new Error("No group with id: 9");
            },
          },
        }),
      );
      try {
        const action = await preview({ operation: "create", tabId: 5, title: "Work" });
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "partial");
        assert.equal(response.json.result.result.mutation, "created");
        assert.equal(response.json.result.result.code, "group_update_failed");
        assert.equal(response.json.result.result.groupId, 9);
        assert.equal(response.json.result.result.tabId, 5);
        assert.equal(response.json.result.result.observed, null);
        assert.equal(extension.calls.group.length, 1);
        assert.equal(extension.calls.update.length, 1);
        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(extension.calls.group.length, 1, "no retry");
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: the agent credential cannot configure a group by any route, and the browser is never asked to", async () => {
  await withGroupService(
    async ({ port, preview }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ operation: "update", groupId: 9, title: "x" });
        const readsBefore = extension.calls.groupsGet.length;
        for (const [path, body] of [
          [`/api/action.configure_group.approve?id=${action.id}`, undefined],
          ["/api/action.configure_group.preview", { operation: "update", groupId: 9, title: "y" }],
          ["/api/browser.configure_group", { operation: "update", groupId: 9, title: "y", browserSessionId: extension.sessionId }],
        ]) {
          const response = await httpRequest({ port, method: "POST", path, token: AGENT_TOKEN, body });
          assert.ok(response.status === 403 || response.status === 404, `${path} -> ${response.status}`);
        }
        noMutation(extension);
        assert.equal(extension.calls.groupsGet.length, readsBefore);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});
