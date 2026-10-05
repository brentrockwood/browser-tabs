// Phase 2 Action 1: "open a URL in a new tab". Covers the action store (state
// machine, append-only audit log, bounds, persistence), the owner-only HTTP
// routes (validation, scope, preview/approve/reject, stale/partial/failed
// outcomes, exactly-once execution under concurrency), and the full path
// through the real extension worker, service client, and service.
//
// Real service, real SQLite-backed store, and a real `ws` client standing in
// for the extension in the HTTP tests — no mocked sockets; the end-to-end
// section at the bottom replaces the stand-in with the real extension code.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { createServiceClient } from "../extension/service-client.js";
import { createService } from "../service/server.mjs";
import { openStore } from "../service/store.mjs";
import {
  ACTION_INTERRUPTED_DETAIL,
  ACTION_MUTATIONS,
  ACTION_RESULT_STATES,
  MAX_ACTION_AUDIT_EVENTS,
  MAX_PENDING_ACTIONS,
} from "../service/validation.mjs";

const OWNER_TOKEN = "actions-owner-token-0123456789";
const AGENT_TOKEN = "actions-agent-token-0123456789";
const EXTENSION_ORIGIN = "chrome-extension://actions-test-extension";
const SESSION_ID = "actions-session";
const URL_ONE = "https://example.com/page";

