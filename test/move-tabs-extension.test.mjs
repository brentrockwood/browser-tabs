// Phase 2 Action 3 ("move 1-100 selected tabs into an existing or new tab
// group"), extension side: the shared request/result validators in
// extension/protocol.js and the worker's read-only `inspectMoveTarget` and
// mutating `moveTabs`, against a stateful recorded mock browser — so each test
// can assert exactly how many times the browser was asked to change anything,
// with what, and what it looked like afterwards.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CODES,
  MAX_MOVE_TABS,
  PROTOCOL_VERSION,
  RESULT_SCHEMA_VERSION,
  normalizeMoveConfig,
  validateMethodResult,
} from "../extension/protocol.js";

const NEW = { destination: "new", windowId: 2, tabs: [{ tabId: 5, groupId: -1 }, { tabId: 6, groupId: 3 }] };
const EXISTING = {
  destination: "existing",
  windowId: 2,
  tabs: [{ tabId: 5, groupId: -1 }, { tabId: 6, groupId: 3 }],
  groupId: 10,
  expectedTitle: "Dest",
  expectedColor: "blue",
};

test("protocol version 5 or later is required for the move methods", () => {
  assert.ok(PROTOCOL_VERSION >= 5);
  assert.equal(MAX_MOVE_TABS, 100);
});

// ---------------------------------------------------------------------------
// Protocol: request validation
// ---------------------------------------------------------------------------

test("normalizeMoveConfig accepts a move into a new group, with or without a title/color, keeping only the bound fields", () => {
  assert.deepEqual(normalizeMoveConfig(NEW), {
    valid: true,
    config: { destination: "new", windowId: 2, tabs: [{ tabId: 5, groupId: -1 }, { tabId: 6, groupId: 3 }], title: null, color: null },
  });
  const withText = normalizeMoveConfig({
    ...NEW,
    title: "Work",
    color: "red",
    tabs: [{ tabId: 5, groupId: -1, title: "display only", url: "https://example.com/" }],
    junk: 1,
  });
  assert.deepEqual(withText.config, { destination: "new", windowId: 2, tabs: [{ tabId: 5, groupId: -1 }], title: "Work", color: "red" });
});

test("normalizeMoveConfig accepts a move into an existing group when at least one tab is not already in it", () => {
  assert.deepEqual(normalizeMoveConfig(EXISTING).config, { ...EXISTING, tabs: EXISTING.tabs });
  const some = { ...EXISTING, tabs: [{ tabId: 5, groupId: 10 }, { tabId: 6, groupId: 3 }] };
  assert.equal(normalizeMoveConfig(some).valid, true, "a tab already in the group may ride along");
});

test("normalizeMoveConfig bounds the tab list at 1..100 distinct tabs", () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ tabId: i, groupId: -1 }));
  assert.equal(normalizeMoveConfig({ ...NEW, tabs: many(100) }).valid, true);
  assert.equal(normalizeMoveConfig({ ...NEW, tabs: many(1) }).valid, true);
  assert.equal(normalizeMoveConfig({ ...NEW, tabs: many(101) }).valid, false);
  assert.equal(normalizeMoveConfig({ ...NEW, tabs: [] }).valid, false);
  assert.equal(normalizeMoveConfig({ ...NEW, tabs: [{ tabId: 5, groupId: -1 }, { tabId: 5, groupId: -1 }] }).valid, false, "duplicates");
});

test("normalizeMoveConfig refuses every malformed request", () => {
  for (const bad of [
    null,
    "move",
    {},
    { ...NEW, windowId: undefined },
    { ...NEW, windowId: -1 },
    { ...NEW, tabs: undefined },
    { ...NEW, tabs: "5" },
    { ...NEW, tabs: [5, 6] },
    { ...NEW, tabs: [null] },
    { ...NEW, tabs: [{ tabId: -1, groupId: -1 }] },
    { ...NEW, tabs: [{ tabId: "5", groupId: -1 }] },
    { ...NEW, tabs: [{ tabId: 1.5, groupId: -1 }] },
    { ...NEW, tabs: [{ tabId: 5 }] },
    { ...NEW, tabs: [{ tabId: 5, groupId: -2 }] },
    { ...NEW, tabs: [{ tabId: 5, groupId: "3" }] },
    { ...NEW, destination: "elsewhere" },
    { ...NEW, destination: undefined },
    { ...NEW, title: "" },
    { ...NEW, title: "t".repeat(101) },
    { ...NEW, title: "a\nb" },
    { ...NEW, title: 5 },
    { ...NEW, color: "gray" },
    { ...EXISTING, title: "Renamed" },
    { ...EXISTING, color: "red" },
    { ...EXISTING, groupId: undefined },
    { ...EXISTING, groupId: -1 },
    { ...EXISTING, expectedTitle: undefined },
    { ...EXISTING, expectedColor: "gray" },
    { ...EXISTING, tabs: [{ tabId: 5, groupId: 10 }, { tabId: 6, groupId: 10 }] }, // a no-op move
  ]) {
    assert.equal(normalizeMoveConfig(bad).valid, false, JSON.stringify(bad)?.slice(0, 100));
  }
});

