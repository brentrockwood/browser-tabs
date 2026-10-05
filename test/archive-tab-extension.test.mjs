// Phase 2 Action 4 ("archive a tab: save a capture, then close exactly that
// tab"), extension side: the shared request/result validators in
// extension/protocol.js and the worker's read-only `inspectArchiveTarget` and
// mutating `closeTab`, against a recorded mock browser — so each test can
// assert exactly how many times the browser was asked to close anything, and
// whether it was still open afterwards.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ERROR_CODES,
  MAX_ARCHIVE_URL_LENGTH,
  PROTOCOL_VERSION,
  RESULT_SCHEMA_VERSION,
  normalizeArchiveConfig,
  validateMethodResult,
} from "../extension/protocol.js";

const BOUND = { tabId: 5, windowId: 2, url: "https://example.com/page", groupId: -1, pinned: false };

test("protocol version 6 or later is required for the archive methods", () => {
  assert.ok(PROTOCOL_VERSION >= 6);
  assert.equal(MAX_ARCHIVE_URL_LENGTH, 2048);
});

// ---------------------------------------------------------------------------
// Protocol: request validation
// ---------------------------------------------------------------------------

test("normalizeArchiveConfig accepts the bound tab state and returns only the bound fields", () => {
  assert.deepEqual(normalizeArchiveConfig(BOUND), { valid: true, config: BOUND });
  assert.deepEqual(normalizeArchiveConfig({ ...BOUND, groupId: 9, pinned: true, title: "display only", extra: 1 }).config, { ...BOUND, groupId: 9, pinned: true });
  assert.equal(normalizeArchiveConfig({ ...BOUND, url: "u".repeat(MAX_ARCHIVE_URL_LENGTH) }).valid, true, "the bound address may be exactly the maximum");
});

test("normalizeArchiveConfig refuses every malformed request, including an address that is missing or cannot be bound whole", () => {
  for (const bad of [
    null,
    "archive",
    {},
    { ...BOUND, tabId: -1 },
    { ...BOUND, tabId: "5" },
    { ...BOUND, tabId: 1.5 },
    { ...BOUND, tabId: undefined },
    { ...BOUND, windowId: undefined },
    { ...BOUND, windowId: -1 },
    { ...BOUND, url: undefined },
    { ...BOUND, url: null },
    { ...BOUND, url: "" },
    { ...BOUND, url: 5 },
    { ...BOUND, url: "u".repeat(MAX_ARCHIVE_URL_LENGTH + 1) },
    { ...BOUND, groupId: undefined },
    { ...BOUND, groupId: -2 },
    { ...BOUND, groupId: "3" },
    { ...BOUND, pinned: undefined },
    { ...BOUND, pinned: "no" },
    { ...BOUND, pinned: 0 },
  ]) {
    assert.equal(normalizeArchiveConfig(bad).valid, false, JSON.stringify(bad)?.slice(0, 90));
  }
});

// ---------------------------------------------------------------------------
// Protocol: result validation
// ---------------------------------------------------------------------------

function envelope(sourceOperation, status = "ok", extra = {}) {
  return { schemaVersion: RESULT_SCHEMA_VERSION, browserSessionId: "s", sourceOperation, capturedAt: 1, status, ...extra };
}

const INSPECTED = { tabId: 5, windowId: 2, groupId: -1, pinned: false, title: "A page", url: "https://example.com/page" };

test("validateMethodResult accepts a browser.inspect_archive_target result and checks the tab record", () => {
  const op = "browser.inspect_archive_target";
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: INSPECTED })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: { ...INSPECTED, groupId: 9, pinned: true } })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: { ...INSPECTED, title: null, url: null } })).valid, true, "the protocol allows a missing address; the service refuses to bind one");
  for (const bad of [
    undefined,
    null,
    { ...INSPECTED, pinned: undefined },
    { ...INSPECTED, pinned: "no" },
    { ...INSPECTED, groupId: -2 },
    { ...INSPECTED, groupId: undefined },
    { ...INSPECTED, tabId: -1 },
    { ...INSPECTED, windowId: undefined },
    { ...INSPECTED, url: 5 },
  ]) {
    assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: bad })).valid, false, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.equal(validateMethodResult(op, envelope(op, "unsupported", { code: "unsupported_feature" })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "error", { code: "stale_handle" })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "error")).valid, false, "a non-ok result needs a code");
});