async function withTempDir(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-actions-"));
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

function observedTab(overrides = {}) {
  return { index: 2, active: true, status: "loading", title: "", url: "", pendingUrl: URL_ONE, ...overrides };
}

function executedResult(overrides = {}) {
  return { state: "executed", mutation: "created", code: null, detail: null, tabId: 31, windowId: 2, observed: observedTab(), ...overrides };
}

function preview(store, overrides = {}) {
  return store.createAction({ url: URL_ONE, browserSessionId: SESSION_ID, ...overrides });
}

// Every audit detail is built from server-controlled enums alone: these four
// keys, each with a value from a fixed set. Nothing a caller or the extension
// supplies (URL, session id, title, handle, code, detail) can appear.
function assertAuditContentFree(events) {
  const allowed = {
    kind: ["open_tab"],
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
// Store: previews bind the exact URL, session, and time
// ---------------------------------------------------------------------------

test("createAction records a preview bound to the normalized URL, the session, and a timestamp, executing nothing", async () => {
  await withStore(async (store) => {
    const before = Date.now();
    const action = preview(store, { url: "HTTPS://Example.COM:443/page" });
    assert.equal(action.id, 1);
    assert.equal(action.kind, "open_tab");
    assert.equal(action.url, "https://example.com/page");
    assert.equal(action.browserSessionId, SESSION_ID);
    assert.equal(action.state, "previewed");
    assert.ok(action.previewedAt >= before && action.previewedAt <= Date.now());
    assert.equal(action.decidedAt, null);
    assert.equal(action.completedAt, null);
    assert.equal(action.result, null);
  });
});

test("createAction rejects a URL that is not an absolute, credential-free, bounded http(s) URL, and a bad session id", async () => {
  await withStore(async (store) => {
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "https://u:p@example.com/", "example.com", undefined, "https://example.com/\n", `https://example.com/${"a".repeat(3000)}`]) {
      assert.throws(() => preview(store, { url }), (error) => error.code === "validation_error", `${String(url).slice(0, 30)} must be rejected`);
    }
    for (const browserSessionId of [undefined, "", 5, "s".repeat(201)]) {
      assert.throws(() => preview(store, { browserSessionId }), (error) => error.code === "validation_error");
    }
    assert.equal(store.listActions().total, 0);
    assert.equal(store.listActionAudit().total, 0, "a rejected preview leaves no audit event either");
  });
});

// ---------------------------------------------------------------------------
// Store: one terminal decision
// ---------------------------------------------------------------------------

test("decideAction approves a preview exactly once; every later decision conflicts", async () => {
  await withStore(async (store) => {
    const { id } = preview(store);
    const approved = store.decideAction(id, "approve");
    assert.equal(approved.state, "approved");
    assert.ok(approved.decidedAt >= approved.previewedAt);
    for (const decision of ["approve", "reject", "approve"]) {
      assert.throws(() => store.decideAction(id, decision), (error) => error.code === "conflict");
    }
    assert.equal(store.listActions({ id }).items[0].state, "approved");
  });
});

test("decideAction rejects a preview exactly once and a rejected preview can never be approved", async () => {
  await withStore(async (store) => {
    const { id } = preview(store);
    assert.equal(store.decideAction(id, "reject").state, "rejected");
    assert.throws(() => store.decideAction(id, "approve"), (error) => error.code === "conflict");
    assert.throws(() => store.recordActionResult(id, executedResult()), (error) => error.code === "conflict", "a rejected action has no result");
    assert.equal(store.listActions({ id }).items[0].state, "rejected");
  });
});

test("decideAction reports an unknown id as not_found and validates its arguments", async () => {
  await withStore(async (store) => {
    assert.throws(() => store.decideAction(99, "approve"), (error) => error.code === "not_found");
    assert.throws(() => store.decideAction(0, "approve"), (error) => error.code === "validation_error");
    assert.throws(() => store.decideAction(1.5, "approve"), (error) => error.code === "validation_error");
    assert.throws(() => store.decideAction("1", "approve"), (error) => error.code === "validation_error");
    assert.throws(() => store.decideAction(1, "execute"), (error) => error.code === "validation_error");
    assert.throws(() => store.decideAction(1, undefined), (error) => error.code === "validation_error");
  });
});

test("two store connections to one database cannot both decide the same preview", async () => {
  await withTempDir(async (dataDir) => {
    const first = await openStore({ dataDir });
    const second = await openStore({ dataDir });
    try {
      const { id } = preview(first);
      const outcomes = [];
      for (const store of [first, second, first, second]) {
        try {
          outcomes.push(store.decideAction(id, "approve").state);
        } catch (error) {
          outcomes.push(error.code);
        }
      }
      assert.deepEqual(outcomes, ["approved", "conflict", "conflict", "conflict"]);
      const audit = first.listActionAudit({ actionId: id }).items.map((e) => e.event);
      assert.deepEqual(audit, ["approve", "preview"], "exactly one decision event, newest first");
    } finally {
      first.close();
      second.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Store: results
// ---------------------------------------------------------------------------

test("recordActionResult completes only an approved action, once, and persists the observed state", async () => {
  await withStore(async (store) => {
    const { id } = preview(store);
    assert.throws(() => store.recordActionResult(id, executedResult()), (error) => error.code === "conflict", "a merely previewed action cannot be completed");

    store.decideAction(id, "approve");
    const done = store.recordActionResult(id, executedResult());
    assert.equal(done.state, "executed");
    assert.ok(done.completedAt >= done.decidedAt);
    assert.deepEqual(done.result, { mutation: "created", code: null, detail: null, tabId: 31, windowId: 2, observed: observedTab() });

    assert.throws(() => store.recordActionResult(id, executedResult()), (error) => error.code === "conflict", "a result is recorded once");
    assert.throws(() => store.recordActionResult(id, { state: "failed", mutation: "none", code: "x" }), (error) => error.code === "conflict");
    assert.throws(() => store.recordActionResult(404, executedResult()), (error) => error.code === "not_found");
    assert.equal(store.listActions({ id }).items[0].state, "executed");
  });
});

test("recordActionResult validates the outcome: consistent state/mutation/handles/observation, bounded fields", async () => {
  await withStore(async (store) => {
    const { id } = preview(store);
    store.decideAction(id, "approve");
    const bad = [
      { ...executedResult(), state: "bogus" },
      { ...executedResult(), mutation: "bogus" },
      { ...executedResult(), mutation: "none" }, // executed always means a tab was created
      { ...executedResult(), observed: null }, // executed requires the observation
      { ...executedResult(), tabId: null },
      { ...executedResult(), windowId: null },
      { ...executedResult(), observed: { ...observedTab(), index: -1 } },
      { ...executedResult(), observed: { ...observedTab(), title: "t".repeat(501) } },
      { ...executedResult(), observed: { ...observedTab(), url: "u".repeat(2049) } },
      { ...executedResult(), observed: { ...observedTab(), active: "yes" } },
      { state: "stale", mutation: "created", code: "stale_session" },
      { state: "stale", mutation: "none" }, // a non-executed result needs a code
      { state: "failed", mutation: "none", code: "x", observed: observedTab() },
      { state: "failed", mutation: "none", code: "x", tabId: 1 },
      { state: "partial", mutation: "unknown", code: "observe_failed" },
      { state: "failed", mutation: "none", code: "x".repeat(201) },
      { state: "failed", mutation: "none", code: "x", detail: "d".repeat(501) },
    ];
    for (const input of bad) {
      assert.throws(() => store.recordActionResult(id, input), (error) => error.code === "validation_error", JSON.stringify(input).slice(0, 80));
    }
    assert.equal(store.listActions({ id }).items[0].state, "approved", "no invalid result changed the action");
    assert.equal(store.listActionAudit({ actionId: id }).items.length, 2, "and none was audited");
  });
});

test("every result state can be recorded with its own consistent shape", async () => {
  await withStore(async (store) => {
    const results = [
      executedResult(),
      { state: "partial", mutation: "created", code: "observe_failed", detail: "boom", tabId: 31, windowId: 2 },
      { state: "partial", mutation: "created", code: "observe_failed", tabId: null, windowId: null },
      { state: "stale", mutation: "none", code: "stale_session" },
      { state: "failed", mutation: "none", code: "open_tab_failed", detail: "no window" },
      { state: "failed", mutation: "unknown", code: "request_timeout" },
    ];
    for (const result of results) {
      const { id } = preview(store);
      store.decideAction(id, "approve");
      assert.equal(store.recordActionResult(id, result).state, result.state);
    }
  });
});

// ---------------------------------------------------------------------------
// Store: the audit log
// ---------------------------------------------------------------------------

test("the audit log records preview, decision, and result events in order, with no browser content", async () => {
  await withStore(async (store) => {
    const a = preview(store);
    store.decideAction(a.id, "approve");
    store.recordActionResult(a.id, executedResult({ observed: observedTab({ title: "SECRET-TITLE", url: "https://secret.example/private" }) }));
    const b = preview(store);
    store.decideAction(b.id, "reject");

    const events = store.listActionAudit({ limit: 200 }).items;
    assert.deepEqual(
      events.map((e) => [e.actionId, e.event]),
      [
        [b.id, "reject"],
        [b.id, "preview"],
        [a.id, "result"],
        [a.id, "approve"],
        [a.id, "preview"],
      ],
      "newest first",
    );
    for (const event of events) {
      assert.equal(typeof event.occurredAt, "number");
      assert.ok(event.id > 0);
    }
    const byEvent = (actionId, name) => events.find((e) => e.actionId === actionId && e.event === name).detail;
    assert.deepEqual(byEvent(a.id, "preview"), { kind: "open_tab" });
    assert.deepEqual(byEvent(a.id, "approve"), { decision: "approve" });
    assert.deepEqual(byEvent(b.id, "reject"), { decision: "reject" });
    assert.deepEqual(byEvent(a.id, "result"), { state: "executed", mutation: "created" });

    const serialized = JSON.stringify(events);
    for (const secret of ["SECRET-TITLE", "secret.example", "example.com", "/page", "https://"]) {
      assert.ok(!serialized.includes(secret), `the audit log must not contain browser content or URLs (${secret})`);
    }
    // Structurally content-free: only server-controlled enum values, no hash,
    // session id, handle, or extension-supplied code/detail.
    for (const event of events) assert.deepEqual(Object.keys(event).sort(), ["actionId", "detail", "event", "id", "occurredAt"]);
    assertAuditContentFree(events);
    assert.ok(!serialized.includes(SESSION_ID), "not even the browser session id");
    assert.doesNotMatch(serialized, /sha|hash|digest/i);
    const raw = new DatabaseSync(store.dbPath);
    try {
      assert.deepEqual(
        raw.prepare("PRAGMA table_info(action_audit)").all().map((column) => column.name),
        ["id", "action_id", "event", "occurred_at", "detail"],
        "the audit table has no URL or URL-derived column",
      );
    } finally {
      raw.close();
    }
  });
});

test("the audit log can be filtered by action and is paginated within its bounds", async () => {
  await withStore(async (store) => {
    const a = preview(store);
    const b = preview(store);
    store.decideAction(a.id, "reject");
    assert.deepEqual(store.listActionAudit({ actionId: a.id }).items.map((e) => e.event), ["reject", "preview"]);
    assert.deepEqual(store.listActionAudit({ actionId: b.id }).items.map((e) => e.event), ["preview"]);
    const page = store.listActionAudit({ limit: 2, offset: 1 });
    assert.equal(page.items.length, 2);
    assert.equal(page.total, 3, "two previews and one reject");
    assert.throws(() => store.listActionAudit({ limit: 201 }), (error) => error.code === "validation_error");
    assert.throws(() => store.listActionAudit({ limit: 0 }), (error) => error.code === "validation_error");
    assert.throws(() => store.listActionAudit({ offset: -1 }), (error) => error.code === "validation_error");
    assert.throws(() => store.listActionAudit({ actionId: 0 }), (error) => error.code === "validation_error");
    assert.throws(() => store.listActions({ state: "bogus" }), (error) => error.code === "validation_error");
    assert.throws(() => store.listActions({ limit: 1000 }), (error) => error.code === "validation_error");
  });
});

test("the audit log and the action bindings are append-only/immutable even to raw SQL on the same database", async () => {
  await withStore(async (store) => {
    const { id } = preview(store);
    store.decideAction(id, "approve");
    store.recordActionResult(id, executedResult());

    const raw = new DatabaseSync(store.dbPath);
    try {
      assert.throws(() => raw.exec("UPDATE action_audit SET event = 'preview'"), /append-only/);
      assert.throws(() => raw.exec("UPDATE action_audit SET detail = '{}' WHERE id = 1"), /append-only/);
      assert.throws(() => raw.exec("DELETE FROM action_audit"), /append-only/);
      assert.throws(() => raw.exec("DELETE FROM action_audit WHERE id = 1"), /append-only/);
      assert.throws(() => raw.exec("UPDATE actions SET url = 'https://evil.example/' WHERE id = 1"), /immutable/);
      assert.throws(() => raw.exec("UPDATE actions SET browser_session_id = 'other' WHERE id = 1"), /immutable/);
      assert.throws(() => raw.exec("UPDATE actions SET previewed_at = 0 WHERE id = 1"), /immutable/);
      assert.throws(() => raw.exec("UPDATE actions SET state = 'previewed' WHERE id = 1"), /terminal/, "a terminal state cannot be reopened");
      assert.throws(() => raw.exec("UPDATE actions SET state = 'approved' WHERE id = 1"), /terminal/);
      assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM action_audit").get().n, 3);
    } finally {
      raw.close();
    }
  });
});

test("the store exposes no function that updates or deletes an audit event", async () => {
  await withStore(async (store) => {
    for (const name of Object.keys(store)) {
      assert.ok(!/audit/i.test(name) || name === "listActionAudit", `unexpected audit-related store function: ${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Store: persistence, clearing, bounds
// ---------------------------------------------------------------------------

test("actions and their audit events survive a store restart, and ids keep counting", async () => {
  await withTempDir(async (dataDir) => {
    let first = await openStore({ dataDir });
    const a = preview(first);
    first.decideAction(a.id, "approve");
    first.recordActionResult(a.id, executedResult());
    const pending = preview(first);
    first.close();

    first = await openStore({ dataDir });
    try {
      const listed = first.listActions().items;
      assert.deepEqual(listed.map((x) => [x.id, x.state]), [[pending.id, "previewed"], [a.id, "executed"]]);
      assert.equal(listed[1].result.tabId, 31);
      assert.equal(first.listActionAudit().total, 4);
      // The surviving preview is still decidable after the restart.
      assert.equal(first.decideAction(pending.id, "reject").state, "rejected");
      assert.equal(preview(first).id, pending.id + 1);
    } finally {
      first.close();
    }
  });
});

test("migration v3 creates the action tables and is recorded as a non-breaking migration (v4 later widens them for group actions)", async () => {
  await withTempDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    store.close();
    const raw = new DatabaseSync(join(dataDir, "browser-tabs.db"));
    try {
      const versions = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all().map((r) => r.version);
      assert.ok(versions.includes(3));
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);
      assert.ok(tables.includes("actions") && tables.includes("action_audit"));
    } finally {
      raw.close();
    }
    const { MIGRATIONS } = await import("../service/store.mjs");
    const v3 = MIGRATIONS.find((migration) => migration.version === 3);
    assert.equal(v3.breaking, false);
    assert.equal(MIGRATIONS.at(-1).version, 5);
    assert.equal(MIGRATIONS.at(-1).breaking, false);
  });
});

test("store.clear removes action records (which hold observed browser content) but never the audit log", async () => {
  await withStore(async (store) => {
    const a = preview(store);
    store.decideAction(a.id, "approve");
    store.recordActionResult(a.id, executedResult({ observed: observedTab({ title: "RETAINED-TITLE" }) }));
    const auditBefore = store.listActionAudit().items;

    const cleared = store.clearAll();
    assert.equal(cleared.deletedCounts.actions, 1);
    assert.equal(store.listActions().total, 0);
    assert.deepEqual(store.listActionAudit().items, auditBefore, "the audit log is untouched by clear");
    assert.equal(preview(store).id, a.id + 1, "action ids are never reused after a clear");
  });
});

test("store.clear is refused with a conflict, deleting nothing, while an approved action awaits its result; it succeeds once the result is terminal", async () => {
  await withStore(async (store) => {
    store.createTag({ name: "keep-me", creatorType: "user" });
    const a = preview(store);
    store.decideAction(a.id, "approve");
    const auditBefore = store.listActionAudit().items;

    assert.throws(() => store.clearAll(), (error) => error.code === "conflict" && /awaiting their result/.test(error.message));
    assert.equal(store.listTags().total, 1, "a refused clear deletes nothing at all");
    assert.equal(store.listActions({ id: a.id }).items[0].state, "approved");
    assert.deepEqual(store.listActionAudit().items, auditBefore);

    // The in-flight action still completes normally, into a record that still exists.
    assert.equal(store.recordActionResult(a.id, executedResult()).state, "executed");
    assert.equal(store.clearAll().deletedCounts.actions, 1);
    assert.equal(store.listTags().total, 0);
    assert.deepEqual(store.listActionAudit({ actionId: a.id }).items.map((e) => e.event), ["result", "approve", "preview"]);
  });
});

test("a clear that commits before an approval deletes the preview, so the approval is not found and records no event", async () => {
  await withStore(async (store) => {
    const a = preview(store);
    store.clearAll();
    assert.throws(() => store.decideAction(a.id, "approve"), (error) => error.code === "not_found");
    assert.throws(() => store.recordActionResult(a.id, executedResult()), (error) => error.code === "not_found");
    assert.deepEqual(store.listActionAudit({ actionId: a.id }).items.map((e) => e.event), ["preview"], "no decision or result for a deleted preview");
  });
});

// ---------------------------------------------------------------------------
// Store: crash/restart reconciliation
// ---------------------------------------------------------------------------

test("reconcileInterruptedActions fails every action found approved, with an unknown outcome and an audit result event, across a real close/reopen", async () => {
  await withTempDir(async (dataDir) => {
    let store = await openStore({ dataDir });
    const interrupted = preview(store);
    store.decideAction(interrupted.id, "approve");
    const alsoInterrupted = preview(store);
    store.decideAction(alsoInterrupted.id, "approve");
    const done = preview(store);
    store.decideAction(done.id, "approve");
    store.recordActionResult(done.id, executedResult());
    const rejected = preview(store);
    store.decideAction(rejected.id, "reject");
    const pending = preview(store);
    store.close(); // the "crash": two actions are persisted as approved

    store = await openStore({ dataDir });
    try {
      // Opening a store does not reconcile: it cannot tell a dead service's
      // action from one another process is executing right now.
      assert.deepEqual(store.listActions({ state: "approved" }).items.map((a) => a.id), [alsoInterrupted.id, interrupted.id]);
      assert.throws(() => store.clearAll(), (error) => error.code === "conflict", "an interrupted action blocks clear until reconciled");

      const before = Date.now();
      assert.deepEqual(store.reconcileInterruptedActions(), { reconciledCount: 2 });

      for (const id of [interrupted.id, alsoInterrupted.id]) {
        const action = store.listActions({ id }).items[0];
        assert.equal(action.state, "failed");
        assert.ok(action.completedAt >= before - 1000 && action.completedAt >= action.decidedAt);
        assert.deepEqual(action.result, {
          mutation: "unknown",
          code: "interrupted_by_restart",
          detail: ACTION_INTERRUPTED_DETAIL,
          tabId: null,
          windowId: null,
          observed: null,
        });
        assert.deepEqual(store.listActionAudit({ actionId: id }).items.map((e) => e.event), ["result", "approve", "preview"]);
        assert.deepEqual(store.listActionAudit({ actionId: id }).items[0].detail, { state: "failed", mutation: "unknown" });
        assert.throws(() => store.decideAction(id, "approve"), (error) => error.code === "conflict", "a reconciled action is terminal");
        assert.throws(() => store.recordActionResult(id, executedResult()), (error) => error.code === "conflict");
      }
      // Everything else is untouched.
      assert.equal(store.listActions({ id: done.id }).items[0].state, "executed");
      assert.equal(store.listActions({ id: rejected.id }).items[0].state, "rejected");
      assert.equal(store.listActions({ id: pending.id }).items[0].state, "previewed");
      assert.equal(store.listActionAudit({ actionId: done.id }).total, 3);

      // Idempotent: a second pass finds nothing and adds no event.
      const auditTotal = store.listActionAudit().total;
      assert.deepEqual(store.reconcileInterruptedActions(), { reconciledCount: 0 });
      assert.equal(store.listActionAudit().total, auditTotal);

      // And the clear that was blocked now works.
      assert.doesNotThrow(() => store.clearAll());
    } finally {
      store.close();
    }
  });
});

test("reconciled results survive another restart, and the audit log keeps exactly one result event per action", async () => {
  await withTempDataDirStore(async (dataDir, reopen) => {
    let store = await reopen();
    const a = preview(store);
    store.decideAction(a.id, "approve");
    store.close();
    store = await reopen();
    store.reconcileInterruptedActions();
    store.close();
    store = await reopen();
    try {
      assert.deepEqual(store.reconcileInterruptedActions(), { reconciledCount: 0 });
      assert.equal(store.listActions({ id: a.id }).items[0].state, "failed");
      assert.equal(store.listActionAudit({ actionId: a.id }).items.filter((e) => e.event === "result").length, 1);
    } finally {
      store.close();
    }
  });
});

async function withTempDataDirStore(run) {
  await withTempDir(async (dataDir) => {
    await run(dataDir, () => openStore({ dataDir }));
  });
}

test("previews awaiting a decision are bounded: the next one is refused, and deciding frees a slot", async () => {
  await withStore(async (store) => {
    const ids = [];
    for (let i = 0; i < MAX_PENDING_ACTIONS; i += 1) ids.push(preview(store, { url: `https://example.com/${i}` }).id);
    assert.throws(() => preview(store), (error) => error.code === "limit_reached");
    assert.equal(store.listActions().total, MAX_PENDING_ACTIONS, "the refused preview left nothing behind");
    store.decideAction(ids[0], "reject");
    assert.doesNotThrow(() => preview(store));
  });
});

test("a full audit log refuses new previews but still records the decision and result of work already in flight", async () => {
  await withStore(async (store) => {
    const inFlight = preview(store);
    const raw = new DatabaseSync(store.dbPath);
    try {
      raw.exec("BEGIN");
      const insert = raw.prepare("INSERT INTO action_audit (action_id, event, occurred_at, detail) VALUES (?, 'preview', 0, '{}')");
      const have = raw.prepare("SELECT COUNT(*) AS n FROM action_audit").get().n;
      for (let i = have; i < MAX_ACTION_AUDIT_EVENTS; i += 1) insert.run(9999);
      raw.exec("COMMIT");
    } finally {
      raw.close();
    }
    assert.throws(() => preview(store), (error) => error.code === "limit_reached" && /audit log is full/.test(error.message));
    assert.equal(store.listActions().total, 1);

    store.decideAction(inFlight.id, "approve");
    assert.equal(store.recordActionResult(inFlight.id, executedResult()).state, "executed");
    const events = store.listActionAudit({ actionId: inFlight.id }).items.map((e) => e.event);
    assert.deepEqual(events, ["result", "approve", "preview"], "no event for work in flight was dropped");
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

function connectAsExtension(port) {
  return new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: EXTENSION_ORIGIN });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once("message", (data) => resolve(JSON.parse(data.toString()))));
}

async function openAuthenticatedExtension(port, token = OWNER_TOKEN) {
  const ws = connectAsExtension(port);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  const reply = nextMessage(ws);
  ws.send(JSON.stringify({ type: "auth", protocolVersion: PROTOCOL_VERSION, token }));
  const message = await reply;
  assert.equal(message.type, "auth_ok");
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

function openedTab(overrides = {}) {
  return { tabId: 31, windowId: 2, index: 5, active: true, pinned: false, audible: false, discarded: false, status: "loading", title: "", url: "", ...overrides };
}

function okOpenTabResult(params, overrides = {}) {
  return { ...envelope("browser.open_tab"), created: true, requestedUrl: params.url, tab: openedTab(), pendingUrl: params.url, ...overrides };
}

const NO_RESPONSE = Symbol("no response");

// A stand-in extension. `openTab(params, ws)` produces the browser.open_tab
// result (or NO_RESPONSE to stay silent); every request it receives is
// recorded so a test can assert exactly what the service asked of the browser.
function installExtensionFake(ws, { openTab = okOpenTabResult, delayMs = 0 } = {}) {
  ws.requests = [];
  ws.on("message", async (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type !== "request") return;
    ws.requests.push({ method: message.method, params: message.params });
    let result;
    if (message.method === "browser.get_capabilities") {
      result = capabilitiesResult();
    } else if (message.method === "browser.open_tab") {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      result = await openTab(message.params, ws);
      if (result === NO_RESPONSE) return;
    } else {
      result = { ...envelope(message.method, "error"), code: "unsupported_in_test_fake" };
    }
    ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result }));
  });
}

const openRequests = (ws) => ws.requests.filter((r) => r.method === "browser.open_tab");

async function withActionService(run, { extension = {}, connectExtension = true, ...serviceOptions } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-actions-http-"));
  const store = await openStore({ dataDir });
  const service = createService({
    credentialToken: OWNER_TOKEN,
    agentCredentialToken: AGENT_TOKEN,
    store,
    rateLimitMaxRequests: 10_000,
    ...serviceOptions,
  });
  const address = await service.listen();
  const port = address.port;
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
    async reconnectExtension(options = extension) {
      ws = await openAuthenticatedExtension(port);
      installExtensionFake(ws, options);
      return ws;
    },
    async preview(url = URL_ONE) {
      const response = await owner("/api/action.open_tab.preview", { method: "POST", body: { url } });
      assert.equal(response.status, 200, JSON.stringify(response.json));
      return response.json.result;
    },
    decide: (operation, id) => owner(`/api/action.open_tab.${operation}?id=${id}`, { method: "POST" }),
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

test("preview records the normalized URL bound to the extension's own session, and opens nothing", async () => {
  await withActionService(async ({ preview, ws, owner }) => {
    const action = await preview("HTTPS://Example.COM/page");
    assert.equal(action.id, 1);
    assert.equal(action.state, "previewed");
    assert.equal(action.url, "https://example.com/page");
    assert.equal(action.browserSessionId, SESSION_ID);
    assert.equal(typeof action.previewedAt, "number");
    assert.deepEqual(
      ws.requests.map((r) => r.method),
      ["browser.get_capabilities"],
      "the session is learned from the extension; nothing is opened by a preview",
    );
    const listed = await owner("/api/store.actions.list");
    assert.deepEqual(listed.json.result.items, [action]);
  });
});

test("preview accepts exactly one body field, a valid absolute http(s) URL, and contacts the extension for nothing else", async () => {
  await withActionService(async ({ owner, ws, store }) => {
    const bodies = [
      { rawBody: "" },
      { rawBody: "not json" },
      { rawBody: "[]" },
      { rawBody: '"https://example.com/"' },
      { rawBody: "null" },
      { body: {} },
      { body: { url: "https://example.com/", browserSessionId: SESSION_ID } },
      { body: { url: "https://example.com/", extra: 1 } },
      { body: { href: "https://example.com/" } },
      { body: { url: 5 } },
      { body: { url: "" } },
      { body: { url: "javascript:alert(1)" } },
      { body: { url: "data:text/html,hi" } },
      { body: { url: "file:///etc/passwd" } },
      { body: { url: "chrome://settings" } },
      { body: { url: "https://user:pass@example.com/" } },
      { body: { url: "example.com" } },
      { body: { url: "/relative" } },
      { body: { url: " https://example.com/" } },
      { body: { url: `https://example.com/${"a".repeat(3000)}` } },
    ];
    for (const input of bodies) {
      const response = await owner("/api/action.open_tab.preview", { method: "POST", ...input });
      assert.equal(response.status, 400, `${JSON.stringify(input).slice(0, 80)} -> ${response.status} ${JSON.stringify(response.json)}`);
      assert.match(response.json.error.code, /^(validation_error|malformed_body)$/);
    }
    assert.equal(ws.requests.length, 0, "an invalid preview never reaches the extension");
    assert.equal(store.listActions().total, 0);
    assert.equal(store.listActionAudit().total, 0);
  });
});

test("preview refuses an oversized request body as 413", async () => {
  await withActionService(async ({ owner, ws, store }) => {
    const response = await owner("/api/action.open_tab.preview", {
      method: "POST",
      rawBody: JSON.stringify({ url: `https://example.com/${"a".repeat(40_000)}` }),
    });
    assert.equal(response.status, 413);
    assert.equal(response.json.error.code, "payload_too_large");
    assert.equal(ws.requests.length, 0);
    assert.equal(store.listActions().total, 0);
  });
});

test("preview fails explicitly as disconnected when no extension is connected, storing nothing", async () => {
  await withActionService(
    async ({ owner, store }) => {
      const response = await owner("/api/action.open_tab.preview", { method: "POST", body: { url: URL_ONE } });
      assert.equal(response.status, 503);
      assert.equal(response.json.error.code, "disconnected");
      assert.equal(store.listActions().total, 0);
    },
    { connectExtension: false },
  );
});

test("preview rejects an extension answer that is not a valid capabilities result", async () => {
  await withActionService(async ({ owner, store, ws }) => {
    ws.removeAllListeners("message");
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ type: "response", protocolVersion: PROTOCOL_VERSION, id: message.id, result: { garbage: true } }));
    });
    const response = await owner("/api/action.open_tab.preview", { method: "POST", body: { url: URL_ONE } });
    assert.equal(response.status, 502);
    assert.equal(response.json.error.code, "invalid_extension_response");
    assert.equal(store.listActions().total, 0);
  });
});

test("preview is refused with limit_reached once too many previews await a decision", async () => {
  await withActionService(async ({ preview, owner }) => {
    for (let i = 0; i < MAX_PENDING_ACTIONS; i += 1) await preview(`https://example.com/${i}`);
    const response = await owner("/api/action.open_tab.preview", { method: "POST", body: { url: URL_ONE } });
    assert.equal(response.status, 409);
    assert.equal(response.json.error.code, "limit_reached");
  });
});

// ---------------------------------------------------------------------------
// HTTP: authorization — the owner alone, and the agent never
// ---------------------------------------------------------------------------

test("every action route and action listing rejects a missing or wrong credential", async () => {
  await withActionService(async ({ port, ws, store }) => {
    const routes = [
      { method: "POST", path: "/api/action.open_tab.preview", body: { url: URL_ONE } },
      { method: "POST", path: "/api/action.open_tab.approve?id=1" },
      { method: "POST", path: "/api/action.open_tab.reject?id=1" },
      { method: "GET", path: "/api/store.actions.list" },
      { method: "GET", path: "/api/store.actions.audit.list" },
    ];
    for (const route of routes) {
      const none = await httpRequest({ port, ...route });
      assert.equal(none.status, 401, route.path);
      assert.equal(none.json.error.code, "missing_credential");
      const wrong = await httpRequest({ port, token: "wrong", ...route });
      assert.equal(wrong.status, 401, route.path);
      assert.equal(wrong.json.error.code, "invalid_credential");
    }
    assert.equal(ws.requests.length, 0);
    assert.equal(store.listActions().total, 0);
  });
});

test("the external-agent credential cannot preview, approve, reject, or list actions or the audit log", async () => {
  await withActionService(async ({ port, preview, ws, store }) => {
    const action = await preview();
    const requestsBefore = ws.requests.length;
    const routes = [
      { method: "POST", path: "/api/action.open_tab.preview", body: { url: URL_ONE } },
      { method: "POST", path: `/api/action.open_tab.approve?id=${action.id}` },
      { method: "POST", path: `/api/action.open_tab.reject?id=${action.id}` },
      { method: "GET", path: "/api/store.actions.list" },
      { method: "GET", path: "/api/store.actions.audit.list" },
    ];
    for (const route of routes) {
      const response = await httpRequest({ port, token: AGENT_TOKEN, ...route });
      assert.equal(response.status, 403, `${route.method} ${route.path}: ${JSON.stringify(response.json)}`);
      assert.equal(response.json.error.code, "forbidden_scope");
    }
    assert.equal(ws.requests.length, requestsBefore, "a forbidden request never reaches the extension");
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed", "and decides nothing");
    assert.equal(store.listActions().total, 1);
  });
});

test("browser.open_tab has no HTTP route at all, for either credential, as a GET or a POST", async () => {
  await withActionService(async ({ port, ws }) => {
    for (const token of [OWNER_TOKEN, AGENT_TOKEN]) {
      for (const method of ["GET", "POST"]) {
        for (const path of [
          `/api/browser.open_tab?url=${encodeURIComponent(URL_ONE)}&browserSessionId=${SESSION_ID}`,
          "/api/browser.open_url",
          "/api/action.open_tab",
          "/api/action.open_tab.execute?id=1",
          "/api/workflow.open_tab",
          "/api/store.actions.create",
          "/api/store.actions.update?id=1",
          "/api/store.actions.delete?id=1",
          "/api/store.actions.audit.delete",
          "/api/store.actions.audit.update?id=1",
        ]) {
          const response = await httpRequest({ port, path, method, token, body: method === "POST" ? { url: URL_ONE } : undefined });
          assert.equal(response.status, 404, `${method} ${path} as ${token === OWNER_TOKEN ? "owner" : "agent"} -> ${response.status}`);
        }
      }
    }
    assert.equal(ws.requests.length, 0);
  });
});

test("the action and audit read routes accept only their own HTTP method, so none can mutate", async () => {
  await withActionService(async ({ owner, preview, store }) => {
    const action = await preview();
    const before = JSON.stringify([store.listActions(), store.listActionAudit()]);
    for (const method of ["POST", "PATCH", "DELETE", "PUT"]) {
      for (const path of ["/api/store.actions.list", "/api/store.actions.audit.list"]) {
        const response = await owner(path, { method });
        assert.equal(response.status, 405, `${method} ${path}`);
      }
    }
    for (const method of ["GET", "PATCH", "DELETE"]) {
      const response = await owner(`/api/action.open_tab.approve?id=${action.id}`, { method });
      assert.equal(response.status, 405, `${method} approve`);
      const rejectResponse = await owner(`/api/action.open_tab.reject?id=${action.id}`, { method });
      assert.equal(rejectResponse.status, 405, `${method} reject`);
      const previewResponse = await owner("/api/action.open_tab.preview", { method });
      assert.equal(previewResponse.status, 405, `${method} preview`);
    }
    assert.equal(JSON.stringify([store.listActions(), store.listActionAudit()]), before);
  });
});

test("a request using the previous protocol version (2) is rejected before any action route runs", async () => {
  await withActionService(async ({ port, ws }) => {
    const response = await httpRequest({
      port,
      method: "POST",
      path: "/api/action.open_tab.preview",
      token: OWNER_TOKEN,
      body: { url: URL_ONE },
      extraHeaders: { "x-protocol-version": "2" },
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "unsupported_protocol_version");
    assert.equal(ws.requests.length, 0);
  });
});

// ---------------------------------------------------------------------------
// HTTP: approve
// ---------------------------------------------------------------------------

test("approve executes exactly the previewed URL in exactly the previewed session, once, and records the observed state", async () => {
  await withActionService(async ({ preview, decide, ws, owner }) => {
    const action = await preview("https://example.com/page?q=1#frag");
    const response = await decide("approve", action.id);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    const done = response.json.result;
    assert.equal(done.id, action.id);
    assert.equal(done.state, "executed");
    assert.equal(done.url, action.url);
    assert.equal(done.browserSessionId, action.browserSessionId);
    assert.equal(done.previewedAt, action.previewedAt);
    assert.ok(done.decidedAt >= done.previewedAt && done.completedAt >= done.decidedAt);
    assert.deepEqual(done.result, {
      mutation: "created",
      code: null,
      detail: null,
      tabId: 31,
      windowId: 2,
      observed: { index: 5, active: true, status: "loading", title: "", url: "", pendingUrl: action.url },
    });

    const opens = openRequests(ws);
    assert.equal(opens.length, 1, "exactly one browser.open_tab request");
    assert.deepEqual(opens[0].params, { url: action.url, browserSessionId: SESSION_ID });

    const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
    assert.deepEqual(audit.map((e) => e.event), ["result", "approve", "preview"]);
    assert.deepEqual(audit[0].detail, { state: "executed", mutation: "created" });
  });
});

test("a decided action can never be decided or executed again", async () => {
  await withActionService(async ({ preview, decide, ws }) => {
    const action = await preview();
    assert.equal((await decide("approve", action.id)).status, 200);
    for (const operation of ["approve", "reject", "approve"]) {
      const again = await decide(operation, action.id);
      assert.equal(again.status, 409, operation);
      assert.equal(again.json.error.code, "conflict");
    }
    assert.equal(openRequests(ws).length, 1, "no duplicate execution");
  });
});

test("approve and reject take the action id alone: no body, no other parameter, a valid id", async () => {
  await withActionService(async ({ owner, preview, ws, store }) => {
    const action = await preview();
    for (const operation of ["approve", "reject"]) {
      const attempts = [
        { path: `/api/action.open_tab.${operation}?id=${action.id}`, body: { url: "https://evil.example/" } },
        { path: `/api/action.open_tab.${operation}?id=${action.id}`, rawBody: "{}" },
        { path: `/api/action.open_tab.${operation}?id=${action.id}&url=${encodeURIComponent("https://evil.example/")}` },
        { path: `/api/action.open_tab.${operation}?id=${action.id}&browserSessionId=other` },
        { path: `/api/action.open_tab.${operation}` },
        { path: `/api/action.open_tab.${operation}?id=` },
        { path: `/api/action.open_tab.${operation}?id=0` },
        { path: `/api/action.open_tab.${operation}?id=-1` },
        { path: `/api/action.open_tab.${operation}?id=1.5` },
        { path: `/api/action.open_tab.${operation}?id=abc` },
        { path: `/api/action.open_tab.${operation}?url=${encodeURIComponent(URL_ONE)}` },
      ];
      for (const { path, ...input } of attempts) {
        const response = await owner(path, { method: "POST", ...input });
        assert.equal(response.status, 400, `${operation} ${path} ${JSON.stringify(input)} -> ${response.status}`);
        assert.equal(response.json.error.code, "validation_error");
      }
    }
    assert.equal(openRequests(ws).length, 0);
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed", "none of the refused requests decided anything");
    assert.equal(store.listActionAudit({ actionId: action.id }).total, 1);
  });
});

test("approve and reject of an unknown action id are 404 and execute nothing", async () => {
  await withActionService(async ({ decide, ws }) => {
    for (const operation of ["approve", "reject"]) {
      const response = await decide(operation, 12345);
      assert.equal(response.status, 404);
      assert.equal(response.json.error.code, "not_found");
    }
    assert.equal(openRequests(ws).length, 0);
  });
});

test("reject records the decision and opens nothing, and a rejected action cannot then be approved", async () => {
  await withActionService(async ({ preview, decide, ws, owner }) => {
    const action = await preview();
    const response = await decide("reject", action.id);
    assert.equal(response.status, 200);
    assert.equal(response.json.result.state, "rejected");
    assert.equal(response.json.result.result, null);
    assert.ok(response.json.result.decidedAt >= action.previewedAt);

    const approve = await decide("approve", action.id);
    assert.equal(approve.status, 409);
    assert.equal(openRequests(ws).length, 0, "a rejected preview is never executed");

    const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
    assert.deepEqual(audit.map((e) => e.event), ["reject", "preview"]);
  });
});

test("approve while the extension is disconnected is refused without consuming the preview, which can be approved later", async () => {
  await withActionService(async ({ preview, decide, ws, store, port, reconnectExtension }) => {
    const action = await preview();
    ws.close();
    await waitFor(async () => (await httpRequest({ port, path: "/health" })).json.extension.connected === false, { what: "extension disconnect" });

    const refused = await decide("approve", action.id);
    assert.equal(refused.status, 503);
    assert.equal(refused.json.error.code, "disconnected");
    assert.equal(store.listActions({ id: action.id }).items[0].state, "previewed", "the preview is still awaiting a decision");
    assert.equal(store.listActionAudit({ actionId: action.id }).total, 1);

    const reconnected = await reconnectExtension();
    const approved = await decide("approve", action.id);
    assert.equal(approved.status, 200);
    assert.equal(approved.json.result.state, "executed");
    assert.equal(openRequests(reconnected).length, 1);
  });
});

test("a stale_session refusal by the extension is a terminal 'stale' outcome with no mutation", async () => {
  await withActionService(
    async ({ preview, decide, ws, owner }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200);
      assert.equal(response.json.result.state, "stale");
      assert.deepEqual(response.json.result.result, {
        mutation: "none",
        code: "stale_session",
        detail: "browserSessionId is missing or does not match the current browser session",
        tabId: null,
        windowId: null,
        observed: null,
      });
      assert.equal(openRequests(ws).length, 1);
      assert.equal((await decide("approve", action.id)).status, 409, "a stale action is terminal; a new preview is needed");
      assert.equal(openRequests(ws).length, 1);
      const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
      assert.deepEqual(audit[0].detail, { state: "stale", mutation: "none" });
    },
    {
      extension: {
        openTab: () => ({
          ...envelope("browser.open_tab", "error", "a-newer-session"),
          code: "stale_session",
          detail: "browserSessionId is missing or does not match the current browser session",
          created: false,
        }),
      },
    },
  );
});

test("a partial outcome (tab created, observation failed) is reported as partial with created handles, and never retried", async () => {
  await withActionService(
    async ({ preview, decide, ws, owner }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200);
      const done = response.json.result;
      assert.equal(done.state, "partial");
      assert.deepEqual(done.result, { mutation: "created", code: "observe_failed", detail: "No tab with id: 31", tabId: 31, windowId: 2, observed: null });
      assert.equal(openRequests(ws).length, 1);
      assert.equal((await decide("approve", action.id)).status, 409);
      assert.equal(openRequests(ws).length, 1, "a partial outcome is not retried: that would open a second tab");
      const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
      assert.deepEqual(audit[0].detail, { state: "partial", mutation: "created" });
    },
    {
      extension: {
        openTab: () => ({ ...envelope("browser.open_tab", "incomplete"), code: "observe_failed", detail: "No tab with id: 31", created: true, tabId: 31, windowId: 2 }),
      },
    },
  );
});

test("an extension failure that created nothing is a terminal 'failed' outcome with mutation none", async () => {
  await withActionService(
    async ({ preview, decide }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200);
      assert.equal(response.json.result.state, "failed");
      assert.equal(response.json.result.result.mutation, "none");
      assert.equal(response.json.result.result.code, "open_tab_failed");
      assert.equal(response.json.result.result.detail, "No window with id: 9");
    },
    {
      extension: {
        openTab: () => ({ ...envelope("browser.open_tab", "error"), code: "open_tab_failed", detail: "No window with id: 9", created: false }),
      },
    },
  );
});