// ---------------------------------------------------------------------------
// Protocol: result validation
// ---------------------------------------------------------------------------

function envelope(sourceOperation, status = "ok", extra = {}) {
  return { schemaVersion: RESULT_SCHEMA_VERSION, browserSessionId: "s", sourceOperation, capturedAt: 1, status, ...extra };
}

const GROUP_RECORD = { groupId: 20, windowId: 2, title: "Work", color: "red", collapsed: false };
const INSPECTED = (n = 1, overrides = {}) =>
  Array.from({ length: n }, (_, i) => ({ tabId: i + 5, windowId: 2, groupId: -1, pinned: false, title: "T", url: "https://example.com/", ...overrides }));

test("validateMethodResult accepts a browser.inspect_move_target result and checks every tab record and the group", () => {
  const op = "browser.inspect_move_target";
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tabs: INSPECTED(2), group: null })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tabs: INSPECTED(1, { groupId: 3, title: null, url: null }), group: GROUP_RECORD })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tabs: INSPECTED(100), group: null })).valid, true);
  for (const bad of [
    { tabs: INSPECTED(101), group: null },
    { tabs: [], group: null },
    { group: null },
    { tabs: INSPECTED(1) },
    { tabs: INSPECTED(1), group: undefined },
    { tabs: INSPECTED(1, { pinned: undefined }), group: null },
    { tabs: INSPECTED(1, { pinned: "no" }), group: null },
    { tabs: INSPECTED(1, { groupId: -2 }), group: null },
    { tabs: INSPECTED(1, { groupId: undefined }), group: null },
    { tabs: INSPECTED(1, { windowId: -1 }), group: null },
    { tabs: [null], group: null },
    { tabs: INSPECTED(1), group: { ...GROUP_RECORD, color: "mauve" } },
    { tabs: INSPECTED(1), group: { ...GROUP_RECORD, color: null } },
  ]) {
    assert.equal(validateMethodResult(op, envelope(op, "ok", bad)).valid, false, JSON.stringify(bad)?.slice(0, 100));
  }
  assert.equal(validateMethodResult(op, envelope(op, "unsupported", { code: "unsupported_feature" })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "error", { code: "stale_handle" })).valid, true);
});

test("validateMethodResult accepts a fully observed browser.move_tabs result and checks its fields", () => {
  const op = "browser.move_tabs";
  const tabs = [{ tabId: 5, windowId: 2, groupId: 20 }, { tabId: 6, windowId: 2, groupId: 20 }];
  const ok = envelope(op, "ok", { changed: true, destination: "new", group: GROUP_RECORD, tabs });
  assert.equal(validateMethodResult(op, ok).valid, true);
  assert.equal(validateMethodResult(op, { ...ok, destination: "existing" }).valid, true);
  assert.equal(validateMethodResult(op, { ...ok, changed: false }).valid, false, "an ok result must say the browser changed");
  assert.equal(validateMethodResult(op, { ...ok, changed: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...ok, destination: "elsewhere" }).valid, false);
  assert.equal(validateMethodResult(op, { ...ok, group: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...ok, tabs: [] }).valid, false);
  assert.equal(validateMethodResult(op, { ...ok, tabs: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...ok, tabs: [{ tabId: 5, windowId: 2 }] }).valid, false);
  assert.equal(validateMethodResult(op, { ...ok, tabs: [{ tabId: 5, windowId: 2, groupId: -2 }] }).valid, false);
});

test("validateMethodResult requires every non-ok browser.move_tabs result to state consistently whether the browser changed", () => {
  const op = "browser.move_tabs";
  const refusal = envelope(op, "error", { code: "stale_session", changed: false });
  assert.equal(validateMethodResult(op, refusal).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "unsupported", { code: "unsupported_feature", changed: false })).valid, true);
  assert.equal(validateMethodResult(op, { ...refusal, changed: undefined }).valid, false, "a legacy peer's bare unknown_method error has no changed flag");
  assert.equal(validateMethodResult(op, { ...refusal, changed: true }).valid, false);
  assert.equal(validateMethodResult(op, { ...refusal, status: "incomplete" }).valid, false);

  // `changed: null`: the one tabs.group call was attempted and its effect is unknown.
  const unknown = envelope(op, "error", { code: "group_failed", changed: null });
  assert.equal(validateMethodResult(op, unknown).valid, true);
  assert.equal(validateMethodResult(op, { ...unknown, code: "observe_failed" }).valid, true);
  assert.equal(validateMethodResult(op, { ...unknown, status: "incomplete" }).valid, false, "an unknown effect is never the partial outcome");
  assert.equal(validateMethodResult(op, { ...unknown, status: "unsupported" }).valid, false);
  assert.equal(validateMethodResult(op, { ...unknown, changed: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...unknown, code: undefined }).valid, false);

  // `changed: true`: a move is known; `tabIds` is null or the tabs actually observed.
  const partial = envelope(op, "incomplete", { code: "observe_failed", changed: true, groupId: 20, windowId: 2, tabIds: [5, 6] });
  assert.equal(validateMethodResult(op, partial).valid, true);
  assert.equal(validateMethodResult(op, { ...partial, code: "group_update_failed" }).valid, true);
  assert.equal(validateMethodResult(op, { ...partial, groupId: null, windowId: null }).valid, true);
  assert.equal(validateMethodResult(op, { ...partial, tabIds: null }).valid, true, "none observed / observation unavailable");
  assert.equal(validateMethodResult(op, { ...partial, tabIds: [6] }).valid, true, "an observed subset");
  assert.equal(validateMethodResult(op, { ...partial, tabIds: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...partial, tabIds: [] }).valid, false);
  assert.equal(validateMethodResult(op, { ...partial, tabIds: ["5"] }).valid, false);
  assert.equal(validateMethodResult(op, { ...partial, groupId: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...partial, code: "something_else" }).valid, false);
  assert.equal(validateMethodResult(op, { ...partial, status: "error" }).valid, false, "a change is never an ordinary error");
});

