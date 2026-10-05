// Phase 2 Action 3 ("move 1-100 selected tabs into an existing or new tab
// group"), service side: the action store's third kind (binding, results,
// append-only audit, migration v5, clear, restart reconciliation), the
// owner-only HTTP routes (preview binding, id-only approve/reject, stale/
// partial/failed/unsupported outcomes, handle comparison against a hostile
// extension, exactly-once execution), and the full path through the real
// extension worker and service client.
//
// Real service, real SQLite-backed store, and a real `ws` client standing in
// for the extension in the HTTP tests; the end-to-end section at the bottom
// replaces the stand-in with the real extension code over a stateful mock
// browser. Actions 1 and 2 are covered by test/actions.test.mjs and
// test/group-actions.test.mjs.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";

import { MAX_RESPONSE_BYTES, PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { createServiceClient } from "../extension/service-client.js";
import { createService } from "../service/server.mjs";
import { DATABASE_FILE_NAME, MIGRATIONS, openStore, runMigrations } from "../service/store.mjs";
import { ACTION_INTERRUPTED_DETAIL, ACTION_MUTATIONS, ACTION_RESULT_STATES, MAX_PENDING_ACTIONS } from "../service/validation.mjs";

const OWNER_TOKEN = "move-owner-token-0123456789";
const AGENT_TOKEN = "move-agent-token-0123456789";
const EXTENSION_ORIGIN = "chrome-extension://move-test-extension";
const SESSION_ID = "move-session";

// A bound tab: its id and the group it is in now. A stored move keeps nothing else.
const tabEntry = (tabId, groupId, extra = {}) => ({ tabId, groupId, ...extra });
const NEW_BINDING = { destination: "new", windowId: 2, tabs: [tabEntry(5, -1), tabEntry(6, 3)], title: "Work", color: "red" };
const EXISTING_BINDING = {
  destination: "existing",
  windowId: 2,
  tabs: [tabEntry(5, -1), tabEntry(6, 3)],
  groupId: 10,
  expectedTitle: "Dest",
  expectedColor: "blue",
};

async function withTempDir(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-moves-"));
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

const movePreview = (store, binding = NEW_BINDING, overrides = {}) =>
  store.createAction({ kind: "move_tabs", browserSessionId: SESSION_ID, binding, ...overrides });

const observedGroup = (overrides = {}) => ({ windowId: 2, title: "Work", color: "red", collapsed: false, ...overrides });

function movedResult(overrides = {}) {
  return { state: "executed", mutation: "moved", code: null, detail: null, tabIds: [5, 6], groupId: 20, windowId: 2, observed: observedGroup(), ...overrides };
}

function assertAuditContentFree(events) {
  const allowed = {
    kind: ["open_tab", "configure_group", "move_tabs"],
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
// Store: previews bind the exact tabs, their memberships, and the destination
// ---------------------------------------------------------------------------

test("createAction records a move preview bound to its tabs (with current group memberships), window, destination, and session, executing nothing", async () => {
  await withStore(async (store) => {
    const created = movePreview(store, NEW_BINDING);
    assert.equal(created.id, 1);
    assert.equal(created.kind, "move_tabs");
    assert.equal(created.url, null);
    assert.deepEqual(created.binding, NEW_BINDING);
    assert.equal(created.browserSessionId, SESSION_ID);
    assert.equal(created.state, "previewed");
    assert.equal(created.result, null);

    const existing = movePreview(store, EXISTING_BINDING);
    assert.deepEqual(existing.binding, EXISTING_BINDING);
    assert.deepEqual(store.listActions().items.map((a) => a.id), [2, 1]);
  });
});

test("a move binding with no title or color stores them as null", async () => {
  await withStore(async (store) => {
    const { title, color, ...rest } = NEW_BINDING;
    const action = movePreview(store, rest);
    assert.equal(action.binding.title, null);
    assert.equal(action.binding.color, null);
    assert.ok(title && color);
  });
});

test("a stored move keeps no tab title or address, whatever the input carried, and only the bound state", async () => {
  await withStore(async (store) => {
    const hostile = [
      tabEntry(5, -1, { title: "SECRET-TITLE", url: "https://secret.example/private", extra: "SECRET-EXTRA" }),
      tabEntry(6, 3, { title: "t".repeat(100_000), url: "u".repeat(100_000) }),
    ];
    for (const binding of [{ ...NEW_BINDING, tabs: hostile, note: "SECRET-NOTE" }, { ...EXISTING_BINDING, tabs: hostile, note: "SECRET-NOTE" }]) {
      const action = movePreview(store, binding);
      assert.deepEqual(action.binding.tabs, [{ tabId: 5, groupId: -1 }, { tabId: 6, groupId: 3 }]);
      assert.deepEqual(Object.keys(action.binding).sort(), Object.keys(binding.destination === "new" ? NEW_BINDING : EXISTING_BINDING).sort());
    }
    const raw = new DatabaseSync(store.dbPath);
    try {
      const rows = raw.prepare("SELECT binding FROM actions").all().map((row) => row.binding);
      for (const stored of rows) {
        assert.ok(!/SECRET|example\.com|"title":"t|"url"/.test(stored), `a stored binding holds no tab text: ${stored.slice(0, 120)}`);
        assert.ok(stored.length < 400, "and it is small");
      }
    } finally {
      raw.close();
    }
  });
});

test("createAction refuses an invalid move preview, leaving no record and no audit event", async () => {
  await withStore(async (store) => {
    const many = (n) => Array.from({ length: n }, (_, i) => tabEntry(i, -1));
    const bad = [
      undefined,
      null,
      "move",
      [],
      {},
      { ...NEW_BINDING, destination: "elsewhere" },
      { ...NEW_BINDING, windowId: undefined },
      { ...NEW_BINDING, tabs: [] },
      { ...NEW_BINDING, tabs: many(101) },
      { ...NEW_BINDING, tabs: [tabEntry(5, -1), tabEntry(5, -1)] },
      { ...NEW_BINDING, tabs: [tabEntry(-1, -1)] },
      { ...NEW_BINDING, tabs: [{ tabId: 5 }] },
      { ...NEW_BINDING, tabs: [tabEntry(5, -2)] },
      { ...NEW_BINDING, title: "" },
      { ...NEW_BINDING, title: "t".repeat(101) },
      { ...NEW_BINDING, title: "a\nb" },
      { ...NEW_BINDING, color: "gray" },
      { ...EXISTING_BINDING, title: "Renamed" },
      { ...EXISTING_BINDING, color: "red" },
      { ...EXISTING_BINDING, groupId: undefined },
      { ...EXISTING_BINDING, expectedTitle: undefined },
      { ...EXISTING_BINDING, expectedColor: "gray" },
      { ...EXISTING_BINDING, tabs: [tabEntry(5, 10), tabEntry(6, 10)] }, // a no-op move
    ];
    for (const binding of bad) {
      assert.throws(
        () => store.createAction({ kind: "move_tabs", browserSessionId: SESSION_ID, binding }),
        (e) => e.code === "validation_error",
        JSON.stringify(binding)?.slice(0, 80),
      );
    }
    for (const browserSessionId of [undefined, "", 5, "s".repeat(201)]) {
      assert.throws(() => movePreview(store, NEW_BINDING, { browserSessionId }), (e) => e.code === "validation_error");
    }
    assert.equal(store.listActions().total, 0);
    assert.equal(store.listActionAudit().total, 0);
    assert.doesNotThrow(() => movePreview(store, { ...NEW_BINDING, tabs: many(100) }), "100 tabs is allowed");
  });
});

test("a move action's bound fields are immutable even to raw SQL, and the table accepts no malformed kind/url/binding combination", async () => {
  await withStore(async (store) => {
    const { id } = movePreview(store);
    const raw = new DatabaseSync(store.dbPath);
    try {
      assert.throws(() => raw.exec(`UPDATE actions SET binding = '{}' WHERE id = ${id}`), /immutable/);
      assert.throws(() => raw.exec(`UPDATE actions SET kind = 'configure_group' WHERE id = ${id}`), /immutable/);
      assert.throws(() => raw.exec("INSERT INTO actions (kind, url, binding, browser_session_id, state, previewed_at) VALUES ('move_tabs', 'https://x/', '{}', 's', 'previewed', 0)"), /CHECK/);
      assert.throws(() => raw.exec("INSERT INTO actions (kind, browser_session_id, state, previewed_at) VALUES ('move_tabs', 's', 'previewed', 0)"), /CHECK/);
      assert.throws(() => raw.exec("INSERT INTO actions (kind, url, binding, browser_session_id, state, previewed_at) VALUES ('close_tabs', NULL, '{}', 's', 'previewed', 0)"), /CHECK/);
    } finally {
      raw.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Store: results
// ---------------------------------------------------------------------------

test("recordActionResult stores a move's result with its tab ids, group handle, and observed group", async () => {
  await withStore(async (store) => {
    const { id } = movePreview(store);
    store.decideAction(id, "approve");
    const done = store.recordActionResult(id, movedResult());
    assert.equal(done.state, "executed");
    assert.deepEqual(done.result, {
      mutation: "moved",
      code: null,
      detail: null,
      groupId: 20,
      tabIds: [5, 6],
      windowId: 2,
      observed: { windowId: 2, title: "Work", color: "red", collapsed: false },
    });
    assert.throws(() => store.recordActionResult(id, movedResult()), (e) => e.code === "conflict", "a result is recorded once");
  });
});

test("every move result state can be recorded with its own consistent shape", async () => {
  await withStore(async (store) => {
    const results = [
      movedResult(),
      { state: "partial", mutation: "moved", code: "group_update_failed", detail: "boom", tabIds: [5, 6], groupId: 20, windowId: 2 },
      { state: "partial", mutation: "moved", code: "observe_failed", tabIds: [5], groupId: null, windowId: 2 }, // an observed subset
      { state: "partial", mutation: "moved", code: "observe_failed", tabIds: null, groupId: 20, windowId: 2 }, // none observed / unavailable
      { state: "partial", mutation: "moved", code: "group_update_failed", windowId: 2 }, // ids omitted = null
      { state: "stale", mutation: "none", code: "state_mismatch" },
      { state: "failed", mutation: "none", code: "unsupported_feature" },
      { state: "failed", mutation: "unknown", code: "request_timeout" },
    ];
    for (const result of results) {
      const { id } = movePreview(store);
      store.decideAction(id, "approve");
      assert.equal(store.recordActionResult(id, result).state, result.state);
    }
  });
});

test("recordActionResult validates a move result: consistent state/mutation/handles/observation, bounded fields", async () => {
  await withStore(async (store) => {
    const { id } = movePreview(store);
    store.decideAction(id, "approve");
    const bad = [
      { ...movedResult(), mutation: "none" },
      { ...movedResult(), mutation: "created" },
      { ...movedResult(), mutation: "updated" },
      { ...movedResult(), mutation: "unknown" },
      { ...movedResult(), mutation: "bogus" },
      { ...movedResult(), observed: null },
      { ...movedResult(), tabIds: null },
      { ...movedResult(), tabIds: [] },
      { ...movedResult(), tabIds: Array.from({ length: 101 }, (_, i) => i) },
      { ...movedResult(), tabIds: [5, "6"] },
      { ...movedResult(), tabIds: [5, -1] },
      { ...movedResult(), tabIds: 5 },
      { ...movedResult(), groupId: null },
      { ...movedResult(), windowId: null },
      { ...movedResult(), observed: observedGroup({ collapsed: "no" }) },
      { ...movedResult(), observed: observedGroup({ windowId: -1 }) },
      { ...movedResult(), observed: observedGroup({ title: "t".repeat(501) }) },
      { ...movedResult(), observed: observedGroup({ color: "c".repeat(51) }) },
      { state: "partial", mutation: "none", code: "observe_failed", tabIds: [5], windowId: 2 },
      { state: "partial", mutation: "unknown", code: "observe_failed", tabIds: [5], windowId: 2 },
      { state: "partial", mutation: "moved", code: "observe_failed", tabIds: [] }, // a list is never empty (null says none)
      { state: "partial", mutation: "moved", code: "observe_failed", tabIds: [5] }, // a known move names its window
      { state: "partial", mutation: "moved", tabIds: [5], windowId: 2 }, // and has a code
      { state: "stale", mutation: "moved", code: "stale_session" },
      { state: "stale", mutation: "none", code: "stale_session", tabIds: [5] },
      { state: "stale", mutation: "none", code: "stale_session", groupId: 9 },
      { state: "failed", mutation: "moved", code: "x" },
      { state: "failed", mutation: "none", code: "x", windowId: 2 },
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

test("the other kinds still refuse the new mutation, and a move result cannot be recorded on them", async () => {
  await withStore(async (store) => {
    const tab = store.createAction({ url: "https://example.com/", browserSessionId: SESSION_ID });
    const group = store.createAction({
      kind: "configure_group",
      browserSessionId: SESSION_ID,
      binding: { operation: "create", tabId: 5, windowId: 2, title: "x", color: null, tabTitle: null, tabUrl: null },
    });
    store.decideAction(tab.id, "approve");
    store.decideAction(group.id, "approve");
    for (const id of [tab.id, group.id]) {
      assert.throws(() => store.recordActionResult(id, movedResult()), (e) => e.code === "validation_error");
      assert.throws(() => store.recordActionResult(id, { state: "failed", mutation: "moved", code: "x" }), (e) => e.code === "validation_error");
    }
    assert.equal(store.recordActionResult(tab.id, { state: "failed", mutation: "none", code: "x" }).state, "failed");
  });
});

// ---------------------------------------------------------------------------
// Store: audit, clear, reconciliation, bounds
// ---------------------------------------------------------------------------

test("the audit log records a move's events from server enums only, with no title, address, handle, color, or session", async () => {
  await withStore(async (store) => {
    const a = movePreview(store, {
      ...NEW_BINDING,
      title: "SECRET-TITLE",
      tabs: [tabEntry(5, -1, { title: "SECRET-TAB-TITLE", url: "https://secret.example/private" }), tabEntry(6, 3)],
    });
    store.decideAction(a.id, "approve");
    store.recordActionResult(a.id, movedResult({ observed: observedGroup({ title: "SECRET-TITLE", color: "secret-color" }) }));
    const b = movePreview(store, EXISTING_BINDING);
    store.decideAction(b.id, "reject");

    const events = store.listActionAudit({ limit: 200 }).items;
    assert.deepEqual(events.filter((e) => e.actionId === a.id).map((e) => [e.event, e.detail]).reverse(), [
      ["preview", { kind: "move_tabs" }],
      ["approve", { decision: "approve" }],
      ["result", { state: "executed", mutation: "moved" }],
    ]);
    assertAuditContentFree(events);
    const text = JSON.stringify(events);
    for (const secret of ["SECRET", "secret", "example.com", "Work", "Dest", "blue", SESSION_ID]) {
      assert.ok(!text.includes(secret), `the audit log must not contain ${secret}`);
    }
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["actionId", "detail", "event", "id", "occurredAt"]);
  });
});

test("store.clear removes move action records (their bindings and results) but never the audit log; ids are not reused", async () => {
  await withStore(async (store) => {
    const a = movePreview(store, { ...NEW_BINDING, tabs: [tabEntry(5, -1, { title: "RETAINED-TITLE" })] });
    assert.ok(!JSON.stringify(store.listActions()).includes("RETAINED-TITLE"), "a tab title is not even stored");
    store.decideAction(a.id, "approve");
    store.recordActionResult(a.id, movedResult());
    const auditBefore = store.listActionAudit().items;
    assert.equal(store.clearAll().deletedCounts.actions, 1);
    assert.equal(store.listActions().total, 0);
    assert.deepEqual(store.listActionAudit().items, auditBefore);
    assert.equal(movePreview(store).id, a.id + 1);
  });
});

test("store.clear is refused while a move is approved and awaiting its result", async () => {
  await withStore(async (store) => {
    const a = movePreview(store);
    store.decideAction(a.id, "approve");
    assert.throws(() => store.clearAll(), (e) => e.code === "conflict");
    store.recordActionResult(a.id, movedResult());
    assert.doesNotThrow(() => store.clearAll());
  });
});

test("reconcileInterruptedActions fails a move found approved, with an unknown outcome and a result event", async () => {
  await withTempDir(async (dataDir) => {
    let store = await openStore({ dataDir });
    const move = movePreview(store);
    store.decideAction(move.id, "approve");
    store.close();

    store = await openStore({ dataDir });
    try {
      assert.deepEqual(store.reconcileInterruptedActions(), { reconciledCount: 1 });
      const action = store.listActions({ id: move.id }).items[0];
      assert.equal(action.state, "failed");
      assert.deepEqual(action.result, {
        mutation: "unknown",
        code: "interrupted_by_restart",
        detail: ACTION_INTERRUPTED_DETAIL,
        groupId: null,
        tabIds: null,
        windowId: null,
        observed: null,
      });
      assert.deepEqual(store.listActionAudit({ actionId: move.id }).items[0].detail, { state: "failed", mutation: "unknown" });
    } finally {
      store.close();
    }
  });
});

test("move previews share the pending bound with the other kinds", async () => {
  await withStore(async (store) => {
    for (let i = 0; i < MAX_PENDING_ACTIONS - 1; i += 1) store.createAction({ url: `https://example.com/${i}`, browserSessionId: SESSION_ID });
    assert.doesNotThrow(() => movePreview(store));
    assert.throws(() => movePreview(store), (e) => e.code === "limit_reached");
  });
});

// ---------------------------------------------------------------------------
// Store: migration v5 (rebuilds `actions` again, keeping rows, ids, and audit)
// ---------------------------------------------------------------------------

test("the migration chain through v6 keeps tab and group actions (with their bindings), continues the id counter, and leaves the audit log untouched", async () => {
  await withTempDir(async (dataDir) => {
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const raw = new DatabaseSync(dbPath);
    try {
      runMigrations(raw, dbPath, () => {}, MIGRATIONS.slice(0, 4));
      raw.exec("INSERT INTO actions (kind, url, browser_session_id, state, previewed_at) VALUES ('open_tab', 'https://example.com/a', 's', 'previewed', 10)");
      raw
        .prepare("INSERT INTO actions (kind, binding, browser_session_id, state, previewed_at, decided_at, completed_at, result) VALUES ('configure_group', ?, 's', 'executed', 10, 11, 12, ?)")
        .run(JSON.stringify({ operation: "create", tabId: 5, windowId: 2, title: "x", color: null }), JSON.stringify({ mutation: "created", code: null, detail: null, tabId: 5, groupId: 9, windowId: 2, observed: null }));
      raw.exec("INSERT INTO actions (kind, url, browser_session_id, state, previewed_at) VALUES ('open_tab', 'https://example.com/c', 's', 'previewed', 10)");
      raw.exec("DELETE FROM actions WHERE id = 3"); // the counter is now ahead of the highest remaining id
      raw.exec("INSERT INTO action_audit (action_id, event, occurred_at, detail) VALUES (3, 'preview', 10, '{\"kind\":\"open_tab\"}')");
      assert.equal(raw.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 4);
    } finally {
      raw.close();
    }

    const store = await openStore({ dataDir });
    try {
      const items = store.listActions().items;
      assert.deepEqual(items.map((a) => [a.id, a.kind, a.url, a.state]), [
        [2, "configure_group", null, "executed"],
        [1, "open_tab", "https://example.com/a", "previewed"],
      ]);
      assert.deepEqual(items[0].binding, { operation: "create", tabId: 5, windowId: 2, title: "x", color: null });
      assert.equal(items[0].result.groupId, 9);
      assert.equal(items[1].binding, null);
      assert.equal(movePreview(store).id, 4, "ids already used (and named by the audit log) are not reused");
      assert.equal(store.listActionAudit({ actionId: 3 }).total, 1);
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

test("migration v5 on a database whose actions were all cleared still keeps the id counter", async () => {
  await withTempDir(async (dataDir) => {
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const raw = new DatabaseSync(dbPath);
    try {
      runMigrations(raw, dbPath, () => {}, MIGRATIONS.slice(0, 4));
      for (let i = 0; i < 3; i += 1) raw.exec("INSERT INTO actions (kind, url, browser_session_id, state, previewed_at) VALUES ('open_tab', 'https://example.com/', 's', 'previewed', 0)");
      raw.exec("DELETE FROM actions");
    } finally {
      raw.close();
    }
    const store = await openStore({ dataDir });
    try {
      assert.equal(movePreview(store).id, 4);
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

// Tab 6 is in group 3; every other tab is ungrouped; all in window 2.
function inspectedTabs(tabIds, overrides = {}) {
  return tabIds.map((tabId) => ({
    tabId,
    windowId: 2,
    groupId: tabId === 6 ? 3 : -1,
    pinned: false,
    title: `Tab ${tabId}`,
    url: `https://example.com/${tabId}`,
    ...overrides,
  }));
}

function inspectResult(params, overrides = {}) {
  return {
    ...envelope("browser.inspect_move_target"),
    tabs: inspectedTabs(params.tabIds),
    group: params.groupId === undefined ? null : { groupId: params.groupId, windowId: 2, title: "Dest", color: "blue", collapsed: false },
    ...overrides,
  };
}

// A well-formed answer for whatever `params` the service sent.
function moveResult(params, overrides = {}) {
  const existing = params.destination === "existing";
  const groupId = existing ? params.groupId : 20;
  return {
    ...envelope("browser.move_tabs"),
    changed: true,
    destination: params.destination,
    group: { groupId, windowId: params.windowId, title: existing ? params.expectedTitle : (params.title ?? ""), color: existing ? params.expectedColor : (params.color ?? "grey"), collapsed: false },
    tabs: params.tabs.map((tab) => ({ tabId: tab.tabId, windowId: params.windowId, groupId })),
    ...overrides,
  };
}

const refusal = (code, extra = {}) => ({ ...envelope("browser.move_tabs", "error"), code, changed: false, ...extra });
const partialResult = (params, overrides = {}) => ({
  ...envelope("browser.move_tabs", "incomplete"),
  code: "observe_failed",
  changed: true,
  groupId: params.destination === "existing" ? params.groupId : 20,
  windowId: params.windowId,
  tabIds: params.tabs.map((tab) => tab.tabId),
  ...overrides,
});

const NO_RESPONSE = Symbol("no response");

function installExtensionFake(ws, { inspect = inspectResult, move = moveResult, delayMs = 0 } = {}) {
  ws.requests = [];
  ws.on("message", async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") return;
    ws.requests.push({ method: message.method, params: message.params });
    let result;
    if (message.method === "browser.inspect_move_target") {
      result = await inspect(message.params, ws);
    } else if (message.method === "browser.move_tabs") {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await move(message.params, ws);
    } else {
      result = { ...envelope(message.method, "error"), code: "unsupported_in_test_fake" };
    }
    if (result === NO_RESPONSE) return;
    ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result }));
  });
}

const requestsOf = (ws, method) => ws.requests.filter((r) => r.method === method);
const moveRequests = (ws) => requestsOf(ws, "browser.move_tabs");

const NEW_BODY = { tabIds: [5, 6], destination: "new", title: "Work", color: "red" };
const EXISTING_BODY = { tabIds: [5, 6], destination: "existing", groupId: 10 };

async function withMoveService(run, { extension = {}, connectExtension = true, ...serviceOptions } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-moves-http-"));
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
    async preview(body = NEW_BODY) {
      const response = await owner("/api/action.move_tabs.preview", { method: "POST", body });
      assert.equal(response.status, 200, JSON.stringify(response.json));
      return response.json.result;
    },
    decide: (operation, id) => owner(`/api/action.move_tabs.${operation}?id=${id}`, { method: "POST" }),
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

test("preview of a move into a new group binds the exact tabs with their current groups, the window, the change, and the extension's own session, and changes nothing", async () => {
  await withMoveService(async ({ preview, ws, owner }) => {
    const action = await preview(NEW_BODY);
    assert.equal(action.id, 1);
    assert.equal(action.kind, "move_tabs");
    assert.equal(action.state, "previewed");
    assert.equal(action.url, null);
    assert.equal(action.browserSessionId, SESSION_ID, "the session is the extension's own");
    assert.deepEqual(action.binding, NEW_BINDING);
    assert.deepEqual(ws.requests, [{ method: "browser.inspect_move_target", params: { tabIds: [5, 6] } }], "one read-only look; nothing changed");
    assert.deepEqual((await owner("/api/store.actions.list")).json.result.items, [action]);
  });
});

test("preview of a move into an existing group binds the group's window, title, and color, and asks about that group", async () => {
  await withMoveService(async ({ preview, ws }) => {
    const action = await preview(EXISTING_BODY);
    assert.deepEqual(action.binding, EXISTING_BINDING);
    assert.deepEqual(ws.requests, [{ method: "browser.inspect_move_target", params: { tabIds: [5, 6], groupId: 10 } }]);
  });
});

test("preview binds tabs in the order given, and allows a tab already in the destination as long as another is not", async () => {
  await withMoveService(
    async ({ preview }) => {
      const reordered = await preview({ tabIds: [6, 5], destination: "new" });
      assert.deepEqual(reordered.binding.tabs.map((t) => t.tabId), [6, 5]);
      assert.equal(reordered.binding.title, null);
      assert.equal(reordered.binding.color, null);
      const some = await preview({ tabIds: [6, 5], destination: "existing", groupId: 3 });
      assert.deepEqual(some.binding.tabs.map((t) => [t.tabId, t.groupId]), [[6, 3], [5, -1]]);
    },
    { extension: { inspect: (params) => inspectResult(params, { group: params.groupId === undefined ? null : { groupId: params.groupId, windowId: 2, title: "Src", color: "red", collapsed: false } }) } },
  );
});

test("preview accepts 100 tabs and refuses 101", async () => {
  await withMoveService(async ({ owner, preview, ws, store }) => {
    const tabIds = Array.from({ length: 100 }, (_, i) => 100 + i);
    const action = await preview({ tabIds, destination: "new" });
    assert.equal(action.binding.tabs.length, 100);
    const response = await owner("/api/action.move_tabs.preview", { method: "POST", body: { tabIds: [...tabIds, 200], destination: "new" } });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_error");
    assert.equal(ws.requests.length, 1);
    assert.equal(store.listActions().total, 1);
  });
});

test("the maximum 50 pending previews, each naming 100 tabs with the largest ids, still list successfully far under the response cap", async () => {
  const base = 9_000_000_000_000_000; // near Number.MAX_SAFE_INTEGER: the widest ids a handle can have
  const widest = (params) => inspectResult(params, { tabs: inspectedTabs(params.tabIds, { groupId: base + 1 }) });
  await withMoveService(
    async ({ preview, owner, store }) => {
      for (let n = 0; n < MAX_PENDING_ACTIONS; n += 1) {
        const tabIds = Array.from({ length: 100 }, (_, i) => base + n * 100 + i);
        const action = await preview({ tabIds, destination: "new", title: "t".repeat(100), color: "orange" });
        assert.equal(action.binding.tabs.length, 100);
      }
      assert.equal(store.listActions({ limit: 200 }).total, MAX_PENDING_ACTIONS);
      const refused = await owner("/api/action.move_tabs.preview", { method: "POST", body: { tabIds: [1], destination: "new" } });
      assert.equal(refused.status, 409, "the pending bound is what keeps this list bounded");

      // Exactly what the review UI asks for: its page limit of 50, newest first.
      const listed = await owner("/api/store.actions.list?limit=50");
      assert.equal(listed.status, 200, JSON.stringify(listed.json).slice(0, 200));
      assert.equal(listed.json.result.items.length, MAX_PENDING_ACTIONS);
      assert.equal(listed.json.result.total, MAX_PENDING_ACTIONS);
      for (const item of listed.json.result.items) {
        assert.equal(item.binding.tabs.length, 100);
        assert.deepEqual(Object.keys(item.binding.tabs[0]).sort(), ["groupId", "tabId"], "no tab title or address is stored or listed");
      }
      const bytes = Buffer.byteLength(JSON.stringify(listed.json));
      assert.ok(bytes < MAX_RESPONSE_BYTES / 4, `the full pending list is ${bytes} bytes, far under the ${MAX_RESPONSE_BYTES}-byte cap`);
      const all = await owner("/api/store.actions.list?limit=200");
      assert.equal(all.status, 200);
    },
    { extension: { inspect: widest } },
  );
});

test("preview accepts only tab ids and a destination, and contacts the extension for nothing else", async () => {
  await withMoveService(async ({ owner, ws, store }) => {
    const bodies = [
      { rawBody: "" },
      { rawBody: "not json" },
      { rawBody: "[]" },
      { rawBody: "null" },
      { body: {} },
      { body: { tabIds: [5] } },
      { body: { destination: "new" } },
      { body: { tabIds: [5], destination: "elsewhere" } },
      { body: { tabIds: [5], destination: "existing" } },
      { body: { tabIds: [], destination: "new" } },
      { body: { tabIds: 5, destination: "new" } },
      { body: { tabIds: "5", destination: "new" } },
      { body: { tabIds: [5, 5], destination: "new" } },
      { body: { tabIds: [5, -1], destination: "new" } },
      { body: { tabIds: [5, "6"], destination: "new" } },
      { body: { tabIds: [5, 1.5], destination: "new" } },
      { body: { tabIds: [5, null], destination: "new" } },
      { body: { tabIds: [5], destination: "new", groupId: 10 } },
      { body: { tabIds: [5], destination: "existing", groupId: -1 } },
      { body: { tabIds: [5], destination: "existing", groupId: "10" } },
      { body: { tabIds: [5], destination: "existing", groupId: 10, title: "x" } },
      { body: { tabIds: [5], destination: "existing", groupId: 10, color: "red" } },
      { body: { tabIds: [5], destination: "new", browserSessionId: SESSION_ID } },
      { body: { tabIds: [5], destination: "new", windowId: 2 } },
      { body: { tabIds: [5], destination: "new", tabs: [{ tabId: 5, groupId: -1 }] } },
      { body: { tabIds: [5], destination: "new", extra: 1 } },
      { body: { tabIds: [5], destination: "new", title: 5 } },
      { body: { tabIds: [5], destination: "new", title: null } },
      { body: { tabIds: [5], destination: "new", title: "" } },
      { body: { tabIds: [5], destination: "new", title: "t".repeat(101) } },
      { body: { tabIds: [5], destination: "new", title: "line\nbreak" } },
      { body: { tabIds: [5], destination: "new", color: "gray" } },
      { body: { tabIds: [5], destination: "new", color: null } },
    ];
    for (const input of bodies) {
      const response = await owner("/api/action.move_tabs.preview", { method: "POST", ...input });
      assert.equal(response.status, 400, `${JSON.stringify(input).slice(0, 90)} -> ${response.status} ${JSON.stringify(response.json)}`);
      assert.match(response.json.error.code, /^(validation_error|malformed_body)$/);
    }
    assert.equal(ws.requests.length, 0, "an invalid preview never reaches the extension");
    assert.equal(store.listActions().total, 0);
    assert.equal(store.listActionAudit().total, 0);
  });
});

test("preview refuses an oversized body as 413", async () => {
  await withMoveService(async ({ owner, ws }) => {
    const response = await owner("/api/action.move_tabs.preview", {
      method: "POST",
      rawBody: JSON.stringify({ tabIds: [5], destination: "new", title: "t".repeat(40_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal(ws.requests.length, 0);
  });
});

test("preview is refused as a conflict, storing nothing, for a pinned tab, tabs in two windows, or a destination in another window", async () => {
  const cases = {
    "a pinned tab": [NEW_BODY, (params) => ({ ...inspectResult(params), tabs: inspectedTabs(params.tabIds).map((t) => ({ ...t, pinned: t.tabId === 6 })) }), /pinned/],
    "tabs in two windows": [NEW_BODY, (params) => ({ ...inspectResult(params), tabs: inspectedTabs(params.tabIds).map((t) => ({ ...t, windowId: t.tabId === 6 ? 4 : 2 })) }), /one window/],
    "a destination group in another window": [
      EXISTING_BODY,
      (params) => inspectResult(params, { group: { groupId: 10, windowId: 4, title: "Dest", color: "blue", collapsed: false } }),
      /destination group is not in/,
    ],
  };
  for (const [name, [body, inspect, pattern]] of Object.entries(cases)) {
    await withMoveService(
      async ({ owner, store, ws }) => {
        const response = await owner("/api/action.move_tabs.preview", { method: "POST", body });
        assert.equal(response.status, 409, `${name}: ${JSON.stringify(response.json)}`);
        assert.equal(response.json.error.code, "conflict");
        assert.match(response.json.error.detail, pattern);
        assert.equal(store.listActions().total, 0);
        assert.equal(store.listActionAudit().total, 0);
        assert.deepEqual(ws.requests.map((r) => r.method), ["browser.inspect_move_target"], "and never reaches the mutation");
      },
      { extension: { inspect } },
    );
  }
});

test("preview of a move into an existing group where every tab is already in it is a validation error, storing nothing", async () => {
  await withMoveService(
    async ({ owner, store }) => {
      const response = await owner("/api/action.move_tabs.preview", { method: "POST", body: { tabIds: [5, 7], destination: "existing", groupId: 10 } });
      assert.equal(response.status, 400);
      assert.equal(response.json.error.code, "validation_error");
      assert.equal(store.listActions().total, 0);
    },
    { extension: { inspect: (params) => inspectResult(params, { tabs: inspectedTabs(params.tabIds, { groupId: 10 }) }) } },
  );
});

test("preview reports a missing handle as stale_handle (409) and a browser without tab groups as unsupported_feature (501), storing nothing", async () => {
  const cases = [
    ["stale_handle", 409, { ...envelope("browser.inspect_move_target", "error"), code: "stale_handle" }],
    ["unsupported_feature", 501, { ...envelope("browser.inspect_move_target", "unsupported"), code: "unsupported_feature" }],
  ];
  for (const [code, status, answer] of cases) {
    for (const body of [NEW_BODY, EXISTING_BODY]) {
      await withMoveService(
        async ({ owner, store }) => {
          const response = await owner("/api/action.move_tabs.preview", { method: "POST", body });
          assert.equal(response.status, status, JSON.stringify(response.json));
          assert.equal(response.json.error.code, code);
          assert.equal(store.listActions().total, 0);
        },
        { extension: { inspect: () => answer } },
      );
    }
  }
});

test("preview rejects an inspect answer that is malformed, for other tabs or another group, or an unexpected error", async () => {
  const answers = {
    garbage: () => ({ garbage: true }),
    "a legacy-shaped array": () => [],
    "a tab omitting pinned": (p) => inspectResult(p, { tabs: inspectedTabs(p.tabIds).map(({ pinned, ...rest }) => rest) }),
    "a tab with an invalid group id": (p) => inspectResult(p, { tabs: inspectedTabs(p.tabIds, { groupId: -2 }) }),
    "fewer tabs than requested": (p) => inspectResult(p, { tabs: inspectedTabs(p.tabIds.slice(1)) }),
    "more tabs than requested": (p) => inspectResult(p, { tabs: inspectedTabs([...p.tabIds, 99]) }),
    "tabs in another order": (p) => inspectResult(p, { tabs: inspectedTabs([...p.tabIds].reverse()) }),
    "other tabs": (p) => inspectResult(p, { tabs: inspectedTabs(p.tabIds.map((id) => id + 100)) }),
    "an unexpected error code": () => ({ ...envelope("browser.inspect_move_target", "error"), code: "internal_error" }),
    "a result for the wrong method": (p) => inspectResult(p, { sourceOperation: "browser.list_tabs" }),
  };
  for (const [name, inspect] of Object.entries(answers)) {
    await withMoveService(
      async ({ owner, store }) => {
        const response = await owner("/api/action.move_tabs.preview", { method: "POST", body: NEW_BODY });
        assert.equal(response.status, 502, `${name}: ${JSON.stringify(response.json)}`);
        assert.equal(response.json.error.code, "invalid_extension_response");
        assert.equal(store.listActions().total, 0, name);
      },
      { extension: { inspect } },
    );
  }
  const groupAnswers = {
    "a different group": (p) => inspectResult(p, { group: { groupId: 11, windowId: 2, title: "Dest", color: "blue", collapsed: false } }),
    "no group for an existing destination": (p) => inspectResult(p, { group: null }),
    "a group with a non-native color": (p) => inspectResult(p, { group: { groupId: 10, windowId: 2, title: "Dest", color: "mauve", collapsed: false } }),
  };
  for (const [name, inspect] of Object.entries(groupAnswers)) {
    await withMoveService(
      async ({ owner, store }) => {
        const response = await owner("/api/action.move_tabs.preview", { method: "POST", body: EXISTING_BODY });
        assert.equal(response.status, 502, `${name}: ${JSON.stringify(response.json)}`);
        assert.equal(store.listActions().total, 0, name);
      },
      { extension: { inspect } },
    );
  }
  // And a group reported for a new-group request is not what was asked.
  await withMoveService(
    async ({ owner }) => {
      const response = await owner("/api/action.move_tabs.preview", { method: "POST", body: NEW_BODY });
      assert.equal(response.status, 502);
    },
    { extension: { inspect: (p) => inspectResult(p, { group: { groupId: 10, windowId: 2, title: "Dest", color: "blue", collapsed: false } }) } },
  );
});

test("preview fails explicitly as disconnected when no extension is connected, storing nothing", async () => {
  await withMoveService(
    async ({ owner, store }) => {
      const response = await owner("/api/action.move_tabs.preview", { method: "POST", body: NEW_BODY });
      assert.equal(response.status, 503);
      assert.equal(response.json.error.code, "disconnected");
      assert.equal(store.listActions().total, 0);
    },
    { connectExtension: false },
  );
});

test("preview is refused with limit_reached once too many previews await a decision", async () => {
  await withMoveService(async ({ preview, owner }) => {
    for (let i = 0; i < MAX_PENDING_ACTIONS; i += 1) await preview(NEW_BODY);
    const response = await owner("/api/action.move_tabs.preview", { method: "POST", body: NEW_BODY });
    assert.equal(response.status, 409);
    assert.equal(response.json.error.code, "limit_reached");
  });
});

// ---------------------------------------------------------------------------
// HTTP: authorization — the owner alone, and no direct mutation route
// ---------------------------------------------------------------------------

test("every move action route rejects a missing or wrong credential, and the external-agent credential with 403, reaching nothing", async () => {
  await withMoveService(async ({ port, preview, ws, store }) => {
    const action = await preview();
    const requestsBefore = ws.requests.length;
    const routes = [
      { method: "POST", path: "/api/action.move_tabs.preview", body: NEW_BODY },
      { method: "POST", path: `/api/action.move_tabs.approve?id=${action.id}` },
      { method: "POST", path: `/api/action.move_tabs.reject?id=${action.id}` },
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

test("browser.move_tabs and browser.inspect_move_target have no HTTP route at all, for either credential, as a GET or a POST", async () => {
  await withMoveService(async ({ port, ws }) => {
    for (const token of [OWNER_TOKEN, AGENT_TOKEN]) {
      for (const method of ["GET", "POST"]) {
        for (const path of [
          `/api/browser.move_tabs?destination=new&windowId=2&browserSessionId=${SESSION_ID}`,
          "/api/browser.inspect_move_target?tabIds=5",
          "/api/browser.group_tabs",
          "/api/action.move_tabs",
          "/api/action.move_tabs.execute?id=1",
          "/api/action.move_tabs.move?id=1",
          "/api/action.close_tabs.preview",
          "/api/workflow.move_tabs",
        ]) {
          const response = await httpRequest({ port, path, method, token, body: method === "POST" ? NEW_BODY : undefined });
          assert.equal(response.status, 404, `${method} ${path} as ${token === OWNER_TOKEN ? "owner" : "agent"} -> ${response.status}`);
        }
      }
    }
    assert.equal(ws.requests.length, 0);
  });
});

test("the move action routes accept only POST", async () => {
  await withMoveService(async ({ owner, preview, store }) => {
    const action = await preview();
    for (const method of ["GET", "PATCH", "DELETE", "PUT"]) {
      for (const path of ["preview", `approve?id=${action.id}`, `reject?id=${action.id}`]) {
        assert.equal((await owner(`/api/action.move_tabs.${path}`, { method })).status, 405, `${method} ${path}`);
      }
    }
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed");
  });
});

test("a request using the previous protocol version (4) is rejected before any move route runs, and so is an extension speaking it", async () => {
  await withMoveService(async ({ port, ws }) => {
    const response = await httpRequest({
      port,
      method: "POST",
      path: "/api/action.move_tabs.preview",
      token: OWNER_TOKEN,
      body: NEW_BODY,
      extraHeaders: { "x-protocol-version": "4" },
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
    old.send(JSON.stringify({ type: "auth", protocolVersion: 4, token: OWNER_TOKEN }));
    const message = await reply;
    assert.equal(message.type, "auth_error");
    assert.equal(message.code, "unsupported_protocol_version");
    old.close();
  });
});

// ---------------------------------------------------------------------------
// HTTP: approve / reject
// ---------------------------------------------------------------------------

test("approving a move into a new group sends exactly the previewed tabs, window, and change once, and records the observed group", async () => {
  await withMoveService(async ({ preview, decide, ws, owner }) => {
    const action = await preview(NEW_BODY);
    const response = await decide("approve", action.id);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const done = response.json.result;
    assert.equal(done.id, action.id);
    assert.equal(done.state, "executed");
    assert.deepEqual(done.binding, action.binding);
    assert.equal(done.browserSessionId, action.browserSessionId);
    assert.ok(done.decidedAt >= done.previewedAt && done.completedAt >= done.decidedAt);
    assert.deepEqual(done.result, {
      mutation: "moved",
      code: null,
      detail: null,
      tabIds: [5, 6],
      groupId: 20,
      windowId: 2,
      observed: { windowId: 2, title: "Work", color: "red", collapsed: false },
    });
    const sent = moveRequests(ws);
    assert.equal(sent.length, 1, "exactly one browser.move_tabs request");
    assert.deepEqual(sent[0].params, {
      browserSessionId: SESSION_ID,
      destination: "new",
      windowId: 2,
      tabs: [{ tabId: 5, groupId: -1 }, { tabId: 6, groupId: 3 }],
      title: "Work",
      color: "red",
    });
    const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
    assert.deepEqual(audit.map((e) => e.event), ["result", "approve", "preview"]);
    assert.deepEqual(audit[0].detail, { state: "executed", mutation: "moved" });
  });
});

test("approving a move into an existing group sends the group's bound window, title, and color for the extension to re-check", async () => {
  await withMoveService(async ({ preview, decide, ws }) => {
    const action = await preview(EXISTING_BODY);
    const response = await decide("approve", action.id);
    assert.equal(response.json.result.state, "executed", JSON.stringify(response.json));
    assert.deepEqual(response.json.result.result, {
      mutation: "moved",
      code: null,
      detail: null,
      tabIds: [5, 6],
      groupId: 10,
      windowId: 2,
      observed: { windowId: 2, title: "Dest", color: "blue", collapsed: false },
    });
    assert.deepEqual(moveRequests(ws).map((r) => r.params), [
      {
        browserSessionId: SESSION_ID,
        destination: "existing",
        windowId: 2,
        tabs: [{ tabId: 5, groupId: -1 }, { tabId: 6, groupId: 3 }],
        groupId: 10,
        expectedTitle: "Dest",
        expectedColor: "blue",
      },
    ]);
  });
});

test("a decided move can never be decided or executed again", async () => {
  await withMoveService(async ({ preview, decide, ws }) => {
    const action = await preview();
    assert.equal((await decide("approve", action.id)).status, 200);
    for (const operation of ["approve", "reject", "approve"]) {
      const again = await decide(operation, action.id);
      assert.equal(again.status, 409, operation);
      assert.equal(again.json.error.code, "conflict");
    }
    assert.equal(moveRequests(ws).length, 1, "no duplicate execution");
  });
});

test("approve and reject take the action id alone: no body, no other parameter, a valid id", async () => {
  await withMoveService(async ({ owner, preview, ws, store }) => {
    const action = await preview();
    for (const operation of ["approve", "reject"]) {
      const attempts = [
        { path: `/api/action.move_tabs.${operation}?id=${action.id}`, body: { tabIds: [7] } },
        { path: `/api/action.move_tabs.${operation}?id=${action.id}`, rawBody: "{}" },
        { path: `/api/action.move_tabs.${operation}?id=${action.id}&tabIds=7` },
        { path: `/api/action.move_tabs.${operation}?id=${action.id}&groupId=1` },
        { path: `/api/action.move_tabs.${operation}?id=${action.id}&browserSessionId=other` },
        { path: `/api/action.move_tabs.${operation}` },
        { path: `/api/action.move_tabs.${operation}?id=` },
        { path: `/api/action.move_tabs.${operation}?id=0` },
        { path: `/api/action.move_tabs.${operation}?id=-1` },
        { path: `/api/action.move_tabs.${operation}?id=abc` },
        { path: `/api/action.move_tabs.${operation}?tabIds=5` },
      ];
      for (const { path, ...input } of attempts) {
        const response = await owner(path, { method: "POST", ...input });
        assert.equal(response.status, 400, `${operation} ${path} ${JSON.stringify(input)} -> ${response.status}`);
        assert.equal(response.json.error.code, "validation_error");
      }
    }
    assert.equal(moveRequests(ws).length, 0);
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed", "none of the refused requests decided anything");
    assert.equal(store.listActionAudit({ actionId: action.id }).total, 1);
  });
});

test("approve and reject of an unknown action id are 404 and change nothing", async () => {
  await withMoveService(async ({ decide, ws }) => {
    for (const operation of ["approve", "reject"]) {
      const response = await decide(operation, 12345);
      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, "not_found");
    }
    assert.equal(moveRequests(ws).length, 0);
  });
});

test("each route decides only its own kind: a tab or group action's id on the move route (and the reverse) is a 404 that decides nothing", async () => {
  await withMoveService(async ({ preview, decide, owner, ws, store }) => {
    const move = await preview();
    const tab = store.createAction({ url: "https://example.com/", browserSessionId: SESSION_ID });
    const group = store.createAction({
      kind: "configure_group",
      browserSessionId: SESSION_ID,
      binding: { operation: "create", tabId: 5, windowId: 2, title: "x", color: null, tabTitle: null, tabUrl: null },
    });
    for (const operation of ["approve", "reject"]) {
      assert.equal((await decide(operation, tab.id)).status, 404, `move ${operation} of a tab action`);
      assert.equal((await decide(operation, group.id)).status, 404, `move ${operation} of a group action`);
      assert.equal((await owner(`/api/action.open_tab.${operation}?id=${move.id}`, { method: "POST" })).status, 404);
      assert.equal((await owner(`/api/action.configure_group.${operation}?id=${move.id}`, { method: "POST" })).status, 404);
    }
    for (const action of [move, tab, group]) assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed");
    assert.equal(ws.requests.filter((r) => r.method !== "browser.inspect_move_target").length, 0, "nothing was sent to the browser");
  });
});

test("reject records the decision and changes nothing, and a rejected preview cannot then be approved", async () => {
  await withMoveService(async ({ preview, decide, ws, owner }) => {
    const action = await preview();
    const response = await decide("reject", action.id);
    assert.equal(response.status, 200);
    assert.equal(response.json.result.state, "rejected");
    assert.equal(response.json.result.result, null);
    assert.equal((await decide("approve", action.id)).status, 409);
    assert.equal(moveRequests(ws).length, 0, "a rejected preview is never executed");
    const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
    assert.deepEqual(audit.map((e) => e.event), ["reject", "preview"]);
  });
});

test("approve while the extension is disconnected is refused without consuming the preview", async () => {
  await withMoveService(async ({ preview, decide, ws, store, port }) => {
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
    await withMoveService(
      async ({ preview, decide, ws, owner }) => {
        const action = await preview();
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, code);
        assert.equal(response.json.result.state, "stale", code);
        assert.deepEqual(response.json.result.result, { mutation: "none", code, detail: "since the preview", tabIds: null, groupId: null, windowId: null, observed: null });
        assert.equal((await decide("approve", action.id)).status, 409, "a stale action is terminal; a new preview is needed");
        assert.equal(moveRequests(ws).length, 1, "and is not retried");
        const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
        assert.deepEqual(audit[0].detail, { state: "stale", mutation: "none" });
      },
      { extension: { move: () => refusal(code, { detail: "since the preview" }) } },
    );
  }
});

test("a browser without tab groups, or any other refusal that changed nothing, is a terminal 'failed' outcome with mutation none", async () => {
  const cases = [
    ["unsupported_feature", { ...envelope("browser.move_tabs", "unsupported"), code: "unsupported_feature", changed: false }],
    ["group_failed", refusal("group_failed", { detail: "Tabs cannot be edited right now" })],
    ["invalid_params", refusal("invalid_params", { detail: "every listed tab is already in the group" })],
  ];
  for (const [code, answer] of cases) {
    await withMoveService(
      async ({ preview, decide }) => {
        const action = await preview(EXISTING_BODY);
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, code);
        assert.equal(response.json.result.state, "failed", code);
        assert.equal(response.json.result.result.mutation, "none");
        assert.equal(response.json.result.result.code, code);
        assert.equal(response.json.result.result.tabIds, null);
        assert.equal(response.json.result.result.observed, null);
      },
      { extension: { move: () => answer } },
    );
  }
});

test("a possibly-applied tabs.group (changed:null) is a terminal failed outcome with mutation unknown — never none, never moved — and is not retried", async () => {
  const answers = {
    "a rejection after a possible apply": (p) => ({ ...envelope("browser.move_tabs", "error"), code: "group_failed", detail: "Tabs cannot be edited right now", changed: null }),
    "a new-group call with no usable group id": () => ({ ...envelope("browser.move_tabs", "error"), code: "observe_failed", detail: "tabs.group returned no usable group id", changed: null }),
  };
  for (const [name, answer] of Object.entries(answers)) {
    for (const body of [NEW_BODY, EXISTING_BODY]) {
      await withMoveService(
        async ({ preview, decide, ws, owner }) => {
          const action = await preview(body);
          const response = await decide("approve", action.id);
          assert.equal(response.status, 200, name);
          assert.equal(response.json.result.state, "failed", name);
          assert.equal(response.json.result.result.mutation, "unknown", `${name}: not "none" and not "moved"`);
          assert.equal(response.json.result.result.tabIds, null, "no tab is claimed moved or observed");
          assert.equal(response.json.result.result.groupId, null);
          assert.equal(response.json.result.result.observed, null);
          assert.match(response.json.result.result.code, /^(group_failed|observe_failed)$/);
          assert.equal((await decide("approve", action.id)).status, 409);
          assert.equal(moveRequests(ws).length, 1, "and is not retried");
          const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
          assert.deepEqual(audit[0].detail, { state: "failed", mutation: "unknown" });
        },
        { extension: { move: answer } },
      );
    }
  }
  // An unknown-effect answer for another session is unusable, and still unknown.
  await withMoveService(
    async ({ preview, decide }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.json.result.state, "failed");
      assert.equal(response.json.result.result.mutation, "unknown");
      assert.equal(response.json.result.result.code, "invalid_extension_response");
    },
    { extension: { move: () => ({ ...envelope("browser.move_tabs", "error", "other-session"), code: "group_failed", changed: null }) } },
  );
  // changed:null is only ever a plain error: as an incomplete or unsupported answer it is invalid.
  for (const status of ["incomplete", "unsupported", "ok"]) {
    await withMoveService(
      async ({ preview, decide }) => {
        const action = await preview();
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "failed", status);
        assert.equal(response.json.result.result.mutation, "unknown", status);
        assert.equal(response.json.result.result.code, "invalid_extension_response", status);
      },
      { extension: { move: () => ({ ...envelope("browser.move_tabs", status), code: "group_failed", changed: null }) } },
    );
  }
});

test("a partial outcome reports a known move and only the tabs actually observed in the destination, and is never retried", async () => {
  const cases = [
    {
      body: NEW_BODY,
      answer: (p) => partialResult(p, { code: "group_update_failed", detail: "No group with id: 20", tabIds: null }),
      expected: { mutation: "moved", code: "group_update_failed", detail: "No group with id: 20", tabIds: null, groupId: 20, windowId: 2, observed: null },
    },
    {
      body: NEW_BODY,
      answer: (p) => partialResult(p, { groupId: null, tabIds: null }),
      expected: { mutation: "moved", code: "observe_failed", detail: null, tabIds: null, groupId: null, windowId: 2, observed: null },
    },
    {
      body: EXISTING_BODY,
      answer: (p) => partialResult(p, { detail: "tab 6 was not observed in the destination group", tabIds: [5] }),
      expected: { mutation: "moved", code: "observe_failed", detail: "tab 6 was not observed in the destination group", tabIds: [5], groupId: 10, windowId: 2, observed: null },
    },
    {
      body: { tabIds: [5, 7, 6], destination: "new" },
      answer: (p) => partialResult(p, { detail: "tab 5 was not observed", tabIds: [7, 6] }),
      expected: { mutation: "moved", code: "observe_failed", detail: "tab 5 was not observed", tabIds: [7, 6], groupId: 20, windowId: 2, observed: null },
    },
    {
      body: NEW_BODY,
      answer: (p) => partialResult(p, { tabIds: [5, 6] }),
      expected: { mutation: "moved", code: "observe_failed", detail: null, tabIds: [5, 6], groupId: 20, windowId: 2, observed: null },
    },
  ];
  for (const { body, answer, expected } of cases) {
    await withMoveService(
      async ({ preview, decide, ws, owner }) => {
        const action = await preview(body);
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200);
        assert.equal(response.json.result.state, "partial");
        assert.deepEqual(response.json.result.result, expected);
        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(moveRequests(ws).length, 1, "a partial outcome is not retried");
        const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
        assert.deepEqual(audit[0].detail, { state: "partial", mutation: "moved" });
      },
      { extension: { move: answer } },
    );
  }
});

test("an unusable or hostile extension answer is a 'failed' outcome with mutation unknown, never recorded as success or partial", async () => {
  const sameGroup = (p) => (p.destination === "existing" ? p.groupId : 20);
  const cases = {
    "a legacy peer's bare unknown_method error (no changed flag)": () => ({ ...envelope("browser.move_tabs", "error"), code: "unknown_method" }),
    "a result for the wrong method": (p) => moveResult(p, { sourceOperation: "browser.open_tab" }),
    "an ok result with no observed group": (p) => moveResult(p, { group: undefined }),
    "an ok result with no observed tabs": (p) => moveResult(p, { tabs: undefined }),
    "an ok result that says nothing changed": (p) => moveResult(p, { changed: false }),
    "an answer for a different session": (p) => moveResult(p, { browserSessionId: "some-other-session" }),
    "an answer for the other destination kind": (p) => moveResult(p, { destination: p.destination === "new" ? "existing" : "new" }),
    "an answer for a group in another window": (p) => moveResult(p, { group: { groupId: 20, windowId: p.windowId + 1, title: "", color: "red", collapsed: false } }),
    "fewer observed tabs": (p) => moveResult(p, { tabs: p.tabs.slice(1).map((t) => ({ tabId: t.tabId, windowId: p.windowId, groupId: sameGroup(p) })) }),
    "more observed tabs": (p) => moveResult(p, { tabs: [...p.tabs, { tabId: 99, windowId: p.windowId }].map((t) => ({ tabId: t.tabId, windowId: p.windowId, groupId: sameGroup(p) })) }),
    "observed tabs in another order": (p) => moveResult(p, { tabs: [...p.tabs].reverse().map((t) => ({ tabId: t.tabId, windowId: p.windowId, groupId: sameGroup(p) })) }),
    "an observed tab that is a different tab": (p) => moveResult(p, { tabs: p.tabs.map((t, i) => ({ tabId: i === 1 ? 99 : t.tabId, windowId: p.windowId, groupId: sameGroup(p) })) }),
    "an observed tab in another window": (p) => moveResult(p, { tabs: p.tabs.map((t, i) => ({ tabId: t.tabId, windowId: i === 1 ? p.windowId + 1 : p.windowId, groupId: sameGroup(p) })) }),
    "an observed tab not in the destination group": (p) => moveResult(p, { tabs: p.tabs.map((t, i) => ({ tabId: t.tabId, windowId: p.windowId, groupId: i === 1 ? 3 : sameGroup(p) })) }),
    "an observed tab in no group": (p) => moveResult(p, { tabs: p.tabs.map((t, i) => ({ tabId: t.tabId, windowId: p.windowId, groupId: i === 1 ? -1 : sameGroup(p) })) }),
    "a partial answer for a different session": (p) => partialResult(p, { browserSessionId: "other-session" }),
    "a partial answer with an invented code": (p) => partialResult(p, { code: "whatever" }),
    "a partial answer for other tabs": (p) => partialResult(p, { tabIds: p.tabs.map((t) => t.tabId + 1) }),
    "a partial answer for more tabs": (p) => partialResult(p, { tabIds: [...p.tabs.map((t) => t.tabId), 99] }),
    "a partial answer for the tabs in another order": (p) => partialResult(p, { tabIds: p.tabs.map((t) => t.tabId).reverse() }),
    "a partial answer repeating a tab": (p) => partialResult(p, { tabIds: [p.tabs[0].tabId, p.tabs[0].tabId] }),
    "a partial answer with a subset plus a foreign tab": (p) => partialResult(p, { tabIds: [p.tabs[0].tabId, 99] }),
    "a partial answer with an empty list": (p) => partialResult(p, { tabIds: [] }),
    "a partial answer with a non-list": (p) => partialResult(p, { tabIds: "5,6" }),
    "a partial answer for another window": (p) => partialResult(p, { windowId: p.windowId + 1 }),
    "a partial answer naming no window": (p) => partialResult(p, { windowId: null }),
    "a non-object": () => "ok",
  };
  for (const [name, move] of Object.entries(cases)) {
    for (const body of [NEW_BODY, EXISTING_BODY]) {
      await withMoveService(
        async ({ preview, decide, store }) => {
          const action = await preview(body);
          const response = await decide("approve", action.id);
          assert.equal(response.status, 200, name);
          assert.equal(response.json.result.state, "failed", `${name} (${body.destination}): ${JSON.stringify(response.json.result.result)}`);
          assert.equal(response.json.result.result.mutation, "unknown", name);
          assert.equal(response.json.result.result.code, "invalid_extension_response", name);
          assert.equal(response.json.result.result.observed, null, name);
          assert.equal(response.json.result.result.tabIds, null, name);
          assert.equal(store.listActions({ id: action.id }).items[0].state, "failed");
        },
        { extension: { move } },
      );
    }
  }
  // An existing destination must come back as its own group.
  await withMoveService(
    async ({ preview, decide }) => {
      const action = await preview(EXISTING_BODY);
      const response = await decide("approve", action.id);
      assert.equal(response.json.result.state, "failed", "an ok answer for a different existing group");
      assert.equal(response.json.result.result.mutation, "unknown");
    },
    {
      extension: {
        move: (p) => moveResult(p, { group: { groupId: 11, windowId: 2, title: "Dest", color: "blue", collapsed: false }, tabs: p.tabs.map((t) => ({ tabId: t.tabId, windowId: 2, groupId: 11 })) }),
      },
    },
  );
  await withMoveService(
    async ({ preview, decide }) => {
      const action = await preview(EXISTING_BODY);
      const response = await decide("approve", action.id);
      assert.equal(response.json.result.state, "failed", "a partial answer for a different existing group");
      assert.equal(response.json.result.result.mutation, "unknown");
    },
    { extension: { move: (p) => partialResult(p, { groupId: 11 }) } },
  );
});

test("a partial answer for a new group may carry a newly assigned group handle, and any tabs/window that match the preview", async () => {
  await withMoveService(
    async ({ preview, decide }) => {
      const action = await preview(NEW_BODY);
      const response = await decide("approve", action.id);
      assert.equal(response.json.result.state, "partial");
      assert.equal(response.json.result.result.groupId, 4242);
    },
    { extension: { move: (p) => partialResult(p, { groupId: 4242 }) } },
  );
});

test("an extension that never answers yields a failed outcome with mutation unknown, and the action is not retried", async () => {
  await withMoveService(
    async ({ preview, decide, ws }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200);
      assert.equal(response.json.result.state, "failed");
      assert.equal(response.json.result.result.mutation, "unknown");
      assert.equal(response.json.result.result.code, "request_timeout");
      assert.match(response.json.result.result.detail, /may or may not/);
      assert.equal((await decide("approve", action.id)).status, 409);
      assert.equal(moveRequests(ws).length, 1);
    },
    { requestTimeoutMs: 150, extension: { move: () => NO_RESPONSE } },
  );
});

test("an extension that disconnects mid-request yields a failed outcome with mutation unknown", async () => {
  await withMoveService(
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
        move: (_params, ws) => {
          ws.close();
          return NO_RESPONSE;
        },
      },
    },
  );
});

test("an observed title, color, and detail are clipped to their bounds before being stored", async () => {
  await withMoveService(
    async ({ preview, decide, store }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const { observed } = response.json.result.result;
      assert.equal(observed.title.length, 500);
      assert.equal(observed.color.length, 50);
      assert.equal(store.listActions({ id: action.id }).items[0].state, "executed");
    },
    { extension: { move: (p) => moveResult(p, { group: { groupId: 20, windowId: p.windowId, title: "T".repeat(10_000), color: "c".repeat(500), collapsed: true } }) } },
  );
});

// ---------------------------------------------------------------------------
// HTTP: exactly-once, audit content, clear
// ---------------------------------------------------------------------------

test("concurrent approve and reject requests for one preview yield exactly one decision and at most one execution", async () => {
  await withMoveService(
    async ({ preview, decide, ws, store }) => {
      const plans = [
        ["approve", "approve", "approve", "approve", "approve", "approve"],
        ["reject", "approve", "approve", "reject"],
        ["approve", "reject", "reject", "approve", "approve"],
        ["reject", "reject", "reject"],
      ];
      for (const plan of plans) {
        const action = await preview({ tabIds: [5, 6], destination: "new", title: plan.join("-").slice(0, 20) });
        const before = moveRequests(ws).length;
        const responses = await Promise.all(plan.map((operation) => decide(operation, action.id)));
        const winners = responses.filter((r) => r.status === 200);
        assert.equal(winners.length, 1, `plan ${plan.join(",")}: exactly one decision wins`);
        for (const loser of responses.filter((r) => r.status !== 200)) {
          assert.equal(loser.status, 409);
          assert.equal(loser.json.error.code, "conflict");
        }
        const state = winners[0].json.result.state;
        assert.ok(state === "executed" || state === "rejected", state);
        assert.equal(moveRequests(ws).length - before, state === "executed" ? 1 : 0, "executed at most once, and only if approved");
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
  await withMoveService(
    async ({ preview, decide, owner }) => {
      const refused = await preview({ tabIds: [5, 6], destination: "new", title: "refused" });
      const opened = await preview({ tabIds: [5, 6], destination: "new", title: "opened" });
      const partial = await preview({ tabIds: [5, 6], destination: "new", title: "partial" });
      assert.equal((await decide("approve", refused.id)).json.result.result.code, "SECRET-CODE");
      assert.equal((await decide("approve", opened.id)).json.result.state, "executed");
      assert.equal((await decide("approve", partial.id)).json.result.state, "partial");

      const audit = (await owner("/api/store.actions.audit.list")).json.result;
      assert.equal(audit.total, 3 + 3 + 3);
      assertAuditContentFree(audit.items);
      const text = JSON.stringify(audit);
      for (const secret of ["SECRET", "secret", "evil.example", "refused", "opened", "Tab 5", SESSION_ID]) {
        assert.ok(!text.includes(secret), `the audit log leaked ${secret}`);
      }
      const record = (await owner(`/api/store.actions.list?id=${opened.id}`)).json.result.items[0];
      assert.equal(record.result.observed.title, "SECRET-TITLE");
      assert.equal(record.result.groupId, 4242);
    },
    {
      extension: {
        move: (params) => {
          if (params.title === "refused") return refusal("SECRET-CODE", { detail: "SECRET-DETAIL" });
          if (params.title === "partial") return partialResult(params, { detail: "SECRET-DETAIL", groupId: 4343 });
          return moveResult(params, {
            group: { groupId: 4242, windowId: params.windowId, title: "SECRET-TITLE", color: "secret-color", collapsed: false },
            tabs: params.tabs.map((t) => ({ tabId: t.tabId, windowId: params.windowId, groupId: 4242 })),
          });
        },
      },
    },
  );
});

test("store.clear is refused with 409 while a move approval is in flight, then proceeds once its result is recorded", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withMoveService(
    async ({ preview, decide, owner, ws, store }) => {
      const action = await preview();
      const approval = decide("approve", action.id);
      await waitFor(() => moveRequests(ws).length === 1, { what: "the mutation request to reach the extension" });
      const refused = await owner("/api/store.clear", { method: "POST" });
      assert.equal(refused.status, 409);
      assert.equal(store.listActions({ id: action.id }).items[0].state, "approved");
      release();
      assert.equal((await approval).json.result.state, "executed");
      assert.equal((await owner("/api/store.clear", { method: "POST" })).status, 200);
      assert.equal(store.listActions().total, 0);
      assert.deepEqual(store.listActionAudit({ actionId: action.id }).items.map((e) => e.event), ["result", "approve", "preview"]);
    },
    { extension: { move: async (params) => (await gate, moveResult(params)) } },
  );
});

test("move previews and results are never written to the service log", async () => {
  const lines = [];
  await withMoveService(
    async ({ preview, decide }) => {
      const action = await preview({ tabIds: [5, 6], destination: "new", title: "secret-group-title" });
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

// Window 2: tab 5 (ungrouped), tab 6 (alone in group 3), tab 7 (ungrouped),
// tab 8 (pinned), tab 11 (in group 10 "Dest"/blue); tab 9 is in window 4.
// `tabs.group` really moves tabs, creates group 20 for a new group, and — like
// Chrome — removes any group left with no tabs. A test can change `tabs`/
// `groups` between preview and approval to simulate the user changing the
// browser meanwhile.
function mockBrowser({ supported = true, overrides = {} } = {}) {
  const calls = { group: [], update: [], tabsGet: [], groupsGet: [] };
  const tabs = new Map();
  const addTab = (id, props) => tabs.set(id, { id, windowId: 2, groupId: -1, pinned: false, title: `Tab ${id}`, url: `https://example.com/${id}`, ...props });
  addTab(5);
  addTab(6, { groupId: 3 });
  addTab(7);
  addTab(8, { pinned: true });
  addTab(9, { windowId: 4 });
  addTab(11, { groupId: 10 });
  const groups = new Map([
    [3, { id: 3, windowId: 2, title: "Src", color: "red", collapsed: false }],
    [10, { id: 10, windowId: 2, title: "Dest", color: "blue", collapsed: false }],
  ]);
  const api = {
    windows: { getAll: async () => [], get: async () => ({ id: 0 }) },
    scripting: { executeScript: async () => [] },
    runtime: { onMessage: { addListener: () => {} } },
    tabs: {
      query: async () => [],
      get: async (id) => {
        calls.tabsGet.push(id);
        const tab = tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return { ...tab };
      },
    },
  };
  if (supported) {
    api.tabs.group = async (options) => {
      calls.group.push(options);
      if (overrides.group) return overrides.group(options, { tabs, groups });
      let groupId = options.groupId;
      if (groupId === undefined) {
        groupId = 20;
        groups.set(20, { id: 20, windowId: options.createProperties?.windowId ?? 2, title: "", color: "grey", collapsed: false });
      }
      for (const id of options.tabIds) tabs.get(id).groupId = groupId;
      for (const id of [...groups.keys()]) {
        if (![...tabs.values()].some((tab) => tab.groupId === id)) groups.delete(id);
      }
      return groupId;
    };
    api.tabGroups = {
      get: async (id) => {
        calls.groupsGet.push(id);
        const group = groups.get(id);
        if (!group) throw new Error(`No group with id: ${id}`);
        return { ...group };
      },
      update: async (id, props) => {
        calls.update.push({ id, props });
        if (overrides.update) return overrides.update(id, props);
        Object.assign(groups.get(id), props);
        return { ...groups.get(id) };
      },
    };
  }
  return { api, calls, tabs, groups };
}

async function startRealExtension(port, browser = mockBrowser()) {
  globalThis.chrome = browser.api;
  workerCase += 1;
  const worker = await import(`../extension/service-worker.js?moves-e2e=${workerCase}`);
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

test("end to end: preview then approve moves exactly the previewed tabs into a new group, in one call, and reports each tab read back", async () => {
  await withMoveService(
    async ({ port, preview, decide, owner }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ tabIds: [5, 6, 7], destination: "new", title: "Work", color: "red" });
        assert.equal(action.browserSessionId, extension.sessionId);
        assert.deepEqual(action.binding.tabs.map((t) => [t.tabId, t.groupId]), [[5, -1], [6, 3], [7, -1]]);
        noMutation(extension);

        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, JSON.stringify(response.json));
        assert.equal(response.json.result.state, "executed", JSON.stringify(response.json.result));
        assert.deepEqual(extension.calls.group, [{ tabIds: [5, 6, 7], createProperties: { windowId: 2 } }], "one call, the whole list, in the previewed window");
        assert.deepEqual(extension.calls.update, [{ id: 20, props: { title: "Work", color: "red" } }]);
        assert.deepEqual(response.json.result.result, {
          mutation: "moved",
          code: null,
          detail: null,
          tabIds: [5, 6, 7],
          groupId: 20,
          windowId: 2,
          observed: { windowId: 2, title: "Work", color: "red", collapsed: false },
        });
        assert.equal(extension.groups.has(3), false, "the emptied source group disappeared by itself (expected, and shown in the preview)");
        assert.deepEqual([...extension.tabs.values()].filter((t) => t.groupId === 20).map((t) => t.id), [5, 6, 7]);

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

test("end to end: preview then approve moves the selected tabs into an existing group, leaving its title and color alone", async () => {
  await withMoveService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview({ tabIds: [5, 6, 11], destination: "existing", groupId: 10 });
        assert.deepEqual(action.binding.tabs.map((t) => [t.tabId, t.groupId]), [[5, -1], [6, 3], [11, 10]]);
        assert.equal(action.binding.expectedTitle, "Dest");
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "executed", JSON.stringify(response.json.result));
        assert.equal(response.json.result.result.mutation, "moved");
        assert.equal(response.json.result.result.groupId, 10);
        assert.deepEqual(response.json.result.result.tabIds, [5, 6, 11]);
        assert.deepEqual(response.json.result.result.observed, { windowId: 2, title: "Dest", color: "blue", collapsed: false });
        assert.deepEqual(extension.calls.group, [{ groupId: 10, tabIds: [5, 6, 11] }]);
        assert.deepEqual(extension.calls.update, [], "an existing group is never renamed or recolored by a move");
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: reject moves nothing at all", async () => {
  await withMoveService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(port);
      try {
        for (const body of [NEW_BODY, EXISTING_BODY]) {
          const action = await preview(body);
          assert.equal((await decide("reject", action.id)).json.result.state, "rejected");
          assert.equal((await decide("approve", action.id)).status, 409);
        }
        noMutation(extension);
        assert.equal(extension.tabs.get(5).groupId, -1);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a pinned tab, tabs in two windows, a destination in another window, and a no-op move are refused at preview", async () => {
  await withMoveService(
    async ({ port, owner, store }) => {
      const extension = await startRealExtension(port);
      try {
        extension.groups.set(30, { id: 30, windowId: 4, title: "Elsewhere", color: "green", collapsed: false });
        extension.tabs.get(9).groupId = 30;
        const attempts = [
          ["a pinned tab", { tabIds: [5, 8], destination: "new" }, 409, "conflict"],
          ["tabs in two windows", { tabIds: [5, 9], destination: "new" }, 409, "conflict"],
          ["a destination in another window", { tabIds: [5, 6], destination: "existing", groupId: 30 }, 409, "conflict"],
          ["a no-op move", { tabIds: [11], destination: "existing", groupId: 10 }, 400, "validation_error"],
          ["a missing tab", { tabIds: [5, 404], destination: "new" }, 409, "stale_handle"],
          ["a missing group", { tabIds: [5], destination: "existing", groupId: 404 }, 409, "stale_handle"],
        ];
        for (const [name, body, status, code] of attempts) {
          const response = await owner("/api/action.move_tabs.preview", { method: "POST", body });
          assert.equal(response.status, status, `${name}: ${JSON.stringify(response.json)}`);
          assert.equal(response.json.error.code, code, name);
        }
        assert.equal(store.listActions().total, 0);
        noMutation(extension);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a preview taken in an earlier browser session is refused as stale and moves nothing", async () => {
  await withMoveService(
    async ({ port, preview, decide }) => {
      const before = await startRealExtension(port);
      const action = await preview(NEW_BODY);
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
        noMutation(after);
        assert.deepEqual(after.calls.tabsGet, [], "the new session's browser was not even read");
      } finally {
        after.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a tab regrouped, pinned, moved, or closed — or a destination renamed, recolored, moved, or closed — after the preview is refused as stale and moves nothing", async () => {
  const scenarios = [
    ["a tab was grouped meanwhile", NEW_BODY, (b) => (b.tabs.get(5).groupId = 3), "state_mismatch"],
    ["a tab left its group meanwhile", NEW_BODY, (b) => (b.tabs.get(6).groupId = -1), "state_mismatch"],
    ["a tab was pinned", NEW_BODY, (b) => (b.tabs.get(5).pinned = true), "state_mismatch"],
    ["a tab moved window", NEW_BODY, (b) => (b.tabs.get(6).windowId = 4), "state_mismatch"],
    ["a tab was closed", NEW_BODY, (b) => b.tabs.delete(6), "stale_handle"],
    ["the destination was renamed", EXISTING_BODY, (b) => (b.groups.get(10).title = "Someone else's"), "state_mismatch"],
    ["the destination was recolored", EXISTING_BODY, (b) => (b.groups.get(10).color = "red"), "state_mismatch"],
    ["the destination moved window", EXISTING_BODY, (b) => (b.groups.get(10).windowId = 4), "state_mismatch"],
    ["the destination was closed", EXISTING_BODY, (b) => b.groups.delete(10), "stale_handle"],
  ];
  for (const [name, body, change, expectedCode] of scenarios) {
    await withMoveService(
      async ({ port, preview, decide }) => {
        const extension = await startRealExtension(port);
        try {
          const action = await preview(body);
          change(extension);
          const response = await decide("approve", action.id);
          assert.equal(response.status, 200, name);
          assert.equal(response.json.result.state, "stale", `${name}: ${JSON.stringify(response.json.result)}`);
          assert.equal(response.json.result.result.mutation, "none", name);
          assert.equal(response.json.result.result.code, expectedCode, name);
          noMutation(extension);
        } finally {
          extension.stop();
        }
      },
      { connectExtension: false },
    );
  }
});

test("end to end: a browser without tab groups answers unsupported at preview, and an approved move there fails without mutation", async () => {
  await withMoveService(
    async ({ port, owner, decide, store }) => {
      const extension = await startRealExtension(port, mockBrowser({ supported: false }));
      try {
        for (const body of [NEW_BODY, EXISTING_BODY]) {
          const response = await owner("/api/action.move_tabs.preview", { method: "POST", body });
          assert.equal(response.status, 501, JSON.stringify(response.json));
          assert.equal(response.json.error.code, "unsupported_feature");
        }
        assert.equal(store.listActions().total, 0);
        const action = store.createAction({ kind: "move_tabs", browserSessionId: extension.sessionId, binding: NEW_BINDING });
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

test("end to end: tabs.group rejecting after the browser applied the move is failed/unknown (not none, not moved), with one call and no retry", async () => {
  await withMoveService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(
        port,
        mockBrowser({
          overrides: {
            group: async (options, { tabs, groups }) => {
              // The browser applies the move, then reports failure.
              groups.set(20, { id: 20, windowId: 2, title: "", color: "grey", collapsed: false });
              for (const id of options.tabIds) tabs.get(id).groupId = 20;
              throw new Error("Tabs cannot be edited right now");
            },
          },
        }),
      );
      try {
        const action = await preview(NEW_BODY);
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "failed");
        assert.equal(response.json.result.result.mutation, "unknown");
        assert.equal(response.json.result.result.code, "group_failed");
        assert.equal(response.json.result.result.tabIds, null);
        assert.equal(extension.calls.group.length, 1);
        assert.deepEqual(extension.calls.update, []);
        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(extension.calls.group.length, 1, "no retry");
        assert.equal(extension.tabs.get(5).groupId, 20, "the move really was applied — which is why it was never recorded as 'none'");
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a move that only partly lands reports the ordered subset actually observed in the group, not every tab", async () => {
  await withMoveService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(
        port,
        mockBrowser({
          overrides: {
            group: async (options, { tabs }) => {
              tabs.get(options.tabIds[0]).groupId = options.groupId; // only the first tab moves
              return options.groupId;
            },
          },
        }),
      );
      try {
        const action = await preview(EXISTING_BODY);
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "partial", JSON.stringify(response.json.result));
        assert.equal(response.json.result.result.mutation, "moved");
        assert.equal(response.json.result.result.groupId, 10);
        assert.deepEqual(response.json.result.result.tabIds, [5], "only the tab seen in the group");
        assert.equal(response.json.result.result.observed, null);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a new group whose title/color update fails is a partial outcome with a known move and no tab claimed observed", async () => {
  await withMoveService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(
        port,
        mockBrowser({
          overrides: {
            update: async () => {
              throw new Error("No group with id: 20");
            },
          },
        }),
      );
      try {
        const action = await preview(NEW_BODY);
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "partial");
        assert.equal(response.json.result.result.mutation, "moved");
        assert.equal(response.json.result.result.code, "group_update_failed");
        assert.equal(response.json.result.result.groupId, 20);
        assert.equal(response.json.result.result.tabIds, null, "the move is known, but no tab was observed in the group");
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

test("end to end: the agent credential cannot move tabs by any route, and the browser is never asked to", async () => {
  await withMoveService(
    async ({ port, preview }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview(NEW_BODY);
        const readsBefore = extension.calls.tabsGet.length;
        for (const [path, body] of [
          [`/api/action.move_tabs.approve?id=${action.id}`, undefined],
          ["/api/action.move_tabs.preview", NEW_BODY],
          ["/api/browser.move_tabs", { ...NEW_BINDING, browserSessionId: extension.sessionId }],
        ]) {
          const response = await httpRequest({ port, method: "POST", path, token: AGENT_TOKEN, body });
          assert.ok(response.status === 403 || response.status === 404, `${path} -> ${response.status}`);
        }
        noMutation(extension);
        assert.equal(extension.calls.tabsGet.length, readsBefore);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});