test("an unusable extension answer is a 'failed' outcome with mutation unknown, never forwarded as success", async () => {
  const cases = {
    "a legacy peer's bare unknown_method error (no created flag)": () => ({ ...envelope("browser.open_tab", "error"), code: "unknown_method" }),
    "a result for the wrong method": () => ({ ...okOpenTabResult({ url: URL_ONE }), sourceOperation: "browser.read_tab" }),
    "an ok result with no observed tab": () => ({ ...envelope("browser.open_tab"), created: true, requestedUrl: URL_ONE }),
    "an answer for a different session": (params) => okOpenTabResult(params, { browserSessionId: "some-other-session" }),
    "an answer for a different URL": () => okOpenTabResult({ url: "https://evil.example/" }),
    "a non-object": () => "ok",
  };
  for (const [name, openTab] of Object.entries(cases)) {
    await withActionService(
      async ({ preview, decide }) => {
        const action = await preview();
        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, name);
        assert.equal(response.json.result.state, "failed", name);
        assert.equal(response.json.result.result.mutation, "unknown", name);
        assert.equal(response.json.result.result.code, "invalid_extension_response", name);
        assert.equal(response.json.result.result.observed, null, name);
      },
      { extension: { openTab } },
    );
  }
});

test("an extension that never answers yields a failed outcome with mutation unknown, and the action is not retried", async () => {
  await withActionService(
    async ({ preview, decide, ws }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200);
      assert.equal(response.json.result.state, "failed");
      assert.equal(response.json.result.result.mutation, "unknown");
      assert.equal(response.json.result.result.code, "request_timeout");
      assert.match(response.json.result.result.detail, /may or may not/);
      assert.equal((await decide("approve", action.id)).status, 409);
      assert.equal(openRequests(ws).length, 1);
    },
    { requestTimeoutMs: 150, extension: { openTab: () => NO_RESPONSE } },
  );
});