// ---------------------------------------------------------------------------
// Worker: a stateful recorded mock browser
// ---------------------------------------------------------------------------

let caseId = 0;

// Window 2 holds: tab 5 (ungrouped), tab 6 (alone in group 3 "Src"), tab 7
// (ungrouped), tab 8 (pinned), tab 11 (in group 10 "Dest"/blue), plus
// `extraTabs` ungrouped tabs. Tab 9 is in window 4. `tabs.group` really moves
// tabs, creates group 20 for a new group, and — like Chrome — removes any group
// left with no tabs, so a source group disappearing is observable. Overrides
// replace individual methods and receive a context with `get(id)` (the default
// tabs.get), the state maps, and the call log.
function mockBrowser({ supported = true, extraTabs = 0, overrides = {} } = {}) {
  const calls = { tabsGet: [], group: [], update: [], groupsGet: [] };
  const tabs = new Map();
  const addTab = (id, props) => tabs.set(id, { id, windowId: 2, groupId: -1, pinned: false, title: `Tab ${id}`, url: `https://example.com/${id}`, ...props });
  addTab(5);
  addTab(6, { groupId: 3 });
  addTab(7);
  addTab(8, { pinned: true });
  addTab(9, { windowId: 4 });
  addTab(11, { groupId: 10 });
  for (let i = 0; i < extraTabs; i += 1) addTab(100 + i);
  const groups = new Map([
    [3, { id: 3, windowId: 2, title: "Src", color: "red", collapsed: false }],
    [10, { id: 10, windowId: 2, title: "Dest", color: "blue", collapsed: false }],
  ]);
  const ctx = {
    tabs,
    groups,
    calls,
    get: async (id) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error(`No tab with id: ${id}`);
      return { ...tab };
    },
    getGroup: async (id) => {
      const group = groups.get(id);
      if (!group) throw new Error(`No group with id: ${id}`);
      return { ...group };
    },
  };
  const api = {
    windows: { getAll: async () => [], get: async () => ({ id: 0 }) },
    scripting: { executeScript: async () => [] },
    runtime: { onMessage: { addListener: () => {} } },
    tabs: {
      query: async () => [],
      get: async (id) => {
        calls.tabsGet.push(id);
        return overrides.tabsGet ? overrides.tabsGet(id, ctx) : ctx.get(id);
      },
    },
  };
  if (supported) {
    api.tabs.group = async (options) => {
      calls.group.push(options);
      if (overrides.group) return overrides.group(options, ctx);
      let groupId = options.groupId;
      if (groupId === undefined) {
        groupId = 20;
        groups.set(20, { id: 20, windowId: options.createProperties?.windowId ?? 2, title: "", color: "grey", collapsed: false });
      }
      for (const id of options.tabIds) tabs.get(id).groupId = groupId;
      for (const id of [...groups.keys()]) {
        if (![...tabs.values()].some((tab) => tab.groupId === id)) groups.delete(id); // an emptied group disappears
      }
      return groupId;
    };
    api.tabGroups = {
      get: async (id) => {
        calls.groupsGet.push(id);
        return overrides.groupsGet ? overrides.groupsGet(id, ctx) : ctx.getGroup(id);
      },
      update: async (id, props) => {
        calls.update.push({ id, props });
        if (overrides.update) return overrides.update(id, props, ctx);
        Object.assign(groups.get(id), props);
        return { ...groups.get(id) };
      },
    };
  }
  return { api, calls, tabs, groups };
}

async function loadWorker(options) {
  const browser = mockBrowser(options);
  globalThis.chrome = browser.api;
  caseId += 1;
  const mod = await import(`../extension/service-worker.js?move-case=${caseId}`);
  const session = (await mod.getCapabilities()).browserSessionId;
  return { mod, session, ...browser };
}