test("validateMethodResult accepts a browser.close_tab result only if it states, consistently, whether the tab was closed", () => {
  const op = "browser.close_tab";
  const ok = envelope(op, "ok", { changed: true, tabId: 5, windowId: 2 });
  assert.equal(validateMethodResult(op, ok).valid, true);
  assert.equal(validateMethodResult(op, { ...ok, changed: false }).valid, false, "an ok result must say the tab closed");
  assert.equal(validateMethodResult(op, { ...ok, changed: null }).valid, false);
  assert.equal(validateMethodResult(op, { ...ok, changed: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...ok, tabId: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...ok, windowId: -1 }).valid, false);

  const refusal = envelope(op, "error", { code: "state_mismatch", changed: false });
  assert.equal(validateMethodResult(op, refusal).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "unsupported", { code: "unsupported_feature", changed: false })).valid, true);
  assert.equal(validateMethodResult(op, { ...refusal, changed: undefined }).valid, false, "a legacy peer's bare unknown_method error has no changed flag");
  assert.equal(validateMethodResult(op, { ...refusal, changed: true }).valid, false, "an error never claims the tab closed");
  assert.equal(validateMethodResult(op, { ...refusal, status: "incomplete" }).valid, false, "there is no partial close");

  const unknown = envelope(op, "error", { code: "close_failed", changed: null });
  assert.equal(validateMethodResult(op, unknown).valid, true, "a rejected tabs.remove: the effect is unknown");
  assert.equal(validateMethodResult(op, { ...unknown, status: "unsupported" }).valid, false);
  assert.equal(validateMethodResult(op, { ...unknown, status: "incomplete" }).valid, false);
  assert.equal(validateMethodResult(op, { ...unknown, code: undefined }).valid, false);
});

// ---------------------------------------------------------------------------
// Worker: a recorded mock browser
// ---------------------------------------------------------------------------

let caseId = 0;

// Tab 5 (window 2, ungrouped, not pinned, "https://example.com/page"), tab 6
// (window 2, in group 3, pinned), and tab 7 (a tab that reports no group at
// all, as a browser without tab groups does). `tabs.remove` really closes the
// tab. `supported: false` removes `tabs.remove`.
function mockBrowser({ supported = true, overrides = {} } = {}) {
  const calls = { get: [], remove: [] };
  const tabs = new Map([
    [5, { id: 5, windowId: 2, groupId: -1, pinned: false, title: "A page", url: "https://example.com/page" }],
    [6, { id: 6, windowId: 2, groupId: 3, pinned: true, title: "Pinned", url: "https://example.com/pinned" }],
    [7, { id: 7, windowId: 2, pinned: false, title: "No groups here", url: "https://example.com/plain" }],
  ]);
  const ctx = {
    tabs,
    calls,
    get: async (id) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return { ...tab };
    },
  };
  const api = {
    windows: { getAll: async () => [], get: async () => ({ id: 0 }) },
    scripting: { executeScript: async () => [] },
    runtime: { onMessage: { addListener: () => {} } },
    tabs: {
      query: async () => [],
      get: async (id) => {
        calls.get.push(id);
        return overrides.get ? overrides.get(id, ctx) : ctx.get(id);
      },
    },
  };
  if (supported) {
    api.tabs.remove = async (id) => {
      calls.remove.push(id);
      if (overrides.remove) return overrides.remove(id, ctx);
      tabs.delete(id);
    };
  }
  return { api, calls, tabs };
}

async function loadWorker(options) {
  const browser = mockBrowser(options);
  globalThis.chrome = browser.api;
  caseId += 1;
  const mod = await import(`../extension/service-worker.js?archive-case=${caseId}`);
  const session = (await mod.getCapabilities()).browserSessionId;
  return { mod, session, ...browser };
}