test("an extension that disconnects mid-request yields a failed outcome with mutation unknown", async () => {
  await withActionService(
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
        openTab: (_params, ws) => {
          ws.close();
          return NO_RESPONSE;
        },
      },
    },
  );
});

test("an observed title, URL, status, and detail are clipped to their bounds before being stored", async () => {
  await withActionService(
    async ({ preview, decide, owner }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      const { observed } = response.json.result.result;
      assert.equal(observed.title.length, 500);
      assert.equal(observed.url.length, 2048);
      assert.equal(observed.pendingUrl.length, 2048);
      assert.equal(observed.status.length, 50);
      const listed = await owner("/api/store.actions.list");
      assert.equal(listed.json.result.items[0].result.observed.title.length, 500);
    },
    {
      extension: {
        openTab: (params) =>
          okOpenTabResult(params, {
            tab: openedTab({ title: "T".repeat(10_000), url: `https://example.org/${"u".repeat(5000)}`, status: "s".repeat(500) }),
            pendingUrl: `https://example.org/${"p".repeat(5000)}`,
          }),
      },
    },
  );
});

test("an observed tab with an empty status string still gets its result recorded (as status \"unknown\"), never leaving the action approved", async () => {
  await withActionService(
    async ({ preview, decide, store }) => {
      const action = await preview();
      const response = await decide("approve", action.id);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.equal(response.json.result.state, "executed");
      assert.equal(response.json.result.result.observed.status, "unknown");
      assert.equal(store.listActions({ id: action.id }).items[0].state, "executed");
    },
    { extension: { openTab: (params) => okOpenTabResult(params, { tab: openedTab({ status: "" }) }) } },
  );
});