function assertEnvelope(result, { sourceOperation, status }) {
  assert.equal(result.schemaVersion, RESULT_SCHEMA_VERSION);
  assert.equal(typeof result.browserSessionId, "string");
  assert.equal(result.sourceOperation, sourceOperation);
  assert.equal(result.status, status);
}

const noChange = (calls) => {
  assert.deepEqual(calls.group, [], "tabs.group must not have been called");
  assert.deepEqual(calls.update, [], "tabGroups.update must not have been called");
};

// ---------------------------------------------------------------------------
// Worker: inspectMoveTarget (read-only)
// ---------------------------------------------------------------------------

test("inspectMoveTarget reports every tab's window, group membership, and pinned state in the order asked, and changes nothing", async () => {
  const { mod, calls } = await loadWorker();
  const result = await mod.inspectMoveTarget([6, 5, 8, 9], undefined);
  assertEnvelope(result, { sourceOperation: "browser.inspect_move_target", status: "ok" });
  assert.deepEqual(result.tabs, [
    { tabId: 6, windowId: 2, groupId: 3, pinned: false, title: "Tab 6", url: "https://example.com/6" },
    { tabId: 5, windowId: 2, groupId: -1, pinned: false, title: "Tab 5", url: "https://example.com/5" },
    { tabId: 8, windowId: 2, groupId: -1, pinned: true, title: "Tab 8", url: "https://example.com/8" },
    { tabId: 9, windowId: 4, groupId: -1, pinned: false, title: "Tab 9", url: "https://example.com/9" },
  ]);
  assert.equal(result.group, null);
  assert.equal(validateMethodResult("browser.inspect_move_target", result).valid, true);
  noChange(calls);
});

test("inspectMoveTarget also reports the existing destination group's window, title, and color", async () => {
  const { mod, calls } = await loadWorker();
  const result = await mod.inspectMoveTarget([5], 10);
  assert.deepEqual(result.group, { groupId: 10, windowId: 2, title: "Dest", color: "blue", collapsed: false });
  assert.equal(validateMethodResult("browser.inspect_move_target", result).valid, true);
  noChange(calls);
});

test("inspectMoveTarget reports a missing tab or group as a stale handle, and a tab whose membership cannot be determined too", async () => {
  const { mod } = await loadWorker();
  assert.equal((await mod.inspectMoveTarget([5, 404], undefined)).code, ERROR_CODES.STALE_HANDLE);
  assert.equal((await mod.inspectMoveTarget([5], 404)).code, ERROR_CODES.STALE_HANDLE);
  const odd = await loadWorker({ overrides: { tabsGet: async (id, ctx) => ({ ...(await ctx.get(id)), groupId: undefined }) } });
  assert.equal((await odd.mod.inspectMoveTarget([5], undefined)).code, ERROR_CODES.STALE_HANDLE);
  const wrong = await loadWorker({ overrides: { tabsGet: async () => ({ id: 6, windowId: 2, groupId: -1 }) } });
  assert.equal((await wrong.mod.inspectMoveTarget([5], undefined)).code, ERROR_CODES.STALE_HANDLE, "an answer for a different tab");
});

test("inspectMoveTarget requires 1..100 distinct valid tab ids and an optional valid group id", async () => {
  const { mod, calls } = await loadWorker();
  const many = (n) => Array.from({ length: n }, (_, i) => i);
  for (const [tabIds, groupId] of [
    [[], undefined],
    [undefined, undefined],
    ["5", undefined],
    [[5, 5], undefined],
    [[5, -1], undefined],
    [[5, "6"], undefined],
    [[5, 1.5], undefined],
    [many(101), undefined],
    [[5], -1],
    [[5], "10"],
  ]) {
    const result = await mod.inspectMoveTarget(tabIds, groupId);
    assert.equal(result.status, "error", JSON.stringify([tabIds, groupId])?.slice(0, 60));
    assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
  }
  assert.deepEqual(calls.tabsGet, []);
});

test("inspectMoveTarget answers unsupported, touching nothing, in a browser without tab groups", async () => {
  const { mod, calls } = await loadWorker({ supported: false });
  const result = await mod.inspectMoveTarget([5, 6], 10);
  assertEnvelope(result, { sourceOperation: "browser.inspect_move_target", status: "unsupported" });
  assert.equal(result.code, ERROR_CODES.UNSUPPORTED_FEATURE);
  assert.deepEqual(calls.tabsGet, []);
});

// ---------------------------------------------------------------------------
// Worker: moveTabs — success
// ---------------------------------------------------------------------------