function assertEnvelope(result, { sourceOperation, status }) {
  assert.equal(result.schemaVersion, RESULT_SCHEMA_VERSION);
  assert.equal(typeof result.browserSessionId, "string");
  assert.equal(result.sourceOperation, sourceOperation);
  assert.equal(result.status, status);
}

// ---------------------------------------------------------------------------
// Worker: inspectArchiveTarget (read-only)
// ---------------------------------------------------------------------------

test("inspectArchiveTarget reports the one tab's window, group, pinned state, title, and address, and closes nothing", async () => {
  const { mod, calls, tabs } = await loadWorker();
  const result = await mod.inspectArchiveTarget(5);
  assertEnvelope(result, { sourceOperation: "browser.inspect_archive_target", status: "ok" });
  assert.deepEqual(result.tab, { tabId: 5, windowId: 2, groupId: -1, pinned: false, title: "A page", url: "https://example.com/page" });
  assert.equal(validateMethodResult("browser.inspect_archive_target", result).valid, true);
  const pinned = await mod.inspectArchiveTarget(6);
  assert.deepEqual([pinned.tab.groupId, pinned.tab.pinned], [3, true]);
  assert.deepEqual(calls.remove, []);
  assert.equal(tabs.size, 3);
});

test("a tab that reports no group at all is consistently ungrouped (-1), in inspection and in the close's re-check", async () => {
  const { mod, session, calls } = await loadWorker();
  const result = await mod.inspectArchiveTarget(7);
  assert.equal(result.tab.groupId, -1);
  const closed = await mod.closeTab({ ...BOUND, tabId: 7, url: "https://example.com/plain", browserSessionId: session });
  assert.equal(closed.status, "ok");
  assert.deepEqual(calls.remove, [7]);
});

test("inspectArchiveTarget reports a missing tab as a stale handle, a bad id as invalid, and an answer for another tab as stale", async () => {
  const { mod, calls } = await loadWorker();
  assert.equal((await mod.inspectArchiveTarget(404)).code, ERROR_CODES.STALE_HANDLE);
  for (const bad of [undefined, null, -1, "5", 1.5, [5]]) {
    const result = await mod.inspectArchiveTarget(bad);
    assert.equal(result.status, "error", String(bad));
    assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
  }
  const wrong = await loadWorker({ overrides: { get: async () => ({ id: 99, windowId: 2 }) } });
  assert.equal((await wrong.mod.inspectArchiveTarget(5)).code, ERROR_CODES.STALE_HANDLE);
  assert.deepEqual(calls.remove, []);
});

test("inspectArchiveTarget answers unsupported, reading nothing, in a browser without tabs.remove", async () => {
  const { mod, calls } = await loadWorker({ supported: false });
  const result = await mod.inspectArchiveTarget(5);
  assertEnvelope(result, { sourceOperation: "browser.inspect_archive_target", status: "unsupported" });
  assert.equal(result.code, ERROR_CODES.UNSUPPORTED_FEATURE);
  assert.deepEqual(calls.get, []);
});

// ---------------------------------------------------------------------------
// Worker: closeTab
// ---------------------------------------------------------------------------

test("closeTab calls tabs.remove exactly once for exactly the bound tab, after re-reading it, and a resolved call is a closed tab", async () => {
  const { mod, session, calls, tabs } = await loadWorker();
  const result = await mod.closeTab({ ...BOUND, browserSessionId: session });
  assertEnvelope(result, { sourceOperation: "browser.close_tab", status: "ok" });
  assert.equal(result.changed, true);
  assert.equal(result.tabId, 5);
  assert.equal(result.windowId, 2);
  assert.deepEqual(calls.get, [5], "the tab is re-read first");
  assert.deepEqual(calls.remove, [5], "exactly one tabs.remove, for exactly that tab");
  assert.equal(tabs.has(5), false);
  assert.equal(tabs.has(6), true, "no other tab is touched");
  assert.equal(validateMethodResult("browser.close_tab", result).valid, true);
});