// ---------------------------------------------------------------------------
// HTTP: exactly-once under concurrency
// ---------------------------------------------------------------------------

test("concurrent approve and reject requests for one preview yield exactly one decision and at most one execution", async () => {
  await withActionService(
    async ({ preview, decide, ws, store }) => {
      const plans = [
        ["approve", "approve", "approve", "approve", "approve", "approve"],
        ["reject", "approve", "approve", "reject"],
        ["approve", "reject", "reject", "approve", "approve"],
        ["reject", "reject", "reject"],
      ];
      for (const plan of plans) {
        const action = await preview(`https://example.com/race/${plan.join("-")}`);
        const opensBefore = openRequests(ws).length;
        const responses = await Promise.all(plan.map((operation) => decide(operation, action.id)));

        const winners = responses.filter((r) => r.status === 200);
        const losers = responses.filter((r) => r.status !== 200);
        assert.equal(winners.length, 1, `plan ${plan.join(",")}: exactly one decision wins`);
        assert.equal(losers.length, plan.length - 1);
        for (const loser of losers) {
          assert.equal(loser.status, 409);
          assert.equal(loser.json.error.code, "conflict");
        }

        const winningState = winners[0].json.result.state;
        assert.ok(winningState === "executed" || winningState === "rejected", winningState);
        const opens = openRequests(ws).length - opensBefore;
        assert.equal(opens, winningState === "executed" ? 1 : 0, `plan ${plan.join(",")}: executed at most once, and only if approved`);
        assert.equal(store.listActions({ id: action.id }).items[0].state, winningState);
        const events = store.listActionAudit({ actionId: action.id }).items.map((e) => e.event);
        assert.deepEqual(events, winningState === "executed" ? ["result", "approve", "preview"] : ["reject", "preview"]);
      }
    },
    { extension: { delayMs: 60 } },
  );
});