test("a move into a new group names every tab and the window in one tabs.group call, applies the title/color once, and reports each tab read back", async () => {
  const { mod, session, calls, groups } = await loadWorker();
  assert.equal(groups.has(3), true);
  const result = await mod.moveTabs({ ...NEW, browserSessionId: session, title: "Work", color: "red" });

  assertEnvelope(result, { sourceOperation: "browser.move_tabs", status: "ok" });
  assert.equal(result.changed, true);
  assert.equal(result.destination, "new");
  assert.deepEqual(result.group, { groupId: 20, windowId: 2, title: "Work", color: "red", collapsed: false });
  assert.deepEqual(result.tabs, [{ tabId: 5, windowId: 2, groupId: 20 }, { tabId: 6, windowId: 2, groupId: 20 }]);
  assert.deepEqual(calls.group, [{ tabIds: [5, 6], createProperties: { windowId: 2 } }], "exactly one call with the whole list, in the previewed window");
  assert.deepEqual(calls.update, [{ id: 20, props: { title: "Work", color: "red" } }]);
  assert.equal(groups.has(3), false, "the emptied source group disappeared by itself");
  assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
});

test("a move into a new group without a title or color makes no update call, and sends only what was requested", async () => {
  {
    const { mod, session, calls } = await loadWorker();
    const result = await mod.moveTabs({ ...NEW, browserSessionId: session });
    assert.equal(result.status, "ok");
    assert.equal(result.group.color, "grey", "the browser's own default is what is reported");
    assert.deepEqual(calls.update, []);
  }
  {
    const { mod, session, calls } = await loadWorker();
    await mod.moveTabs({ ...NEW, browserSessionId: session, color: "green" });
    assert.deepEqual(calls.update, [{ id: 20, props: { color: "green" } }]);
  }
});

test("a move into an existing group names that group, never renames or recolors it, and reports its group and each tab read back", async () => {
  const { mod, session, calls } = await loadWorker();
  const result = await mod.moveTabs({ ...EXISTING, browserSessionId: session });
  assertEnvelope(result, { sourceOperation: "browser.move_tabs", status: "ok" });
  assert.equal(result.destination, "existing");
  assert.deepEqual(result.group, { groupId: 10, windowId: 2, title: "Dest", color: "blue", collapsed: false });
  assert.deepEqual(result.tabs, [{ tabId: 5, windowId: 2, groupId: 10 }, { tabId: 6, windowId: 2, groupId: 10 }]);
  assert.deepEqual(calls.group, [{ groupId: 10, tabIds: [5, 6] }]);
  assert.deepEqual(calls.update, []);
  assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
});

test("a move into an existing group may include a tab already in it", async () => {
  const { mod, session, calls } = await loadWorker();
  const request = { ...EXISTING, tabs: [{ tabId: 5, groupId: -1 }, { tabId: 11, groupId: 10 }] };
  const result = await mod.moveTabs({ ...request, browserSessionId: session });
  assert.equal(result.status, "ok");
  assert.deepEqual(calls.group, [{ groupId: 10, tabIds: [5, 11] }]);
});

test("a move of 100 tabs is one tabs.group call with all 100 ids", async () => {
  const { mod, session, calls } = await loadWorker({ extraTabs: 100 });
  const tabs = Array.from({ length: 100 }, (_, i) => ({ tabId: 100 + i, groupId: -1 }));
  const result = await mod.moveTabs({ destination: "new", windowId: 2, tabs, browserSessionId: session });
  assert.equal(result.status, "ok");
  assert.equal(result.tabs.length, 100);
  assert.equal(calls.group.length, 1);
  assert.deepEqual(calls.group[0].tabIds, tabs.map((t) => t.tabId));
  assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
});

// ---------------------------------------------------------------------------
// Worker: moveTabs — refusals that change nothing
// ---------------------------------------------------------------------------

test("every move request refuses a stale or missing browserSessionId first, before reading or changing anything", async () => {
  const { mod, calls } = await loadWorker();
  for (const request of [NEW, EXISTING, { destination: "nonsense" }, undefined]) {
    for (const session of ["not-the-current-session", "", undefined, null, 5]) {
      const result = await mod.moveTabs(request === undefined ? undefined : { ...request, browserSessionId: session });
      assertEnvelope(result, { sourceOperation: "browser.move_tabs", status: "error" });
      assert.equal(result.code, ERROR_CODES.STALE_SESSION);
      assert.equal(result.changed, false);
      assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
    }
  }
  assert.deepEqual(calls.tabsGet, []);
  assert.deepEqual(calls.groupsGet, []);
  noChange(calls);
});

test("a move re-validates its own parameters and never touches the browser for an invalid one", async () => {
  const { mod, session, calls } = await loadWorker();
  const dupes = { ...NEW, tabs: [{ tabId: 5, groupId: -1 }, { tabId: 5, groupId: -1 }] };
  for (const bad of [
    dupes,
    { ...NEW, tabs: [] },
    { ...NEW, tabs: Array.from({ length: 101 }, (_, i) => ({ tabId: i, groupId: -1 })) },
    { ...NEW, title: "" },
    { ...NEW, color: "gray" },
    { ...EXISTING, title: "Renamed" },
    { ...EXISTING, tabs: [{ tabId: 5, groupId: 10 }, { tabId: 6, groupId: 10 }] },
    { ...NEW, destination: "elsewhere" },
    { ...NEW, windowId: undefined },
  ]) {
    const result = await mod.moveTabs({ ...bad, browserSessionId: session });
    assert.equal(result.status, "error", JSON.stringify(bad).slice(0, 80));
    assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal(result.changed, false);
  }
  assert.deepEqual(calls.tabsGet, []);
  noChange(calls);
});

