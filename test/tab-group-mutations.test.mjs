// The three direct tab-group mutations, extension side: the shared request
// validators and result validators in extension/protocol.js, and the worker's
// `createTabGroup`, `updateTabGroup`, and `moveTabs` against a stateful,
// recorded mock browser — so each test can assert exactly how many times the
// browser was asked to change anything, with what, and what it looked like
// afterwards.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CODES,
  MAX_GROUP_TITLE_LENGTH,
  MAX_TAB_IDS,
  RESULT_SCHEMA_VERSION,
  TAB_GROUP_COLORS,
  isValidGroupColor,
  isValidGroupTitle,
  normalizeCreateTabGroupRequest,
  normalizeMoveTabsRequest,
  normalizeUpdateTabGroupRequest,
  validateMethodResult,
} from "../extension/protocol.js";

const CREATE = "browser.create_tab_group";
const UPDATE = "browser.update_tab_group";
const MOVE = "browser.move_tabs";

// ---------------------------------------------------------------------------
// Protocol: request validation
// ---------------------------------------------------------------------------

test("the color enum is Chrome's native tabGroups.Color set, and a title is bounded plain text", () => {
  assert.deepEqual([...TAB_GROUP_COLORS], ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
  for (const color of ["gray", "Blue", "", null, 5]) assert.equal(isValidGroupColor(color), false, String(color));
  assert.equal(isValidGroupTitle(""), true);
  assert.equal(isValidGroupTitle("t".repeat(MAX_GROUP_TITLE_LENGTH)), true);
  for (const title of ["t".repeat(MAX_GROUP_TITLE_LENGTH + 1), "a\nb", "a\u0000b", "a\u007fb", null, 5]) {
    assert.equal(isValidGroupTitle(title), false, JSON.stringify(title));
  }
});

test("normalizeCreateTabGroupRequest accepts 1..100 distinct tabs with an optional title and color", () => {
  assert.deepEqual(normalizeCreateTabGroupRequest({ browserSessionId: "s", tabIds: [12, 13] }), {
    valid: true,
    request: { tabIds: [12, 13], title: null, color: null },
  });
  assert.deepEqual(normalizeCreateTabGroupRequest({ tabIds: [12], title: "Reading", color: "blue" }).request, {
    tabIds: [12],
    title: "Reading",
    color: "blue",
  });
  assert.equal(normalizeCreateTabGroupRequest({ tabIds: Array.from({ length: MAX_TAB_IDS }, (_, i) => i) }).valid, true);
});

test("normalizeCreateTabGroupRequest refuses an empty group, bad handles, bad metadata, and unknown fields", () => {
  for (const bad of [
    null,
    [],
    "tabs",
    {},
    { tabIds: [] },
    { tabIds: Array.from({ length: MAX_TAB_IDS + 1 }, (_, i) => i) },
    { tabIds: [1, 1] },
    { tabIds: [-1] },
    { tabIds: ["1"] },
    { tabIds: [1.5] },
    { tabIds: 1 },
    { tabIds: [1], title: "" },
    { tabIds: [1], title: "t".repeat(MAX_GROUP_TITLE_LENGTH + 1) },
    { tabIds: [1], title: "a\nb" },
    { tabIds: [1], color: "gray" },
    { tabIds: [1], windowId: 2 },
    { tabIds: [1], collapsed: true },
  ]) {
    assert.equal(normalizeCreateTabGroupRequest(bad).valid, false, JSON.stringify(bad));
  }
});

test("normalizeUpdateTabGroupRequest requires a group and at least one of title or color; an empty title removes it", () => {
  assert.deepEqual(normalizeUpdateTabGroupRequest({ browserSessionId: "s", groupId: 7, title: "Research", color: "red" }).request, {
    groupId: 7,
    title: "Research",
    color: "red",
  });
  assert.deepEqual(normalizeUpdateTabGroupRequest({ groupId: 7, title: "" }).request, { groupId: 7, title: "", color: null });
  for (const bad of [
    { groupId: 7 },
    { groupId: 7, title: null, color: null },
    { title: "x" },
    { groupId: -1, title: "x" },
    { groupId: 7, color: "gray" },
    { groupId: 7, title: "x", collapsed: false },
    { groupId: 7, title: "x", tabIds: [1] },
  ]) {
    assert.equal(normalizeUpdateTabGroupRequest(bad).valid, false, JSON.stringify(bad));
  }
});

test("normalizeMoveTabsRequest requires an explicit destination: a group handle, or null to ungroup", () => {
  assert.deepEqual(normalizeMoveTabsRequest({ browserSessionId: "s", tabIds: [12, 13], groupId: 7 }).request, { tabIds: [12, 13], groupId: 7 });
  assert.deepEqual(normalizeMoveTabsRequest({ tabIds: [12], groupId: null }).request, { tabIds: [12], groupId: null });
  for (const bad of [
    { tabIds: [12] },
    { tabIds: [12], groupId: undefined },
    { tabIds: [12], groupId: -1 },
    { tabIds: [12], groupId: "7" },
    { tabIds: [], groupId: 7 },
    { tabIds: [12, 12], groupId: 7 },
    { tabIds: [12], groupId: 7, index: 0 },
    { tabIds: [12], groupId: 7, windowId: 2 },
  ]) {
    assert.equal(normalizeMoveTabsRequest(bad).valid, false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Protocol: result validation
// ---------------------------------------------------------------------------

function envelope(sourceOperation, status = "ok", extra = {}) {
  return { schemaVersion: RESULT_SCHEMA_VERSION, browserSessionId: "s", sourceOperation, capturedAt: 1, status, ...extra };
}

const GROUP = { groupId: 20, windowId: 2, title: "Work", color: "red", collapsed: false };
const IN_GROUP = [
  { tabId: 5, windowId: 2, groupId: 20 },
  { tabId: 6, windowId: 2, groupId: 20 },
];

test("validateMethodResult accepts fully observed mutation results and checks them for consistency", () => {
  assert.equal(validateMethodResult(CREATE, envelope(CREATE, "ok", { changed: true, group: GROUP, tabs: IN_GROUP })).valid, true);
  assert.equal(validateMethodResult(UPDATE, envelope(UPDATE, "ok", { changed: true, group: GROUP })).valid, true);
  assert.equal(validateMethodResult(MOVE, envelope(MOVE, "ok", { changed: true, group: GROUP, tabs: IN_GROUP })).valid, true);
  const ungrouped = IN_GROUP.map((tab) => ({ ...tab, groupId: -1 }));
  assert.equal(validateMethodResult(MOVE, envelope(MOVE, "ok", { changed: true, group: null, tabs: ungrouped })).valid, true);

  for (const [method, extra] of [
    [CREATE, { changed: true, group: GROUP, tabs: [] }],
    [CREATE, { changed: true, group: GROUP, tabs: [{ tabId: 5, windowId: 2, groupId: 3 }] }],
    [CREATE, { changed: true, group: GROUP, tabs: [{ tabId: 5, windowId: 4, groupId: 20 }] }],
    [CREATE, { changed: false, group: GROUP, tabs: IN_GROUP }],
    [CREATE, { changed: true, group: { ...GROUP, color: "gray" }, tabs: IN_GROUP }],
    [UPDATE, { changed: true, group: null }],
    [MOVE, { changed: true, group: null, tabs: IN_GROUP }],
    [MOVE, { changed: true, group: GROUP, tabs: [{ tabId: 5, windowId: 2, groupId: -1 }] }],
    [MOVE, { changed: true, group: GROUP }],
  ]) {
    assert.equal(validateMethodResult(method, envelope(method, "ok", extra)).valid, false, JSON.stringify(extra));
  }
});

test("validateMethodResult requires every non-ok mutation result to state consistently whether the browser changed", () => {
  const partial = { changed: true, code: ERROR_CODES.OBSERVE_FAILED, groupId: 20, windowId: 2, tabIds: [5] };
  for (const method of [CREATE, UPDATE, MOVE]) {
    const ok = (status, extra) => validateMethodResult(method, envelope(method, status, extra)).valid;
    assert.equal(ok("error", { code: ERROR_CODES.STALE_SESSION, changed: false }), true);
    assert.equal(ok("unsupported", { code: ERROR_CODES.UNSUPPORTED_FEATURE, changed: false }), true);
    assert.equal(ok("error", { code: ERROR_CODES.GROUP_FAILED, changed: null }), true);
    assert.equal(ok("incomplete", partial), true);
    assert.equal(ok("incomplete", { ...partial, code: ERROR_CODES.GROUP_UPDATE_FAILED, groupId: null, windowId: null, tabIds: null }), true);

    assert.equal(ok("error", { code: ERROR_CODES.STALE_SESSION }), false, "changed is required");
    assert.equal(ok("incomplete", { ...partial, changed: false }), false);
    assert.equal(ok("unsupported", { code: ERROR_CODES.GROUP_FAILED, changed: null }), false);
    assert.equal(ok("error", { ...partial }), false, "a known change is incomplete, not an error");
    assert.equal(ok("incomplete", { ...partial, code: ERROR_CODES.GROUP_FAILED }), false);
    assert.equal(ok("incomplete", { ...partial, tabIds: [] }), false);
    assert.equal(ok("incomplete", { ...partial, groupId: -1 }), false);
  }
});

// ---------------------------------------------------------------------------
// Worker: a stateful mock browser
// ---------------------------------------------------------------------------

// Window 2 holds ungrouped tabs 5 and 7, tab 6 in group 3, tab 11 in group 10,
// and pinned tab 8; window 4 holds tab 9 and tab 12 in group 30. tabs.group
// creates group 20 for a new group and — like Chrome — removes any group left
// with no tabs, so a source group disappearing is observable. Overrides
// replace individual methods and receive a context with the default
// implementations, the state maps, and the call log.
let caseId = 0;

function mockBrowser({ supported = true, overrides = {} } = {}) {
  const calls = { tabsGet: [], group: [], ungroup: [], update: [], groupsGet: [] };
  const tabs = new Map();
  const addTab = (id, props) => tabs.set(id, { id, windowId: 2, groupId: -1, pinned: false, title: `Tab ${id}`, url: `https://example.com/${id}`, ...props });
  addTab(5);
  addTab(6, { groupId: 3 });
  addTab(7);
  addTab(8, { pinned: true });
  addTab(9, { windowId: 4 });
  addTab(11, { groupId: 10 });
  addTab(12, { windowId: 4, groupId: 30 });
  const groups = new Map([
    [3, { id: 3, windowId: 2, title: "Src", color: "red", collapsed: false }],
    [10, { id: 10, windowId: 2, title: "Dest", color: "blue", collapsed: true }],
    [30, { id: 30, windowId: 4, title: "Other", color: "green", collapsed: false }],
  ]);
  const dropEmptyGroups = () => {
    for (const id of [...groups.keys()]) {
      if (![...tabs.values()].some((tab) => tab.groupId === id)) groups.delete(id);
    }
  };
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
      dropEmptyGroups();
      return groupId;
    };
    api.tabs.ungroup = async (tabIds) => {
      calls.ungroup.push(tabIds);
      if (overrides.ungroup) return overrides.ungroup(tabIds, ctx);
      for (const id of tabIds) tabs.get(id).groupId = -1;
      dropEmptyGroups();
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
  let listener;
  browser.api.runtime.onMessage.addListener = (fn) => {
    listener = fn;
  };
  globalThis.chrome = browser.api;
  caseId += 1;
  const mod = await import(`../extension/service-worker.js?mutation-case=${caseId}`);
  const session = (await mod.listWindows()).browserSessionId;
  return { mod, session, listener: (message) => listener(message), ...browser };
}

function assertResult(method, result, { status, changed, code }) {
  assert.equal(result.schemaVersion, RESULT_SCHEMA_VERSION);
  assert.equal(result.sourceOperation, method);
  assert.equal(result.status, status, JSON.stringify(result));
  assert.equal(result.changed, changed);
  if (code !== undefined) assert.equal(result.code, code);
  assert.equal(validateMethodResult(method, result).valid, true, validateMethodResult(method, result).reason);
}

const nothingChanged = (calls) => {
  assert.deepEqual(calls.group, [], "tabs.group must not have been called");
  assert.deepEqual(calls.ungroup, [], "tabs.ungroup must not have been called");
  assert.deepEqual(calls.update, [], "tabGroups.update must not have been called");
};

// ---------------------------------------------------------------------------
// Worker: createTabGroup
// ---------------------------------------------------------------------------

test("createTabGroup groups the tabs in their own window with one tabs.group call and reports the group read back", async () => {
  const { mod, session, calls, tabs } = await loadWorker();
  const result = await mod.createTabGroup({ browserSessionId: session, tabIds: [5, 6], title: "Reading", color: "blue" });
  assertResult(CREATE, result, { status: "ok", changed: true });
  assert.deepEqual(calls.group, [{ tabIds: [5, 6], createProperties: { windowId: 2 } }]);
  assert.deepEqual(calls.update, [{ id: 20, props: { title: "Reading", color: "blue" } }]);
  assert.deepEqual(result.group, { groupId: 20, windowId: 2, title: "Reading", color: "blue", collapsed: false });
  assert.deepEqual(result.tabs, [
    { tabId: 5, windowId: 2, groupId: 20 },
    { tabId: 6, windowId: 2, groupId: 20 },
  ]);
  assert.equal(tabs.get(6).groupId, 20, "tabs may come from an existing group");
});

test("createTabGroup without a title or color makes no tabGroups.update call", async () => {
  const { mod, session, calls } = await loadWorker();
  const result = await mod.createTabGroup({ browserSessionId: session, tabIds: [7] });
  assertResult(CREATE, result, { status: "ok", changed: true });
  assert.equal(calls.group.length, 1);
  assert.deepEqual(calls.update, []);
});

test("createTabGroup refuses a stale or missing session before reading or changing anything", async () => {
  const { mod, calls } = await loadWorker();
  for (const browserSessionId of [undefined, "", "not-the-session"]) {
    const result = await mod.createTabGroup({ browserSessionId, tabIds: [5] });
    assertResult(CREATE, result, { status: "error", changed: false, code: ERROR_CODES.STALE_SESSION });
  }
  assert.deepEqual(calls.tabsGet, []);
  nothingChanged(calls);
});

test("createTabGroup refuses invalid parameters, stale tabs, pinned tabs, and tabs in more than one window, changing nothing", async () => {
  const { mod, session, calls } = await loadWorker();
  for (const [params, code] of [
    [{ tabIds: [] }, ERROR_CODES.INVALID_PARAMS],
    [{ tabIds: [5], title: "" }, ERROR_CODES.INVALID_PARAMS],
    [{ tabIds: [5, 99] }, ERROR_CODES.STALE_HANDLE],
    [{ tabIds: [5, 8] }, ERROR_CODES.PINNED_TAB],
    [{ tabIds: [5, 9] }, ERROR_CODES.WINDOW_MISMATCH],
  ]) {
    const result = await mod.createTabGroup({ browserSessionId: session, ...params });
    assertResult(CREATE, result, { status: "error", changed: false, code });
  }
  nothingChanged(calls);
});

test("createTabGroup reports unsupported, changing nothing, when the browser has no tab-group APIs", async () => {
  const { mod, session, calls } = await loadWorker({ supported: false });
  const result = await mod.createTabGroup({ browserSessionId: session, tabIds: [5] });
  assertResult(CREATE, result, { status: "unsupported", changed: false, code: ERROR_CODES.UNSUPPORTED_FEATURE });
  assert.deepEqual(calls.tabsGet, []);
});

test("createTabGroup reports an unknown outcome, without retrying, when tabs.group rejects or returns no group", async () => {
  for (const group of [
    async () => {
      throw new Error("boom");
    },
    async () => undefined,
  ]) {
    const { mod, session, calls } = await loadWorker({ overrides: { group } });
    const result = await mod.createTabGroup({ browserSessionId: session, tabIds: [5], title: "x" });
    assertResult(CREATE, result, { status: "error", changed: null });
    assert.equal(calls.group.length, 1, "never retried");
    assert.deepEqual(calls.update, []);
  }
});

test("createTabGroup reports a partial outcome when the group was created but its title/color update failed", async () => {
  const { mod, session, calls } = await loadWorker({
    overrides: {
      update: async () => {
        throw new Error("no update");
      },
    },
  });
  const result = await mod.createTabGroup({ browserSessionId: session, tabIds: [5], color: "red" });
  assertResult(CREATE, result, { status: "incomplete", changed: true, code: ERROR_CODES.GROUP_UPDATE_FAILED });
  assert.equal(result.groupId, 20);
  assert.equal(result.windowId, 2);
  assert.equal(calls.group.length, 1);
  assert.equal(calls.update.length, 1);
});

test("createTabGroup reports only the tabs actually observed in the new group, or none when observation fails", async () => {
  {
    // Tab 6 is moved elsewhere by "the user" right after the group call.
    const { mod, session } = await loadWorker({
      overrides: {
        tabsGet: async (id, ctx) => (id === 6 && ctx.calls.group.length > 0 ? { ...(await ctx.get(id)), groupId: 3 } : ctx.get(id)),
      },
    });
    const result = await mod.createTabGroup({ browserSessionId: session, tabIds: [5, 6] });
    assertResult(CREATE, result, { status: "incomplete", changed: true, code: ERROR_CODES.OBSERVE_FAILED });
    assert.deepEqual(result.tabIds, [5]);
  }
  {
    const { mod, session, calls } = await loadWorker({
      overrides: {
        groupsGet: async () => {
          throw new Error("gone");
        },
      },
    });
    const result = await mod.createTabGroup({ browserSessionId: session, tabIds: [5] });
    assertResult(CREATE, result, { status: "incomplete", changed: true, code: ERROR_CODES.OBSERVE_FAILED });
    assert.equal(result.groupId, 20);
    assert.equal(result.tabIds, null);
    assert.equal(calls.group.length, 1);
  }
});

// ---------------------------------------------------------------------------
// Worker: updateTabGroup
// ---------------------------------------------------------------------------

test("updateTabGroup sends only the fields that change and reports the group read back", async () => {
  const { mod, session, calls } = await loadWorker();
  const result = await mod.updateTabGroup({ browserSessionId: session, groupId: 10, title: "Research", color: "blue" });
  assertResult(UPDATE, result, { status: "ok", changed: true });
  assert.deepEqual(calls.update, [{ id: 10, props: { title: "Research" } }], "the unchanged color is not sent");
  assert.deepEqual(result.group, { groupId: 10, windowId: 2, title: "Research", color: "blue", collapsed: true });
});

test("updateTabGroup removes the title for an empty title", async () => {
  const { mod, session, groups } = await loadWorker();
  const result = await mod.updateTabGroup({ browserSessionId: session, groupId: 10, title: "" });
  assertResult(UPDATE, result, { status: "ok", changed: true });
  assert.equal(groups.get(10).title, "");
  assert.equal(result.group.title, "");
});

test("updateTabGroup refuses a request that would change nothing, a stale group, and a stale session", async () => {
  const { mod, session, calls } = await loadWorker();
  for (const [params, code] of [
    [{ browserSessionId: session, groupId: 10, title: "Dest", color: "blue" }, ERROR_CODES.NO_CHANGE],
    [{ browserSessionId: session, groupId: 99, title: "x" }, ERROR_CODES.STALE_HANDLE],
    [{ browserSessionId: "old", groupId: 10, title: "x" }, ERROR_CODES.STALE_SESSION],
    [{ browserSessionId: session, groupId: 10 }, ERROR_CODES.INVALID_PARAMS],
  ]) {
    const result = await mod.updateTabGroup(params);
    assertResult(UPDATE, result, { status: "error", changed: false, code });
  }
  nothingChanged(calls);
});

test("updateTabGroup reports unsupported without reading anything on a browser without tab-group APIs", async () => {
  const { mod, session } = await loadWorker({ supported: false });
  const result = await mod.updateTabGroup({ browserSessionId: session, groupId: 10, color: "red" });
  assertResult(UPDATE, result, { status: "unsupported", changed: false, code: ERROR_CODES.UNSUPPORTED_FEATURE });
});

test("updateTabGroup reports an unknown outcome when the one update call rejects, and a partial one when the read-back disagrees", async () => {
  {
    const { mod, session, calls } = await loadWorker({
      overrides: {
        update: async () => {
          throw new Error("rejected");
        },
      },
    });
    const result = await mod.updateTabGroup({ browserSessionId: session, groupId: 10, color: "red" });
    assertResult(UPDATE, result, { status: "error", changed: null, code: ERROR_CODES.GROUP_UPDATE_FAILED });
    assert.equal(calls.update.length, 1, "never retried");
  }
  {
    // The update "resolves" but the browser still reports the old color.
    const { mod, session } = await loadWorker({ overrides: { update: async () => {} } });
    const result = await mod.updateTabGroup({ browserSessionId: session, groupId: 10, color: "red" });
    assertResult(UPDATE, result, { status: "incomplete", changed: true, code: ERROR_CODES.OBSERVE_FAILED });
    assert.equal(result.groupId, 10);
    assert.equal(result.tabIds, null);
  }
});

// ---------------------------------------------------------------------------
// Worker: moveTabs
// ---------------------------------------------------------------------------

test("moveTabs moves a single tab into another group with the same array-based request", async () => {
  const { mod, session, calls } = await loadWorker();
  const result = await mod.moveTabs({ browserSessionId: session, tabIds: [5], groupId: 10 });
  assertResult(MOVE, result, { status: "ok", changed: true });
  assert.deepEqual(calls.group, [{ groupId: 10, tabIds: [5] }]);
  assert.deepEqual(result.group, { groupId: 10, windowId: 2, title: "Dest", color: "blue", collapsed: true });
  assert.deepEqual(result.tabs, [{ tabId: 5, windowId: 2, groupId: 10 }]);
});

test("moveTabs moves tabs from several source groups in one call, and an emptied source group disappears", async () => {
  const { mod, session, calls, groups } = await loadWorker();
  const result = await mod.moveTabs({ browserSessionId: session, tabIds: [5, 6, 7], groupId: 10 });
  assertResult(MOVE, result, { status: "ok", changed: true });
  assert.equal(calls.group.length, 1);
  assert.deepEqual(result.tabs.map((tab) => tab.tabId), [5, 6, 7]);
  assert.equal(groups.has(3), false, "group 3 lost its only tab");
});

test("moveTabs with groupId null ungroups the tabs in one tabs.ungroup call, and emptied groups disappear", async () => {
  const { mod, session, calls, groups } = await loadWorker();
  const result = await mod.moveTabs({ browserSessionId: session, tabIds: [5, 6, 11], groupId: null });
  assertResult(MOVE, result, { status: "ok", changed: true });
  assert.deepEqual(calls.ungroup, [[5, 6, 11]]);
  assert.deepEqual(calls.group, []);
  assert.equal(result.group, null);
  assert.deepEqual(result.tabs, [
    { tabId: 5, windowId: 2, groupId: -1 },
    { tabId: 6, windowId: 2, groupId: -1 },
    { tabId: 11, windowId: 2, groupId: -1 },
  ]);
  assert.equal(groups.has(3), false);
  assert.equal(groups.has(10), false);
});

test("moveTabs refuses no-op moves, pinned tabs, other windows, and stale handles, changing nothing", async () => {
  const { mod, session, calls } = await loadWorker();
  for (const [params, code] of [
    [{ tabIds: [11], groupId: 10 }, ERROR_CODES.NO_CHANGE],
    [{ tabIds: [5, 7], groupId: null }, ERROR_CODES.NO_CHANGE],
    [{ tabIds: [5, 8], groupId: 10 }, ERROR_CODES.PINNED_TAB],
    [{ tabIds: [8], groupId: null }, ERROR_CODES.PINNED_TAB],
    [{ tabIds: [5, 9], groupId: 10 }, ERROR_CODES.WINDOW_MISMATCH],
    [{ tabIds: [5], groupId: 30 }, ERROR_CODES.WINDOW_MISMATCH],
    [{ tabIds: [5], groupId: 99 }, ERROR_CODES.STALE_HANDLE],
    [{ tabIds: [99], groupId: null }, ERROR_CODES.STALE_HANDLE],
    [{ tabIds: [5] }, ERROR_CODES.INVALID_PARAMS],
  ]) {
    const result = await mod.moveTabs({ browserSessionId: session, ...params });
    assertResult(MOVE, result, { status: "error", changed: false, code });
  }
  const stale = await mod.moveTabs({ browserSessionId: "old", tabIds: [5], groupId: 10 });
  assertResult(MOVE, stale, { status: "error", changed: false, code: ERROR_CODES.STALE_SESSION });
  nothingChanged(calls);
});

test("moveTabs reports unsupported, changing nothing, on a browser without tab-group APIs", async () => {
  const { mod, session, calls } = await loadWorker({ supported: false });
  for (const groupId of [10, null]) {
    const result = await mod.moveTabs({ browserSessionId: session, tabIds: [5], groupId });
    assertResult(MOVE, result, { status: "unsupported", changed: false, code: ERROR_CODES.UNSUPPORTED_FEATURE });
  }
  assert.deepEqual(calls.tabsGet, []);
});

test("moveTabs reports an unknown outcome, without retrying, when tabs.group or tabs.ungroup rejects", async () => {
  const reject = async () => {
    throw new Error("rejected");
  };
  {
    const { mod, session, calls } = await loadWorker({ overrides: { group: reject } });
    const result = await mod.moveTabs({ browserSessionId: session, tabIds: [5], groupId: 10 });
    assertResult(MOVE, result, { status: "error", changed: null, code: ERROR_CODES.GROUP_FAILED });
    assert.equal(calls.group.length, 1);
  }
  {
    const { mod, session, calls } = await loadWorker({ overrides: { ungroup: reject } });
    const result = await mod.moveTabs({ browserSessionId: session, tabIds: [6], groupId: null });
    assertResult(MOVE, result, { status: "error", changed: null, code: ERROR_CODES.UNGROUP_FAILED });
    assert.equal(calls.ungroup.length, 1);
  }
});

test("moveTabs reports a partial outcome naming only the tabs observed where they were sent", async () => {
  {
    // tabs.group resolves but tab 7 never arrives in the destination.
    const { mod, session } = await loadWorker({
      overrides: {
        group: async (options, ctx) => {
          ctx.tabs.get(5).groupId = options.groupId;
          return options.groupId;
        },
      },
    });
    const result = await mod.moveTabs({ browserSessionId: session, tabIds: [5, 7], groupId: 10 });
    assertResult(MOVE, result, { status: "incomplete", changed: true, code: ERROR_CODES.OBSERVE_FAILED });
    assert.deepEqual(result.tabIds, [5]);
    assert.equal(result.groupId, 10);
  }
  {
    // tabs.ungroup resolves but tab 11 is still grouped afterwards.
    const { mod, session } = await loadWorker({
      overrides: {
        ungroup: async (_tabIds, ctx) => {
          ctx.tabs.get(6).groupId = -1;
        },
      },
    });
    const result = await mod.moveTabs({ browserSessionId: session, tabIds: [6, 11], groupId: null });
    assertResult(MOVE, result, { status: "incomplete", changed: true, code: ERROR_CODES.OBSERVE_FAILED });
    assert.deepEqual(result.tabIds, [6]);
    assert.equal(result.groupId, null);
  }
});

// ---------------------------------------------------------------------------
// Routing: only the authenticated service connection can mutate
// ---------------------------------------------------------------------------

test("routeServiceMessage routes the three mutations with their request fields", async () => {
  const { mod, session, calls } = await loadWorker();
  const created = await mod.routeServiceMessage({ method: CREATE, browserSessionId: session, tabIds: [5], title: "A" });
  assert.equal(created.status, "ok");
  const updated = await mod.routeServiceMessage({ method: UPDATE, browserSessionId: session, groupId: 20, color: "pink" });
  assert.equal(updated.status, "ok");
  const moved = await mod.routeServiceMessage({ method: MOVE, browserSessionId: session, tabIds: [5], groupId: null });
  assert.equal(moved.status, "ok");
  assert.equal(calls.group.length, 1);
  assert.equal(calls.ungroup.length, 1);
  const read = await mod.routeServiceMessage({ method: "browser.list_windows" });
  assert.equal(read.status, "ok");
});

test("the read-only routeMessage and the runtime.onMessage listener cannot mutate: the mutations are unknown methods there", async () => {
  const { mod, session, calls, listener } = await loadWorker();
  for (const message of [
    { method: CREATE, browserSessionId: session, tabIds: [5] },
    { method: UPDATE, browserSessionId: session, groupId: 10, title: "x" },
    { method: MOVE, browserSessionId: session, tabIds: [5], groupId: 10 },
  ]) {
    for (const result of [await listener(message), await mod.routeMessage(message)]) {
      assert.equal(result.status, "error");
      assert.equal(result.code, ERROR_CODES.UNKNOWN_METHOD);
    }
  }
  nothingChanged(calls);
});

test("removed methods are unknown to every dispatcher", async () => {
  const { mod, listener } = await loadWorker();
  for (const method of ["browser.get_capabilities", "browser.open_tab", "browser.close_tab", "browser.configure_group", "browser.inspect_move_target"]) {
    assert.equal((await mod.routeServiceMessage({ method })).code, ERROR_CODES.UNKNOWN_METHOD, method);
    assert.equal((await listener({ method })).code, ERROR_CODES.UNKNOWN_METHOD, method);
  }
});