test("concurrent approvals of different previews each execute their own URL exactly once", async () => {
  await withActionService(
    async ({ preview, decide, ws }) => {
      const actions = [];
      for (let i = 0; i < 5; i += 1) actions.push(await preview(`https://example.com/many/${i}`));
      const responses = await Promise.all(actions.map((a) => decide("approve", a.id)));
      assert.ok(responses.every((r) => r.status === 200 && r.json.result.state === "executed"));
      const opened = openRequests(ws).map((r) => r.params.url).sort();
      assert.deepEqual(opened, actions.map((a) => a.url).sort());
    },
    { extension: { delayMs: 30 } },
  );
});

// ---------------------------------------------------------------------------
// HTTP: listing, audit, and clear
// ---------------------------------------------------------------------------

test("the owner can list actions (filtered, paginated, bounded) and the audit log", async () => {
  await withActionService(async ({ preview, decide, owner }) => {
    const a = await preview("https://example.com/a");
    const b = await preview("https://example.com/b");
    await preview("https://example.com/c");
    await decide("approve", a.id);
    await decide("reject", b.id);

    const all = (await owner("/api/store.actions.list")).json.result;
    assert.equal(all.total, 3);
    assert.deepEqual(all.items.map((x) => x.state), ["previewed", "rejected", "executed"], "newest first");
    assert.deepEqual((await owner("/api/store.actions.list?state=executed")).json.result.items.map((x) => x.id), [a.id]);
    assert.equal((await owner("/api/store.actions.list?limit=1&offset=1")).json.result.items[0].id, b.id);
    assert.equal((await owner(`/api/store.actions.list?id=${a.id}`)).json.result.total, 1);

    for (const query of ["limit=201", "limit=0", "offset=-1", "state=bogus", "id=0", "limit="]) {
      const bad = await owner(`/api/store.actions.list?${query}`);
      assert.equal(bad.status, 400, query);
      assert.equal(bad.json.error.code, "validation_error");
    }

    const audit = (await owner("/api/store.actions.audit.list")).json.result;
    assert.equal(audit.total, 3 + 1 + 1 + 1, "three previews, one approve, one result, one reject");
    assert.equal((await owner(`/api/store.actions.audit.list?actionId=${b.id}`)).json.result.total, 2);
    for (const query of ["limit=201", "actionId=0", "actionId=abc", "offset=-1"]) {
      const bad = await owner(`/api/store.actions.audit.list?${query}`);
      assert.equal(bad.status, 400, query);
    }
  });
});

test("the HTTP-visible audit log carries no URL, title, or other browser content", async () => {
  await withActionService(
    async ({ preview, decide, owner }) => {
      const action = await preview("https://private.example/secret-path?token=abc");
      await decide("approve", action.id);
      const text = JSON.stringify((await owner("/api/store.actions.audit.list")).json);
      for (const secret of ["private.example", "secret-path", "token=abc", "SECRET-TAB-TITLE", "landed.example"]) {
        assert.ok(!text.includes(secret), `the audit log leaked ${secret}`);
      }
      assert.doesNotMatch(text, /sha|hash|digest/i, "the audit log carries no URL hash or derivative either");
    },
    {
      extension: {
        openTab: (params) => okOpenTabResult(params, { tab: openedTab({ title: "SECRET-TAB-TITLE", url: "https://landed.example/x" }) }),
      },
    },
  );
});

test("a hostile extension's codes, details, titles, URLs, statuses, and handles reach the action record (clipped) but never the audit log", async () => {
  await withActionService(
    async ({ preview, decide, owner }) => {
      const refused = await preview("https://example.com/refused");
      const opened = await preview("https://example.com/opened");
      const partial = await preview("https://example.com/partial");
      assert.equal((await decide("approve", refused.id)).json.result.result.code, "SECRET-CODE");
      assert.equal((await decide("approve", opened.id)).json.result.state, "executed");
      assert.equal((await decide("approve", partial.id)).json.result.state, "partial");

      const audit = (await owner("/api/store.actions.audit.list")).json.result;
      assert.equal(audit.total, 3 + 3 + 3);
      assertAuditContentFree(audit.items);
      const text = JSON.stringify(audit);
      for (const secret of ["SECRET-CODE", "SECRET-DETAIL", "SECRET-TITLE", "secret-status", "evil.example", SESSION_ID, "4242", "4343"]) {
        assert.ok(!text.includes(secret), `the audit log leaked extension-supplied data: ${secret}`);
      }
      // The clearable action record is where those values live.
      const record = (await owner(`/api/store.actions.list?id=${opened.id}`)).json.result.items[0];
      assert.equal(record.result.observed.title, "SECRET-TITLE");
      assert.equal(record.result.tabId, 4242);
    },
    {
      extension: {
        openTab: (params) => {
          if (params.url.endsWith("/refused")) {
            return { ...envelope("browser.open_tab", "error"), code: "SECRET-CODE", detail: "SECRET-DETAIL", created: false };
          }
          if (params.url.endsWith("/partial")) {
            return { ...envelope("browser.open_tab", "incomplete"), code: "observe_failed", detail: "SECRET-DETAIL", created: true, tabId: 4343, windowId: 4343 };
          }
          return okOpenTabResult(params, {
            tab: openedTab({ tabId: 4242, windowId: 4242, title: "SECRET-TITLE", url: "https://evil.example/x", status: "secret-status" }),
          });
        },
      },
    },
  );
});

test("store.clear removes action records over HTTP but the audit log survives and stays append-only", async () => {
  await withActionService(async ({ preview, decide, owner }) => {
    const action = await preview();
    await decide("approve", action.id);
    const auditBefore = (await owner("/api/store.actions.audit.list")).json.result;

    assert.equal((await owner("/api/store.clear", { method: "POST" })).status, 200);
    assert.equal((await owner("/api/store.actions.list")).json.result.total, 0);
    assert.deepEqual((await owner("/api/store.actions.audit.list")).json.result, auditBefore);

    // An approve of a cleared action is simply not found; it opens nothing.
    assert.equal((await decide("approve", action.id)).status, 404);
  });
});

test("store.clear during an in-flight approval is refused with 409 and deletes nothing; the approval then completes into an intact record", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withActionService(
    async ({ preview, decide, owner, ws, store }) => {
      await owner("/api/store.tags.create", { method: "POST", body: { name: "keep-me", creatorType: "user" } });
      const action = await preview();

      const approval = decide("approve", action.id); // held open by the extension fake
      await waitFor(() => openRequests(ws).length === 1, { what: "the mutation request to reach the extension" });
      assert.equal(store.listActions({ id: action.id }).items[0].state, "approved", "the mutation request is in flight");

      const refused = await owner("/api/store.clear", { method: "POST" });
      assert.equal(refused.status, 409);
      assert.equal(refused.json.error.code, "conflict");
      assert.equal(store.listTags().total, 1, "a refused clear deleted nothing");
      assert.equal(store.listActions({ id: action.id }).items[0].state, "approved");
      assert.equal(store.listActionAudit({ actionId: action.id }).items.length, 2, "no event was lost or added");

      release();
      const done = await approval;
      assert.equal(done.status, 200);
      assert.equal(done.json.result.state, "executed");
      assert.equal(done.json.result.result.tabId, 31);
      assert.equal(openRequests(ws).length, 1, "exactly one mutation request in total");

      assert.deepEqual(store.listActionAudit({ actionId: action.id }).items.map((e) => e.event), ["result", "approve", "preview"]);
      assert.equal((await owner("/api/store.clear", { method: "POST" })).status, 200, "once the result is terminal, clear proceeds");
      assert.equal(store.listActions().total, 0);
      assert.equal(store.listTags().total, 0);
      // No orphan: the audit log still holds exactly the one complete trail.
      assert.deepEqual(store.listActionAudit().items.map((e) => [e.actionId, e.event]), [
        [action.id, "result"],
        [action.id, "approve"],
        [action.id, "preview"],
      ]);
    },
    { extension: { openTab: async (params) => (await gate, okOpenTabResult(params)) } },
  );
});