test("a move is refused as a state mismatch, changing nothing, when any selected tab's window, group, or pinned state changed", async () => {
  const scenarios = [
    ["a tab was grouped meanwhile", (b) => (b.tabs.get(5).groupId = 3)],
    ["a tab left its group meanwhile", (b) => (b.tabs.get(6).groupId = -1)],
    ["a tab moved to another group", (b) => (b.tabs.get(6).groupId = 10)],
    ["a tab moved window", (b) => (b.tabs.get(5).windowId = 4)],
    ["a tab was pinned", (b) => (b.tabs.get(6).pinned = true)],
  ];
  for (const [name, change] of scenarios) {
    for (const request of [NEW, EXISTING]) {
      const browser = await loadWorker();
      change(browser);
      const result = await browser.mod.moveTabs({ ...request, browserSessionId: browser.session });
      assert.equal(result.status, "error", name);
      assert.equal(result.code, ERROR_CODES.STATE_MISMATCH, name);
      assert.equal(result.changed, false);
      assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
      noChange(browser.calls);
    }
  }
});

test("a move into an existing group is refused as a state mismatch when the group was renamed, recolored, or moved window", async () => {
  for (const change of [(g) => (g.title = "Renamed"), (g) => (g.color = "red"), (g) => (g.windowId = 4), (g) => (g.title = "")]) {
    const browser = await loadWorker();
    change(browser.groups.get(10));
    const result = await browser.mod.moveTabs({ ...EXISTING, browserSessionId: browser.session });
    assert.equal(result.code, ERROR_CODES.STATE_MISMATCH);
    assert.equal(result.changed, false);
    noChange(browser.calls);
  }
});

test("a move is refused as a stale handle when a tab or the destination group is gone, or the browser answers for another one", async () => {
  {
    const browser = await loadWorker();
    browser.tabs.delete(6);
    const result = await browser.mod.moveTabs({ ...NEW, browserSessionId: browser.session });
    assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
    assert.equal(result.changed, false);
    noChange(browser.calls);
  }
  {
    const browser = await loadWorker();
    browser.groups.delete(10);
    const result = await browser.mod.moveTabs({ ...EXISTING, browserSessionId: browser.session });
    assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
    noChange(browser.calls);
  }
  for (const overrides of [{ tabsGet: async () => ({ id: 99, windowId: 2, groupId: -1 }) }, { tabsGet: async () => undefined }]) {
    const browser = await loadWorker({ overrides });
    const result = await browser.mod.moveTabs({ ...NEW, browserSessionId: browser.session });
    assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
    noChange(browser.calls);
  }
  {
    const browser = await loadWorker({ overrides: { groupsGet: async () => ({ id: 11, windowId: 2, title: "Dest", color: "blue" }) } });
    const result = await browser.mod.moveTabs({ ...EXISTING, browserSessionId: browser.session });
    assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
    noChange(browser.calls);
  }
});

test("a pinned tab is refused at action time even if it was not pinned at preview", async () => {
  const browser = await loadWorker();
  browser.tabs.get(5).pinned = true;
  const result = await browser.mod.moveTabs({ ...NEW, browserSessionId: browser.session });
  assert.equal(result.code, ERROR_CODES.STATE_MISMATCH);
  noChange(browser.calls);
});

test("a rejected tabs.group is reported as changed:null (effect unknown) — never changed:false — and is never retried or followed by an update", async () => {
  // A rejection can follow the browser having applied the move, so "nothing changed" is not claimed.
  for (const request of [NEW, EXISTING]) {
    const { mod, session, calls } = await loadWorker({
      overrides: {
        group: async (options, ctx) => {
          // The browser applies the move and then reports failure.
          for (const id of options.tabIds) ctx.tabs.get(id).groupId = options.groupId ?? 20;
          throw new Error("Tabs cannot be edited right now");
        },
      },
    });
    const result = await mod.moveTabs({ ...request, browserSessionId: session, title: request === NEW ? "Work" : undefined });
    assertEnvelope(result, { sourceOperation: "browser.move_tabs", status: "error" });
    assert.equal(result.code, ERROR_CODES.GROUP_FAILED);
    assert.equal(result.detail, "Tabs cannot be edited right now");
    assert.equal(result.changed, null);
    assert.equal(calls.group.length, 1);
    assert.deepEqual(calls.update, []);
    assert.equal(calls.groupsGet.length, request === EXISTING ? 1 : 0, "only the pre-move check; no read-back is attempted after an unknown effect");
    assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
  }
});

// ---------------------------------------------------------------------------
// Worker: moveTabs — partial outcomes (a move was made; no retry)
// ---------------------------------------------------------------------------