test("closeTab closes a pinned or grouped tab when that is the state it is bound to", async () => {
  const { mod, session, calls } = await loadWorker();
  const result = await mod.closeTab({ tabId: 6, windowId: 2, url: "https://example.com/pinned", groupId: 3, pinned: true, browserSessionId: session });
  assert.equal(result.status, "ok");
  assert.deepEqual(calls.remove, [6]);
});

test("closeTab refuses a stale or missing browserSessionId first, before reading or closing anything", async () => {
  const { mod, calls } = await loadWorker();
  for (const request of [BOUND, { destination: "nonsense" }, undefined]) {
    for (const session of ["not-the-current-session", "", undefined, null, 5]) {
      const result = await mod.closeTab(request === undefined ? undefined : { ...request, browserSessionId: session });
      assertEnvelope(result, { sourceOperation: "browser.close_tab", status: "error" });
      assert.equal(result.code, ERROR_CODES.STALE_SESSION);
      assert.equal(result.changed, false);
      assert.equal(validateMethodResult("browser.close_tab", result).valid, true);
    }
  }
  assert.deepEqual(calls.get, []);
  assert.deepEqual(calls.remove, []);
});

test("closeTab re-validates its own parameters and never touches the browser for an invalid one", async () => {
  const { mod, session, calls } = await loadWorker();
  for (const bad of [
    { ...BOUND, url: undefined },
    { ...BOUND, url: "" },
    { ...BOUND, url: "u".repeat(MAX_ARCHIVE_URL_LENGTH + 1) },
    { ...BOUND, tabId: -1 },
    { ...BOUND, windowId: undefined },
    { ...BOUND, groupId: -2 },
    { ...BOUND, pinned: undefined },
  ]) {
    const result = await mod.closeTab({ ...bad, browserSessionId: session });
    assert.equal(result.status, "error", JSON.stringify(bad).slice(0, 80));
    assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal(result.changed, false);
  }
  assert.deepEqual(calls.get, []);
  assert.deepEqual(calls.remove, []);
});

test("closeTab leaves the tab open, as a state mismatch, when its window, address, group, or pinned state changed — including a reused tab at another address", async () => {
  const scenarios = [
    ["the window changed", (t) => (t.windowId = 4)],
    ["the address changed", (t) => (t.url = "https://example.com/other")],
    ["the address gained a fragment", (t) => (t.url = "https://example.com/page#x")],
    ["the address was cleared", (t) => (t.url = "")],
    ["the tab was grouped", (t) => (t.groupId = 3)],
    ["the tab was pinned", (t) => (t.pinned = true)],
  ];
  for (const [name, change] of scenarios) {
    const browser = await loadWorker();
    change(browser.tabs.get(5));
    const result = await browser.mod.closeTab({ ...BOUND, browserSessionId: browser.session });
    assert.equal(result.status, "error", name);
    assert.equal(result.code, ERROR_CODES.STATE_MISMATCH, name);
    assert.equal(result.changed, false, name);
    assert.equal(validateMethodResult("browser.close_tab", result).valid, true);
    assert.deepEqual(browser.calls.remove, [], `${name}: tabs.remove must not be called`);
    assert.equal(browser.tabs.has(5), true);
  }
  // A bound pinned/grouped tab that is no longer.
  const browser = await loadWorker();
  const result = await browser.mod.closeTab({ tabId: 6, windowId: 2, url: "https://example.com/pinned", groupId: 3, pinned: false, browserSessionId: browser.session });
  assert.equal(result.code, ERROR_CODES.STATE_MISMATCH);
  assert.deepEqual(browser.calls.remove, []);
});

test("closeTab leaves the tab alone, as a stale handle, when it is gone or the browser answers for another tab", async () => {
  {
    const browser = await loadWorker();
    browser.tabs.delete(5);
    const result = await browser.mod.closeTab({ ...BOUND, browserSessionId: browser.session });
    assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
    assert.equal(result.changed, false);
    assert.deepEqual(browser.calls.remove, []);
  }
  for (const get of [async () => ({ id: 6, windowId: 2, groupId: 3, pinned: false, url: BOUND.url }), async () => undefined]) {
    const browser = await loadWorker({ overrides: { get } });
    const result = await browser.mod.closeTab({ ...BOUND, browserSessionId: browser.session });
    assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
    assert.deepEqual(browser.calls.remove, []);
  }
});