test("store.clear before an approval deletes the preview, so the approval is a 404 that opens nothing and records no event", async () => {
  await withActionService(async ({ preview, decide, owner, ws, store }) => {
    const action = await preview();
    assert.equal((await owner("/api/store.clear", { method: "POST" })).status, 200);
    const approval = await decide("approve", action.id);
    assert.equal(approval.status, 404);
    assert.equal(approval.json.error.code, "not_found");
    assert.equal(openRequests(ws).length, 0, "nothing was sent to the browser");
    assert.deepEqual(store.listActionAudit({ actionId: action.id }).items.map((e) => e.event), ["preview"]);
    assert.equal(store.listActions().total, 0);
  });
});

test("concurrent store.clear and approve are always ordered one of the two safe ways: no orphan, no mutation without a recorded result", async () => {
  await withActionService(
    async ({ preview, decide, owner, ws, store }) => {
      const outcomes = new Set();
      for (let round = 0; round < 8; round += 1) {
        const action = await preview(`https://example.com/clear-race/${round}`);
        const opensBefore = openRequests(ws).length;
        const [approval, clear] = await Promise.all([decide("approve", action.id), owner("/api/store.clear", { method: "POST" })]);
        const opens = openRequests(ws).length - opensBefore;
        const events = store.listActionAudit({ actionId: action.id }).items.map((e) => e.event);

        if (approval.status === 404) {
          // Clear committed first: the preview is gone and the approval did nothing.
          outcomes.add("clear-first");
          assert.equal(clear.status, 200, `round ${round}`);
          assert.equal(opens, 0);
          assert.deepEqual(events, ["preview"]);
          assert.equal(store.listActions({ id: action.id }).total, 0);
        } else {
          // Approve committed first. The clear was refused while the result was
          // pending (409), or — only if it arrived after the result was already
          // recorded — ran normally; it can never run in between.
          outcomes.add("approve-first");
          assert.equal(approval.status, 200, `round ${round}`);
          assert.equal(approval.json.result.state, "executed");
          assert.equal(opens, 1);
          assert.deepEqual(events, ["result", "approve", "preview"]);
          assert.ok(clear.status === 409 || clear.status === 200, `clear status ${clear.status}`);
          if (clear.status === 409) {
            assert.equal(store.listActions({ id: action.id }).items[0].state, "executed");
            assert.equal((await owner("/api/store.clear", { method: "POST" })).status, 200);
          }
        }
        assert.equal(store.listActions({ state: "approved" }).total, 0, "nothing is left approved");
        assert.equal(store.listActions().total, 0, "the round ends with everything cleared");
      }
      assert.ok(outcomes.size >= 1);
    },
    { extension: { delayMs: 40 } },
  );
});