test("a new group whose title/color update fails is the explicit partial outcome (move known, no tab observed), and no retry", async () => {
  const { mod, session, calls } = await loadWorker({
    overrides: {
      update: async () => {
        throw new Error("No group with id: 20");
      },
    },
  });
  const result = await mod.moveTabs({ ...NEW, browserSessionId: session, title: "Work" });
  assertEnvelope(result, { sourceOperation: "browser.move_tabs", status: "incomplete" });
  assert.equal(result.code, ERROR_CODES.GROUP_UPDATE_FAILED);
  assert.equal(result.changed, true);
  assert.equal(result.groupId, 20);
  assert.equal(result.windowId, 2);
  assert.equal(result.tabIds, null, "the move is known, but no tab was observed in the group, so none is claimed");
  assert.equal(calls.group.length, 1, "the move is not repeated");
  assert.equal(calls.update.length, 1, "the update is not retried");
  assert.deepEqual(calls.groupsGet, [], "an unfinished change is not observed as if it were finished");
  assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
});

test("a move whose group or tabs cannot be read back is the partial outcome", async () => {
  {
    const { mod, session, calls } = await loadWorker({
      overrides: {
        groupsGet: async (id, ctx) => {
          if (ctx.calls.group.length > 0) throw new Error("No group with id");
          return ctx.getGroup(id);
        },
      },
    });
    const result = await mod.moveTabs({ ...EXISTING, browserSessionId: session });
    assert.equal(result.status, "incomplete");
    assert.equal(result.code, ERROR_CODES.OBSERVE_FAILED);
    assert.equal(result.changed, true);
    assert.equal(result.groupId, 10);
    assert.equal(result.tabIds, null, "observation was unavailable, so no tab is claimed observed");
    assert.equal(calls.group.length, 1);
    assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
  }
  {
    const { mod, session } = await loadWorker({
      overrides: {
        tabsGet: async (id, ctx) => {
          if (ctx.calls.group.length > 0) throw new Error(`No tab with id: ${id}`);
          return ctx.get(id);
        },
      },
    });
    const result = await mod.moveTabs({ ...NEW, browserSessionId: session });
    assert.equal(result.status, "incomplete");
    assert.equal(result.code, ERROR_CODES.OBSERVE_FAILED);
    assert.equal(result.groupId, 20);
    assert.equal(result.tabIds, null);
    assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
  }
});

test("a tab not observed in the destination group in the previewed window after the move is the partial outcome naming only the tabs that were observed", async () => {
  // The browser "moves" only the first tab.
  const half = async (options, ctx) => {
    ctx.tabs.get(options.tabIds[0]).groupId = options.groupId;
    return options.groupId;
  };
  {
    const { mod, session } = await loadWorker({ overrides: { group: half } });
    const result = await mod.moveTabs({ ...EXISTING, browserSessionId: session });
    assert.equal(result.status, "incomplete");
    assert.equal(result.code, ERROR_CODES.OBSERVE_FAILED);
    assert.equal(result.changed, true);
    assert.equal(result.groupId, 10);
    assert.match(result.detail, /tab 6 was not observed/);
    assert.deepEqual(result.tabIds, [5], "only the observed subset, not every requested tab");
    assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
  }
  {
    // Only the second of three tabs is seen in the group: an ordered subset, not a prefix.
    const { mod, session } = await loadWorker({
      overrides: {
        group: async (options, ctx) => {
          ctx.tabs.get(options.tabIds[1]).groupId = options.groupId;
          return options.groupId;
        },
      },
    });
    const request = { ...EXISTING, tabs: [{ tabId: 5, groupId: -1 }, { tabId: 7, groupId: -1 }, { tabId: 6, groupId: 3 }] };
    const result = await mod.moveTabs({ ...request, browserSessionId: session });
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.tabIds, [7]);
    assert.match(result.detail, /tab 5 was not observed/);
  }
  {
    // A new group where only the last tab landed in it.
    const { mod, session } = await loadWorker({
      overrides: {
        group: async (options, ctx) => {
          ctx.groups.set(20, { id: 20, windowId: 2, title: "", color: "grey", collapsed: false });
          ctx.tabs.get(options.tabIds[1]).groupId = 20;
          return 20;
        },
      },
    });
    const result = await mod.moveTabs({ ...NEW, browserSessionId: session });
    assert.equal(result.status, "incomplete");
    assert.equal(result.groupId, 20);
    assert.deepEqual(result.tabIds, [6]);
  }
  {
    // The tab ends up in another window.
    const { mod, session } = await loadWorker({
      overrides: {
        group: async (options, ctx) => {
          for (const id of options.tabIds) {
            ctx.tabs.get(id).groupId = options.groupId;
            ctx.tabs.get(id).windowId = 4;
          }
          return options.groupId;
        },
      },
    });
    const result = await mod.moveTabs({ ...EXISTING, browserSessionId: session });
    assert.equal(result.status, "incomplete");
    assert.equal(result.changed, true);
    assert.equal(result.tabIds, null, "none was observed in the previewed window");
  }
  {
    // The group is reported in another window.
    const { mod, session } = await loadWorker({
      overrides: {
        group: async (options, ctx) => {
          for (const id of options.tabIds) ctx.tabs.get(id).groupId = options.groupId;
          ctx.groups.get(options.groupId).windowId = 4;
          return options.groupId;
        },
      },
    });
    const result = await mod.moveTabs({ ...EXISTING, browserSessionId: session });
    assert.equal(result.status, "incomplete");
    assert.equal(result.code, ERROR_CODES.OBSERVE_FAILED);
    assert.equal(result.tabIds, null, "the destination could not be confirmed, so no tab is claimed observed in it");
  }
});