test("a rejected tabs.remove is changed:null (effect unknown) — never changed:false — even when the browser closed the tab, and is never retried", async () => {
  const { mod, session, calls, tabs } = await loadWorker({
    overrides: {
      remove: async (id, ctx) => {
        ctx.tabs.delete(id); // the browser closes the tab, then reports failure
        throw new Error("Tabs cannot be edited right now");
      },
    },
  });
  const result = await mod.closeTab({ ...BOUND, browserSessionId: session });
  assertEnvelope(result, { sourceOperation: "browser.close_tab", status: "error" });
  assert.equal(result.code, ERROR_CODES.CLOSE_FAILED);
  assert.equal(result.detail, "Tabs cannot be edited right now");
  assert.equal(result.changed, null);
  assert.equal(calls.remove.length, 1, "never retried");
  assert.equal(tabs.has(5), false, "which is exactly why 'nothing changed' cannot be claimed");
  assert.equal(validateMethodResult("browser.close_tab", result).valid, true);
});

test("closeTab answers unsupported with changed:false, reading nothing, in a browser without tabs.remove", async () => {
  const { mod, session, calls } = await loadWorker({ supported: false });
  const result = await mod.closeTab({ ...BOUND, browserSessionId: session });
  assertEnvelope(result, { sourceOperation: "browser.close_tab", status: "unsupported" });
  assert.equal(result.code, ERROR_CODES.UNSUPPORTED_FEATURE);
  assert.equal(result.changed, false);
  assert.equal(validateMethodResult("browser.close_tab", result).valid, true);
  assert.deepEqual(calls.get, []);
});

test("inspectArchiveTarget reports the effective address: a non-empty pendingUrl (a navigation under way) over the committed url", async () => {
  const B = "https://example.com/next";
  const browser = await loadWorker();
  const tab = browser.tabs.get(5);

  tab.pendingUrl = B; // Chrome: url is still the committed page A while the navigation to B is pending
  assert.equal((await browser.mod.inspectArchiveTarget(5)).tab.url, B);
  assert.equal(validateMethodResult("browser.inspect_archive_target", await browser.mod.inspectArchiveTarget(5)).valid, true);

  tab.pendingUrl = ""; // an empty pendingUrl is no pending navigation
  assert.equal((await browser.mod.inspectArchiveTarget(5)).tab.url, "https://example.com/page");
  delete tab.pendingUrl;
  assert.equal((await browser.mod.inspectArchiveTarget(5)).tab.url, "https://example.com/page");

  tab.url = ""; // a new tab: no committed address yet, only the pending one
  tab.pendingUrl = B;
  assert.equal((await browser.mod.inspectArchiveTarget(5)).tab.url, B);

  delete tab.pendingUrl; // neither: the service refuses to bind this, so it is reported as null
  assert.equal((await browser.mod.inspectArchiveTarget(5)).tab.url, "");
  delete tab.url;
  const none = await browser.mod.inspectArchiveTarget(5);
  assert.equal(none.tab.url, null);
  assert.equal(validateMethodResult("browser.inspect_archive_target", none).valid, true);
  assert.deepEqual(browser.calls.remove, []);
});