test("process restart: an action approved when the service is killed is reconciled to failed/unknown on the next start, and clear then works", async () => {
  await withTempDir(async (dataDir) => {
    const port = 20_000 + Math.floor(Math.random() * 10_000);
    const cliPath = fileURLToPath(new URL("../service/cli.mjs", import.meta.url));
    const env = { ...process.env, BROWSER_TABS_DATA_DIR: dataDir, BROWSER_TABS_PORT: String(port) };
    const children = [];
    const startService = () => {
      const child = spawn(process.execPath, [cliPath, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      children.push(child);
      return { child, getStdout: () => stdout };
    };
    const showToken = () =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cliPath, "show-token"], { env, stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        child.stdout.on("data", (chunk) => (out += chunk));
        child.on("error", reject);
        child.on("exit", () => resolve(out.trim()));
      });
    const waitHealthy = () =>
      waitFor(async () => {
        try {
          return (await httpRequest({ port, path: "/health" })).status === 200;
        } catch {
          return false;
        }
      }, { what: "the service to answer /health" });

    let extensionWs;
    try {
      const first = startService();
      await waitHealthy();
      const token = await showToken();
      extensionWs = await openAuthenticatedExtension(port, token);
      installExtensionFake(extensionWs, { openTab: () => NO_RESPONSE }); // the browser never answers: the action stays in flight

      const previewResponse = await httpRequest({ port, path: "/api/action.open_tab.preview", method: "POST", token, body: { url: URL_ONE } });
      assert.equal(previewResponse.status, 200, JSON.stringify(previewResponse.json));
      const id = previewResponse.json.result.id;
      const approval = httpRequest({ port, path: `/api/action.open_tab.approve?id=${id}`, method: "POST", token }).catch(() => null);
      await waitFor(() => openRequests(extensionWs).length === 1, { what: "the mutation request to reach the extension" });

      // While it is in flight, a clear is refused by the live service.
      const refused = await httpRequest({ port, path: "/api/store.clear", method: "POST", token });
      assert.equal(refused.status, 409);

      // The crash.
      const exited = new Promise((resolve) => first.child.once("exit", resolve));
      first.child.kill("SIGKILL");
      await exited;
      await approval;
      extensionWs.close();

      // What the crash left behind: approved, with no result.
      const afterCrash = await openStore({ dataDir });
      try {
        assert.equal(afterCrash.listActions({ id }).items[0].state, "approved");
        assert.deepEqual(afterCrash.listActionAudit({ actionId: id }).items.map((e) => e.event), ["approve", "preview"]);
      } finally {
        afterCrash.close();
      }

      // The restart reconciles it, before serving anything.
      const second = startService();
      await waitHealthy();
      await waitFor(() => /interrupted browser action/.test(second.getStdout()), { what: "the reconciliation log line" });
      const listed = await httpRequest({ port, path: `/api/store.actions.list?id=${id}`, token });
      const action = listed.json.result.items[0];
      assert.equal(action.state, "failed");
      assert.equal(typeof action.completedAt, "number");
      assert.ok(action.completedAt >= action.decidedAt);
      assert.equal(action.result.mutation, "unknown");
      assert.equal(action.result.code, "interrupted_by_restart");
      assert.equal(action.result.detail, ACTION_INTERRUPTED_DETAIL);
      const audit = (await httpRequest({ port, path: `/api/store.actions.audit.list?actionId=${id}`, token })).json.result.items;
      assert.deepEqual(audit.map((e) => e.event), ["result", "approve", "preview"]);
      assert.deepEqual(audit[0].detail, { state: "failed", mutation: "unknown" });

      assert.equal((await httpRequest({ port, path: "/api/store.clear", method: "POST", token })).status, 200, "clear works once nothing is stuck approved");
    } finally {
      extensionWs?.close();
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

// ---------------------------------------------------------------------------
// One service process per data directory (service.lock)
// ---------------------------------------------------------------------------

const CLI_PATH = fileURLToPath(new URL("../service/cli.mjs", import.meta.url));
const randomPort = () => 20_000 + Math.floor(Math.random() * 10_000);

function spawnServiceProcess(dataDir, port, command = "start") {
  const child = spawn(process.execPath, [CLI_PATH, command], {
    env: { ...process.env, BROWSER_TABS_DATA_DIR: dataDir, BROWSER_TABS_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, getStdout: () => stdout, getStderr: () => stderr };
}

// Spawns service processes for one test and kills any still running at the end.
async function withServiceProcesses(run) {
  const spawned = [];
  try {
    await run((dataDir, port, command) => {
      const service = spawnServiceProcess(dataDir, port, command);
      spawned.push(service);
      return service;
    });
  } finally {
    for (const { child } of spawned) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function waitHealthy(port) {
  return waitFor(
    async () => {
      try {
        return (await httpRequest({ port, path: "/health" })).status === 200;
      } catch {
        return false;
      }
    },
    { what: `the service on port ${port} to answer /health` },
  );
}

async function tokenFor(start, dataDir, port) {
  const shown = start(dataDir, port, "show-token");
  await shown.exited;
  return shown.getStdout().trim();
}

async function readLockFile(dataDir) {
  try {
    return (await readFile(join(dataDir, "service.lock"), "utf8")).trim();
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function exitedPid() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", ""]);
    child.once("exit", () => resolve(child.pid));
  });
}

test("a second service on the same data directory but a different port is refused, cannot reconcile a live approved action, and leaves the owner's lock alone", async () => {
  await withTempDir(async (dataDir) => {
    await withServiceProcesses(async (start) => {
      const port1 = randomPort();
      const port2 = port1 + 1;
      const first = start(dataDir, port1);
      await waitHealthy(port1);
      const token = await tokenFor(start, dataDir, port1);
      assert.equal(await readLockFile(dataDir), String(first.child.pid));

      const ws = await openAuthenticatedExtension(port1, token);
      installExtensionFake(ws, { openTab: () => NO_RESPONSE }); // the action stays genuinely in flight
      try {
        const created = await httpRequest({ port: port1, path: "/api/action.open_tab.preview", method: "POST", token, body: { url: URL_ONE } });
        const id = created.json.result.id;
        httpRequest({ port: port1, path: `/api/action.open_tab.approve?id=${id}`, method: "POST", token }).catch(() => null);
        await waitFor(() => openRequests(ws).length === 1, { what: "the mutation request to reach the extension" });
        const stateOf = async () => (await httpRequest({ port: port1, path: `/api/store.actions.list?id=${id}`, token })).json.result.items[0].state;
        assert.equal(await stateOf(), "approved");

        // A second start on a different port, same data directory.
        const second = start(dataDir, port2);
        const outcome = await second.exited;
        assert.equal(outcome.code, 1);
        assert.match(second.getStderr(), /Another Browser Tabs service \(pid \d+\) holds .*service\.lock/);
        assert.doesNotMatch(second.getStdout(), /interrupted|listening/i, "it neither reconciled nor listened");
        await assert.rejects(httpRequest({ port: port2, path: "/health" }), "the refused service never bound its port");

        // The live action was not touched, and the owner still owns the lock.
        assert.equal(await stateOf(), "approved");
        const audit = (await httpRequest({ port: port1, path: `/api/store.actions.audit.list?actionId=${id}`, token })).json.result.items;
        assert.deepEqual(audit.map((e) => e.event), ["approve", "preview"], "no result event was written by the refused service");
        assert.equal(await readLockFile(dataDir), String(first.child.pid));
      } finally {
        ws.close();
      }

      // A graceful stop removes the owner's own lock.
      first.child.kill("SIGTERM");
      await first.exited;
      assert.equal(await readLockFile(dataDir), null);
    });
  });
});

test("two services started at the same moment on the same data directory: exactly one wins the lock", async () => {
  await withTempDir(async (dataDir) => {
    await withServiceProcesses(async (start) => {
      const portA = randomPort();
      const portB = portA + 1;
      const a = start(dataDir, portA);
      const b = start(dataDir, portB);
      const loser = await Promise.race([a.exited.then((r) => ({ ...r, service: a })), b.exited.then((r) => ({ ...r, service: b }))]);
      // 1: refused by the lock. 0 is also possible if the winner had already
      // recorded its port (the pre-existing "already running" early return).
      assert.ok(loser.code === 1 || loser.code === 0, `unexpected exit code ${loser.code}`);
      const winner = loser.service === a ? b : a;
      await waitHealthy(winner === a ? portA : portB);
      assert.equal(await readLockFile(dataDir), String(winner.child.pid));
      assert.equal(winner.child.exitCode, null, "the winner is still running");
    });
  });
});

test("a stale lock (dead pid, empty, or garbage) is reclaimed, the new owner reconciles an interrupted action, and its own lock is removed on stop", async () => {
  const deadPid = await exitedPid();
  for (const content of [String(deadPid), "", "not-a-pid"]) {
    await withTempDir(async (dataDir) => {
      // A previous service died mid-approval, leaving its lock behind.
      const store = await openStore({ dataDir });
      const { id } = preview(store);
      store.decideAction(id, "approve");
      store.close();
      await writeFile(join(dataDir, "service.lock"), content);

      await withServiceProcesses(async (start) => {
        const port = randomPort();
        const service = start(dataDir, port);
        await waitHealthy(port);
        assert.equal(await readLockFile(dataDir), String(service.child.pid), `the stale lock ${JSON.stringify(content)} was replaced by the new owner's`);
        await waitFor(() => /interrupted browser action/.test(service.getStdout()), { what: "reconciliation" });
        const token = await tokenFor(start, dataDir, port);
        const action = (await httpRequest({ port, path: `/api/store.actions.list?id=${id}`, token })).json.result.items[0];
        assert.equal(action.state, "failed");
        assert.equal(action.result.code, "interrupted_by_restart");

        service.child.kill("SIGTERM");
        await service.exited;
        assert.equal(await readLockFile(dataDir), null, "the owner removes its own lock on graceful shutdown");
      });
    });
  }
});

test("a start that fails after taking the lock (port already in use) removes its own lock", async () => {
  await withTempDir(async (dataDir) => {
    const port = randomPort();
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(port, "127.0.0.1", resolve));
    try {
      await withServiceProcesses(async (start) => {
        const service = start(dataDir, port);
        const outcome = await service.exited;
        assert.notEqual(outcome.code, 0);
        assert.equal(await readLockFile(dataDir), null, "a failed start must not leave its lock behind");
      });
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

test("action previews and results are never written to the service log", async () => {
  const lines = [];
  await withActionService(
    async ({ preview, decide }) => {
      const action = await preview("https://private.example/secret-path");
      await decide("approve", action.id);
      for (const line of lines) {
        assert.ok(!String(line).includes("secret-path") && !String(line).includes(OWNER_TOKEN), `log line leaked content: ${line}`);
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

// Loads a fresh instance of the real extension worker against a mock browser
// whose tabs.create/tabs.get are recorded, and connects it to `port` through
// the real service client. Each instance has its own browserSessionId, like a
// browser session of its own.
async function startRealExtension(port, { tabs: tabsOverrides = {} } = {}) {
  const calls = { create: [], get: [] };
  const browser = {
    windows: { getAll: async () => [], get: async () => ({ id: 0 }) },
    tabs: {
      query: async () => [],
      create: async (properties) => {
        calls.create.push(properties);
        return { id: 77, windowId: 5 };
      },
      get: async (id) => {
        calls.get.push(id);
        return { id, windowId: 5, index: 3, active: true, status: "loading", title: "", url: "", pendingUrl: calls.create.at(-1)?.url };
      },
      ...tabsOverrides,
    },
    scripting: { executeScript: async () => [] },
    runtime: { onMessage: { addListener: () => {} } },
  };
  globalThis.chrome = browser;
  workerCase += 1;
  const worker = await import(`../extension/service-worker.js?actions-e2e=${workerCase}`);
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
  return { calls, sessionId, stop: () => client.stop() };
}

test("end to end: preview, then approve opens exactly one tab and reports the browser's observed state", async () => {
  await withActionService(
    async ({ port, preview, decide, owner }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview("HTTPS://Example.com/e2e?x=1");
        assert.equal(action.url, "https://example.com/e2e?x=1");
        assert.equal(action.browserSessionId, extension.sessionId);
        assert.deepEqual(extension.calls.create, [], "a preview opens nothing");

        const response = await decide("approve", action.id);
        assert.equal(response.status, 200, JSON.stringify(response.json));
        const done = response.json.result;
        assert.equal(done.state, "executed");
        assert.deepEqual(extension.calls.create, [{ url: "https://example.com/e2e?x=1", active: true }], "exactly one tabs.create, for the previewed URL");
        assert.deepEqual(extension.calls.get, [77], "the new tab was read back");
        assert.deepEqual(done.result, {
          mutation: "created",
          code: null,
          detail: null,
          tabId: 77,
          windowId: 5,
          observed: { index: 3, active: true, status: "loading", title: "", url: "", pendingUrl: "https://example.com/e2e?x=1" },
        });

        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(extension.calls.create.length, 1);

        const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
        assert.deepEqual(audit.map((e) => e.event), ["result", "approve", "preview"]);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: reject opens no tab at all", async () => {
  await withActionService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview();
        const response = await decide("reject", action.id);
        assert.equal(response.json.result.state, "rejected");
        assert.equal((await decide("approve", action.id)).status, 409);
        assert.deepEqual(extension.calls.create, []);
        assert.deepEqual(extension.calls.get, []);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: a preview taken in an earlier browser session is refused as stale and opens nothing", async () => {
  await withActionService(
    async ({ port, preview, decide, owner }) => {
      const before = await startRealExtension(port);
      const action = await preview();
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
        assert.deepEqual(after.calls.create, [], "the new session's browser was never asked to open anything");
        assert.deepEqual(before.calls.create, []);
        const audit = (await owner(`/api/store.actions.audit.list?actionId=${action.id}`)).json.result.items;
        assert.deepEqual(audit[0].detail.mutation, "none");
      } finally {
        after.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: tabs.create succeeding but tabs.get failing is reported as a partial outcome, with one tab created", async () => {
  await withActionService(
    async ({ port, preview, decide }) => {
      const extension = await startRealExtension(port, {
        tabs: {
          get: async () => {
            throw new Error("No tab with id: 77");
          },
        },
      });
      try {
        const action = await preview();
        const response = await decide("approve", action.id);
        assert.equal(response.json.result.state, "partial");
        assert.equal(response.json.result.result.mutation, "created");
        assert.equal(response.json.result.result.tabId, 77);
        assert.equal(response.json.result.result.observed, null);
        assert.equal(extension.calls.create.length, 1);
        assert.equal((await decide("approve", action.id)).status, 409);
        assert.equal(extension.calls.create.length, 1);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});

test("end to end: the agent credential cannot open a tab by any route, and the browser is never asked to", async () => {
  await withActionService(
    async ({ port, preview }) => {
      const extension = await startRealExtension(port);
      try {
        const action = await preview();
        for (const path of [
          `/api/action.open_tab.approve?id=${action.id}`,
          "/api/action.open_tab.preview",
          `/api/browser.open_tab?url=${encodeURIComponent(URL_ONE)}&browserSessionId=${extension.sessionId}`,
        ]) {
          const response = await httpRequest({ port, method: "POST", path, token: AGENT_TOKEN, body: path.endsWith("preview") ? { url: URL_ONE } : undefined });
          assert.ok(response.status === 403 || response.status === 404, `${path} -> ${response.status}`);
        }
        assert.deepEqual(extension.calls.create, []);
      } finally {
        extension.stop();
      }
    },
    { connectExtension: false },
  );
});