test("a new-group call that resolves with no usable group id is changed:null (effect unknown), not a move and not 'nothing', and nothing is applied to it", async () => {
  for (const returned of [undefined, null, -1, "20"]) {
    const { mod, session, calls } = await loadWorker({ overrides: { group: async () => returned } });
    const result = await mod.moveTabs({ ...NEW, browserSessionId: session, title: "Work" });
    assertEnvelope(result, { sourceOperation: "browser.move_tabs", status: "error" });
    assert.equal(result.code, ERROR_CODES.OBSERVE_FAILED, String(returned));
    assert.equal(result.changed, null, String(returned));
    assert.equal(calls.group.length, 1, "not retried");
    assert.deepEqual(calls.update, []);
    assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
  }
});

test("an existing-group call that resolves is a known move even when its return value is unusable (the group id is the bound one)", async () => {
  const { mod, session } = await loadWorker({
    overrides: {
      group: async (options, ctx) => {
        for (const id of options.tabIds) ctx.tabs.get(id).groupId = options.groupId;
        return undefined;
      },
    },
  });
  const result = await mod.moveTabs({ ...EXISTING, browserSessionId: session });
  assert.equal(result.status, "ok");
  assert.equal(result.group.groupId, 10);
});

// ---------------------------------------------------------------------------
// Worker: unsupported browsers and routing
// ---------------------------------------------------------------------------

test("moveTabs answers unsupported with changed:false, changing nothing, in a browser without tab groups (or without tabs.group)", async () => {
  {
    const { mod, session, calls } = await loadWorker({ supported: false });
    for (const request of [NEW, EXISTING]) {
      const result = await mod.moveTabs({ ...request, browserSessionId: session });
      assertEnvelope(result, { sourceOperation: "browser.move_tabs", status: "unsupported" });
      assert.equal(result.code, ERROR_CODES.UNSUPPORTED_FEATURE);
      assert.equal(result.changed, false);
      assert.equal(validateMethodResult("browser.move_tabs", result).valid, true);
    }
    assert.deepEqual(calls.tabsGet, []);
  }
  {
    const browser = mockBrowser();
    delete browser.api.tabs.group;
    globalThis.chrome = browser.api;
    caseId += 1;
    const mod = await import(`../extension/service-worker.js?move-case=${caseId}`);
    const session = (await mod.getCapabilities()).browserSessionId;
    const result = await mod.moveTabs({ ...NEW, browserSessionId: session });
    assert.equal(result.status, "unsupported");
    assert.equal(result.changed, false);
    assert.deepEqual(browser.calls.tabsGet, []);
  }
});

test("routeServiceMessage routes both move methods; the read-only routeMessage and runtime.onMessage cannot reach either", async () => {
  let listener;
  const browser = mockBrowser();
  browser.api.runtime = { onMessage: { addListener: (fn) => (listener = fn) } };
  globalThis.chrome = browser.api;
  caseId += 1;
  const mod = await import(`../extension/service-worker.js?move-case=${caseId}`);
  const session = (await mod.getCapabilities()).browserSessionId;

  const inspected = await mod.routeServiceMessage({ method: "browser.inspect_move_target", tabIds: [5, 6], groupId: 10 });
  assert.equal(inspected.status, "ok");
  assert.equal(inspected.tabs.length, 2);
  assert.equal(inspected.group.groupId, 10);
  const moved = await mod.routeServiceMessage({ method: "browser.move_tabs", browserSessionId: session, ...EXISTING });
  assert.equal(moved.status, "ok");
  assert.equal(browser.calls.group.length, 1);

  const before = browser.calls.group.length + browser.calls.update.length + browser.calls.tabsGet.length;
  for (const message of [
    { method: "browser.move_tabs", browserSessionId: session, ...NEW },
    { method: "browser.move_tabs", browserSessionId: session, ...EXISTING },
    { method: "browser.inspect_move_target", tabIds: [5] },
  ]) {
    for (const result of [await listener(message), await mod.routeMessage(message)]) {
      assert.equal(result.status, "error");
      assert.equal(result.code, "unknown_method");
    }
  }
  assert.equal(browser.calls.group.length + browser.calls.update.length + browser.calls.tabsGet.length, before, "an unknown method touches the browser not at all");
});