test("closeTab compares the same effective address: a navigation to B pending since the preview of A leaves the tab open", async () => {
  const B = "https://example.com/next";
  // Previewed at A; a navigation to B has since begun (url is still A, pendingUrl is B).
  {
    const browser = await loadWorker();
    browser.tabs.get(5).pendingUrl = B;
    const result = await browser.mod.closeTab({ ...BOUND, browserSessionId: browser.session });
    assert.equal(result.code, ERROR_CODES.STATE_MISMATCH);
    assert.equal(result.changed, false);
    assert.deepEqual(browser.calls.remove, [], "tabs.remove must not be called");
    assert.equal(browser.tabs.has(5), true);
  }
  // Previewed while B was pending (bound to B): closes only while that still holds.
  {
    const browser = await loadWorker();
    browser.tabs.get(5).pendingUrl = B;
    const result = await browser.mod.closeTab({ ...BOUND, url: B, browserSessionId: browser.session });
    assert.equal(result.status, "ok");
    assert.deepEqual(browser.calls.remove, [5]);
  }
  {
    const browser = await loadWorker();
    browser.tabs.get(5).pendingUrl = B;
    const result = await browser.mod.closeTab({ ...BOUND, url: B, browserSessionId: browser.session });
    assert.equal(result.status, "ok");
    // ...and the same bound B is refused when the pending navigation went elsewhere or ended back at A.
    const again = await loadWorker();
    again.tabs.get(5).pendingUrl = "https://example.com/third";
    assert.equal((await again.mod.closeTab({ ...BOUND, url: B, browserSessionId: again.session })).code, ERROR_CODES.STATE_MISMATCH);
    const settled = await loadWorker(); // navigation finished at A: no pending address, url A
    assert.equal((await settled.mod.closeTab({ ...BOUND, url: B, browserSessionId: settled.session })).code, ERROR_CODES.STATE_MISMATCH);
    assert.deepEqual([again.calls.remove, settled.calls.remove], [[], []]);
  }
  // An empty pendingUrl is not a pending navigation: bound A still matches.
  {
    const browser = await loadWorker();
    browser.tabs.get(5).pendingUrl = "";
    assert.equal((await browser.mod.closeTab({ ...BOUND, browserSessionId: browser.session })).status, "ok");
  }
});

test("closeTab calls tabs.remove with no await between its final state check and the call", () => {
  const source = readFileSync(fileURLToPath(new URL("../extension/service-worker.js", import.meta.url)), "utf8");
  const body = source.slice(source.indexOf("export async function closeTab"), source.indexOf("// Shared by the extension's own runtime.onMessage listener"));
  assert.match(
    body,
    /STATE_MISMATCH[^\n]*\n\s+\}\n\n\s+try \{\n\s+await browserApi\.tabs\.remove\(config\.tabId\);/,
    "tabs.remove follows the final state check directly",
  );
  assert.equal([...body.matchAll(/tabs\.remove\(/g)].length, 1, "exactly one call site");
  const between = body.slice(body.indexOf("Boolean(tab.pinned) !== config.pinned"), body.indexOf("await browserApi.tabs.remove("));
  assert.doesNotMatch(between, /await/, "no await between the check and the call");
});

test("routeServiceMessage routes both archive methods; the read-only routeMessage and runtime.onMessage cannot reach either", async () => {
  let listener;
  const browser = mockBrowser();
  browser.api.runtime = { onMessage: { addListener: (fn) => (listener = fn) } };
  globalThis.chrome = browser.api;
  caseId += 1;
  const mod = await import(`../extension/service-worker.js?archive-case=${caseId}`);
  const session = (await mod.getCapabilities()).browserSessionId;

  const inspected = await mod.routeServiceMessage({ method: "browser.inspect_archive_target", tabId: 5 });
  assert.equal(inspected.status, "ok");
  assert.equal(inspected.tab.tabId, 5);
  const closed = await mod.routeServiceMessage({ method: "browser.close_tab", browserSessionId: session, ...BOUND });
  assert.equal(closed.status, "ok");
  assert.deepEqual(browser.calls.remove, [5]);

  const before = browser.calls.remove.length + browser.calls.get.length;
  for (const message of [
    { method: "browser.close_tab", browserSessionId: session, ...BOUND, tabId: 6 },
    { method: "browser.inspect_archive_target", tabId: 6 },
  ]) {
    for (const result of [await listener(message), await mod.routeMessage(message)]) {
      assert.equal(result.status, "error");
      assert.equal(result.code, "unknown_method");
    }
  }
  assert.equal(browser.calls.remove.length + browser.calls.get.length, before, "an unknown method touches the browser not at all");
  assert.equal(browser.tabs.has(6), true);
});
