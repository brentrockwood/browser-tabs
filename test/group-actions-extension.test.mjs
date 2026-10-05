// Phase 2 Action 2 ("create, rename, or recolor a tab group"), extension side:
// the shared request/result validators in extension/protocol.js and the
// worker's read-only `inspectGroupTarget` and mutating `configureGroup`,
// against a recorded mock browser — so each test can assert exactly how many
// times the browser was asked to change anything, and with what.
import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CODES,
  MAX_GROUP_TITLE_LENGTH,
  PROTOCOL_VERSION,
  RESULT_SCHEMA_VERSION,
  TAB_GROUP_COLORS,
  isValidGroupColor,
  isValidGroupTitle,
  normalizeGroupConfig,
  validateMethodResult,
} from "../extension/protocol.js";

// ---------------------------------------------------------------------------
// Protocol: request validation
// ---------------------------------------------------------------------------

const CREATE = { operation: "create", tabId: 5, windowId: 2 };
const UPDATE = { operation: "update", groupId: 9, windowId: 2, expectedTitle: "Old", expectedColor: "blue" };

test("protocol version 4 or later is required for the group methods", () => {
  assert.ok(PROTOCOL_VERSION >= 4);
});

test("the color enum is Chrome's native tabGroups.Color set, and a title is bounded plain text where '' means clear", () => {
  assert.deepEqual([...TAB_GROUP_COLORS], ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
  for (const color of TAB_GROUP_COLORS) assert.equal(isValidGroupColor(color), true);
  for (const color of ["gray", "Blue", "", null, undefined, 5, "#ff0000"]) assert.equal(isValidGroupColor(color), false, String(color));

  assert.equal(isValidGroupTitle(""), true, "the empty string is the explicit clear value");
  assert.equal(isValidGroupTitle("Reading list"), true);
  assert.equal(isValidGroupTitle("t".repeat(MAX_GROUP_TITLE_LENGTH)), true);
  assert.equal(isValidGroupTitle("t".repeat(MAX_GROUP_TITLE_LENGTH + 1)), false);
  for (const title of ["a\nb", "a\u0000b", "a\u007fb", null, undefined, 5, {}]) assert.equal(isValidGroupTitle(title), false, JSON.stringify(title));
});

test("normalizeGroupConfig accepts a create with or without a title/color, and returns every field", () => {
  assert.deepEqual(normalizeGroupConfig(CREATE), {
    valid: true,
    config: { operation: "create", tabId: 5, windowId: 2, title: null, color: null },
  });
  assert.deepEqual(normalizeGroupConfig({ ...CREATE, title: "Work", color: "red", extra: 1 }).config, {
    operation: "create",
    tabId: 5,
    windowId: 2,
    title: "Work",
    color: "red",
  });
  assert.equal(normalizeGroupConfig({ ...CREATE, title: null, color: undefined }).valid, true);
});

test("normalizeGroupConfig refuses an invalid create", () => {
  for (const bad of [
    null,
    "create",
    {},
    { ...CREATE, tabId: -1 },
    { ...CREATE, tabId: "5" },
    { ...CREATE, tabId: 1.5 },
    { ...CREATE, windowId: undefined },
    { ...CREATE, title: "" }, // nothing to clear on a new group
    { ...CREATE, title: "t".repeat(101) },
    { ...CREATE, title: "bad\ntitle" },
    { ...CREATE, title: 5 },
    { ...CREATE, color: "gray" },
    { ...CREATE, operation: "move" },
    { ...CREATE, operation: undefined },
  ]) {
    assert.equal(normalizeGroupConfig(bad).valid, false, JSON.stringify(bad));
  }
});

test("normalizeGroupConfig requires an update to state the current title/color and to actually change one of them", () => {
  assert.deepEqual(normalizeGroupConfig({ ...UPDATE, title: "New" }).config, { ...UPDATE, title: "New", color: null });
  assert.equal(normalizeGroupConfig({ ...UPDATE, color: "red" }).valid, true);
  assert.equal(normalizeGroupConfig({ ...UPDATE, title: "" }).valid, true, "clearing a non-empty title is a change");
  assert.equal(normalizeGroupConfig({ ...UPDATE, expectedTitle: "", title: "x" }).valid, true);
  for (const bad of [
    UPDATE, // no change requested at all
    { ...UPDATE, title: "Old" }, // same title
    { ...UPDATE, color: "blue" }, // same color
    { ...UPDATE, title: "Old", color: "blue" },
    { ...UPDATE, expectedTitle: "", title: "" }, // clearing an already-empty title
    { ...UPDATE, title: "New", groupId: -1 },
    { ...UPDATE, title: "New", expectedTitle: undefined },
    { ...UPDATE, title: "New", expectedColor: "gray" },
    { ...UPDATE, title: "New", windowId: "2" },
    { ...UPDATE, title: "t".repeat(101) },
    { ...UPDATE, color: "mauve" },
  ]) {
    assert.equal(normalizeGroupConfig(bad).valid, false, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// Protocol: result validation
// ---------------------------------------------------------------------------

function envelope(sourceOperation, status = "ok", extra = {}) {
  return { schemaVersion: RESULT_SCHEMA_VERSION, browserSessionId: "s", sourceOperation, capturedAt: 1, status, ...extra };
}

const GROUP_RECORD = { groupId: 9, windowId: 2, title: "Old", color: "blue", collapsed: false };

test("validateMethodResult accepts a fully observed browser.inspect_group_target result with exactly one of tab/group", () => {
  const op = "browser.inspect_group_target";
  const tab = { tabId: 5, windowId: 2, grouped: false, pinned: false, title: "T", url: "https://example.com/" };
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab, group: null })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: { ...tab, title: null, url: null }, group: null })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: null, group: GROUP_RECORD })).valid, true);

  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab, group: GROUP_RECORD })).valid, false, "both is invalid");
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: null, group: null })).valid, false, "neither is invalid");
  assert.equal(validateMethodResult(op, envelope(op, "ok", { group: GROUP_RECORD })).valid, false, "a missing tab field is invalid");
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab })).valid, false);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: { ...tab, grouped: "no" }, group: null })).valid, false);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: { ...tab, pinned: true }, group: null })).valid, true, "a pinned tab is reported, not hidden");
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: { ...tab, pinned: "no" }, group: null })).valid, false);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: { ...tab, pinned: undefined }, group: null })).valid, false, "an old peer's answer without pinned is invalid");
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: { ...tab, windowId: -1 }, group: null })).valid, false);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: null, group: { ...GROUP_RECORD, color: "mauve" } })).valid, false);
  assert.equal(validateMethodResult(op, envelope(op, "ok", { tab: null, group: { ...GROUP_RECORD, color: null } })).valid, false);
  assert.equal(validateMethodResult(op, envelope(op, "unsupported", { code: "unsupported_feature" })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "error", { code: "stale_handle" })).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "error")).valid, false, "a non-ok result needs a code");
});

test("validateMethodResult accepts a fully observed browser.configure_group result and checks its fields", () => {
  const op = "browser.configure_group";
  const created = envelope(op, "ok", { changed: true, operation: "create", tabId: 5, group: GROUP_RECORD });
  const updated = envelope(op, "ok", { changed: true, operation: "update", tabId: null, group: GROUP_RECORD });
  assert.equal(validateMethodResult(op, created).valid, true);
  assert.equal(validateMethodResult(op, updated).valid, true);
  assert.equal(validateMethodResult(op, { ...created, changed: false }).valid, false, "an ok result must say the browser changed");
  assert.equal(validateMethodResult(op, { ...created, changed: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...created, operation: "move" }).valid, false);
  assert.equal(validateMethodResult(op, { ...created, tabId: null }).valid, false, "a create names its tab");
  assert.equal(validateMethodResult(op, { ...updated, tabId: 5 }).valid, false, "an update has no tab");
  assert.equal(validateMethodResult(op, { ...created, group: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...created, group: { ...GROUP_RECORD, collapsed: "no" } }).valid, false);
});

test("validateMethodResult requires every non-ok browser.configure_group result to state consistently whether the browser changed", () => {
  const op = "browser.configure_group";
  const refusal = envelope(op, "error", { code: "stale_session", changed: false });
  assert.equal(validateMethodResult(op, refusal).valid, true);
  assert.equal(validateMethodResult(op, envelope(op, "unsupported", { code: "unsupported_feature", changed: false })).valid, true);
  assert.equal(validateMethodResult(op, { ...refusal, changed: undefined }).valid, false, "a legacy peer's bare unknown_method error has no changed flag");
  assert.equal(validateMethodResult(op, { ...refusal, changed: "no" }).valid, false);
  assert.equal(validateMethodResult(op, { ...refusal, changed: true }).valid, false, "an error claiming a change is only valid as the partial outcome");
  assert.equal(validateMethodResult(op, { ...refusal, status: "incomplete" }).valid, false, "incomplete always means a change was made");

  const partial = envelope(op, "incomplete", { code: "observe_failed", changed: true, groupId: 9, windowId: 2, tabId: 5 });
  assert.equal(validateMethodResult(op, partial).valid, true);
  assert.equal(validateMethodResult(op, { ...partial, code: "group_update_failed" }).valid, true);
  assert.equal(validateMethodResult(op, { ...partial, groupId: null, windowId: null, tabId: null }).valid, true);
  assert.equal(validateMethodResult(op, { ...partial, groupId: undefined }).valid, false);
  assert.equal(validateMethodResult(op, { ...partial, groupId: "9" }).valid, false);
  assert.equal(validateMethodResult(op, { ...partial, code: "something_else" }).valid, false);
  assert.equal(validateMethodResult(op, { ...partial, status: "error" }).valid, false, "a change is never an ordinary error");
});

// ---------------------------------------------------------------------------
// Worker: a recorded mock browser
// ---------------------------------------------------------------------------

let caseId = 0;

// A browser with one ungrouped tab (id 5, window 2) and one group (id 9,
// window 2, title "Old", color "blue"). `tabGroups.update` really changes the
// group, so the group read back afterwards reflects what was requested.
// Overrides replace individual methods; `supported: false` removes the
// tab-group APIs entirely, as in a browser without them.
function mockBrowser({ tabs = {}, tabGroups = {}, supported = true, group = {} } = {}) {
  const calls = { tabsGet: [], group: [], update: [], groupsGet: [] };
  const current = { id: 9, windowId: 2, title: "Old", color: "blue", collapsed: false, ...group };
  const api = {
    windows: { getAll: async () => [], get: async () => ({ id: 0 }) },
    scripting: { executeScript: async () => [] },
    runtime: { onMessage: { addListener: () => {} } },
    tabs: {
      query: async () => [],
      get: async (id) => {
        calls.tabsGet.push(id);
        if (tabs.get) return tabs.get(id);
        if (id !== 5) throw new Error(`No tab with id: ${id}`);
        return { id: 5, windowId: 2, groupId: -1, title: "A page", url: "https://example.com/page" };
      },
    },
  };
  if (supported) {
    api.tabs.group = async (options) => {
      calls.group.push(options);
      return tabs.group ? tabs.group(options) : 9;
    };
    api.tabGroups = {
      get: async (id) => {
        calls.groupsGet.push(id);
        if (tabGroups.get) return tabGroups.get(id);
        if (id !== 9) throw new Error(`No group with id: ${id}`);
        return { ...current };
      },
      update: async (id, props) => {
        calls.update.push({ id, props });
        if (tabGroups.update) return tabGroups.update(id, props);
        Object.assign(current, props);
        return { ...current };
      },
    };
  }
  return { api, calls, current };
}

async function loadWorker(options) {
  const browser = mockBrowser(options);
  globalThis.chrome = browser.api;
  caseId += 1;
  const mod = await import(`../extension/service-worker.js?group-case=${caseId}`);
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
// Worker: inspectGroupTarget (read-only)
// ---------------------------------------------------------------------------

test("inspectGroupTarget reports an ungrouped tab, its window, and whether it is grouped, and changes nothing", async () => {
  const { mod, calls } = await loadWorker();
  const result = await mod.inspectGroupTarget(5, undefined);
  assertEnvelope(result, { sourceOperation: "browser.inspect_group_target", status: "ok" });
  assert.deepEqual(result.tab, { tabId: 5, windowId: 2, grouped: false, pinned: false, title: "A page", url: "https://example.com/page" });
  assert.equal(result.group, null);
  assert.equal(validateMethodResult("browser.inspect_group_target", result).valid, true);
  noChange(calls);
});

test("inspectGroupTarget treats any group id other than the explicit 'no group' as grouped", async () => {
  for (const groupId of [3, 0, undefined]) {
    const { mod } = await loadWorker({ tabs: { get: async () => ({ id: 5, windowId: 2, groupId, title: "t", url: "u" }) } });
    const result = await mod.inspectGroupTarget(5, null);
    assert.equal(result.tab.grouped, true, `groupId ${groupId}`);
  }
});

test("inspectGroupTarget reports a group's window, title, and color", async () => {
  const { mod, calls } = await loadWorker();
  const result = await mod.inspectGroupTarget(undefined, 9);
  assertEnvelope(result, { sourceOperation: "browser.inspect_group_target", status: "ok" });
  assert.equal(result.tab, null);
  assert.deepEqual(result.group, { groupId: 9, windowId: 2, title: "Old", color: "blue", collapsed: false });
  assert.equal(validateMethodResult("browser.inspect_group_target", result).valid, true);
  noChange(calls);
});

test("inspectGroupTarget reports a closed tab or group as a stale handle, and requires exactly one valid handle", async () => {
  const { mod } = await loadWorker();
  assert.equal((await mod.inspectGroupTarget(404, undefined)).code, ERROR_CODES.STALE_HANDLE);
  assert.equal((await mod.inspectGroupTarget(undefined, 404)).code, ERROR_CODES.STALE_HANDLE);
  for (const [tabId, groupId] of [[undefined, undefined], [5, 9], [-1, undefined], [undefined, "9"], [1.5, undefined], [null, null]]) {
    const result = await mod.inspectGroupTarget(tabId, groupId);
    assert.equal(result.status, "error", JSON.stringify([tabId, groupId]));
    assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
  }
});

test("inspectGroupTarget answers unsupported, touching nothing, in a browser without tab groups", async () => {
  const { mod, calls } = await loadWorker({ supported: false });
  for (const result of [await mod.inspectGroupTarget(5, undefined), await mod.inspectGroupTarget(undefined, 9)]) {
    assertEnvelope(result, { sourceOperation: "browser.inspect_group_target", status: "unsupported" });
    assert.equal(result.code, ERROR_CODES.UNSUPPORTED_FEATURE);
    assert.equal(validateMethodResult("browser.inspect_group_target", result).valid, true);
  }
  assert.deepEqual(calls.tabsGet, []);
});

// ---------------------------------------------------------------------------
// Worker: configureGroup — create
// ---------------------------------------------------------------------------

test("create groups exactly the one tab once, applies the requested title/color once, and reports the group read back", async () => {
  const { mod, session, calls } = await loadWorker({ group: { title: "", color: "grey" } });
  const result = await mod.configureGroup({ ...CREATE, browserSessionId: session, title: "Work", color: "red" });

  assertEnvelope(result, { sourceOperation: "browser.configure_group", status: "ok" });
  assert.equal(result.changed, true);
  assert.equal(result.operation, "create");
  assert.equal(result.tabId, 5);
  assert.deepEqual(result.group, { groupId: 9, windowId: 2, title: "Work", color: "red", collapsed: false });
  assert.deepEqual(calls.group, [{ tabIds: [5], createProperties: { windowId: 2 } }], "exactly one tab, by id, kept in the previewed window");
  assert.deepEqual(calls.update, [{ id: 9, props: { title: "Work", color: "red" } }]);
  assert.deepEqual(calls.groupsGet, [9], "the observation is a read, not an echo");
  assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
});

test("create without a title or color makes no update call", async () => {
  const { mod, session, calls } = await loadWorker({ group: { title: "", color: "grey" } });
  const result = await mod.configureGroup({ ...CREATE, browserSessionId: session });
  assert.equal(result.status, "ok");
  assert.equal(result.group.color, "grey", "the browser's own default is what is reported");
  assert.deepEqual(calls.group, [{ tabIds: [5], createProperties: { windowId: 2 } }]);
  assert.deepEqual(calls.update, []);
});

test("create always names the previewed window, so a tab in a non-current window is not moved", async () => {
  const { mod, session, calls } = await loadWorker({ tabs: { get: async () => ({ id: 5, windowId: 7, groupId: -1, title: "t", url: "u" }) } });
  const result = await mod.configureGroup({ ...CREATE, windowId: 7, browserSessionId: session });
  assert.equal(result.status, "ok");
  assert.deepEqual(calls.group, [{ tabIds: [5], createProperties: { windowId: 7 } }]);
});

test("inspectGroupTarget reports whether the tab is pinned", async () => {
  for (const pinned of [true, false, undefined]) {
    const { mod } = await loadWorker({ tabs: { get: async () => ({ id: 5, windowId: 2, groupId: -1, pinned, title: "t", url: "u" }) } });
    const result = await mod.inspectGroupTarget(5, undefined);
    assert.equal(result.tab.pinned, Boolean(pinned));
    assert.equal(validateMethodResult("browser.inspect_group_target", result).valid, true);
  }
});

test("create is refused as a state mismatch, changing nothing, when the tab is pinned (at action time, even if it was not at preview)", async () => {
  const { mod, session, calls } = await loadWorker({ tabs: { get: async () => ({ id: 5, windowId: 2, groupId: -1, pinned: true }) } });
  const result = await mod.configureGroup({ ...CREATE, browserSessionId: session, title: "Work" });
  assert.equal(result.status, "error");
  assert.equal(result.code, ERROR_CODES.STATE_MISMATCH);
  assert.equal(result.changed, false);
  assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
  noChange(calls);
});

test("create sends only the requested property", async () => {
  const { mod, session, calls } = await loadWorker({ group: { title: "", color: "grey" } });
  await mod.configureGroup({ ...CREATE, browserSessionId: session, color: "green" });
  assert.deepEqual(calls.update, [{ id: 9, props: { color: "green" } }]);
});

test("every group request refuses a stale or missing browserSessionId first, before reading or changing anything", async () => {
  const { mod, calls } = await loadWorker();
  for (const request of [CREATE, UPDATE, { operation: "nonsense" }, undefined]) {
    for (const session of ["not-the-current-session", "", undefined, null, 5]) {
      const result = await mod.configureGroup(request === undefined ? undefined : { ...request, title: "x", browserSessionId: session });
      assertEnvelope(result, { sourceOperation: "browser.configure_group", status: "error" });
      assert.equal(result.code, ERROR_CODES.STALE_SESSION);
      assert.equal(result.changed, false);
      assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
    }
  }
  assert.deepEqual(calls.tabsGet, []);
  assert.deepEqual(calls.groupsGet, []);
  noChange(calls);
});

test("create re-validates its own parameters and never touches the browser for an invalid one", async () => {
  const { mod, session, calls } = await loadWorker();
  for (const bad of [
    { ...CREATE, tabId: -1 },
    { ...CREATE, title: "" },
    { ...CREATE, title: "t".repeat(101) },
    { ...CREATE, title: "a\nb" },
    { ...CREATE, color: "gray" },
    { ...CREATE, operation: "move" },
    { ...CREATE, windowId: undefined },
  ]) {
    const result = await mod.configureGroup({ ...bad, browserSessionId: session });
    assert.equal(result.status, "error", JSON.stringify(bad));
    assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal(result.changed, false);
  }
  assert.deepEqual(calls.tabsGet, []);
  noChange(calls);
});

test("create is refused as a state mismatch, changing nothing, when the tab is no longer ungrouped or has moved window", async () => {
  for (const tab of [{ groupId: 4 }, { groupId: 0 }, { groupId: undefined }, { windowId: 3 }]) {
    const { mod, session, calls } = await loadWorker({ tabs: { get: async () => ({ id: 5, windowId: 2, groupId: -1, ...tab }) } });
    const result = await mod.configureGroup({ ...CREATE, browserSessionId: session, title: "Work" });
    assert.equal(result.status, "error", JSON.stringify(tab));
    assert.equal(result.code, ERROR_CODES.STATE_MISMATCH);
    assert.equal(result.changed, false);
    assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
    noChange(calls);
  }
});

test("create is refused as a stale handle when the tab is gone or the browser answers for another tab", async () => {
  for (const get of [
    async () => {
      throw new Error("No tab with id: 5");
    },
    async () => ({ id: 6, windowId: 2, groupId: -1 }),
    async () => undefined,
  ]) {
    const { mod, session, calls } = await loadWorker({ tabs: { get } });
    const result = await mod.configureGroup({ ...CREATE, browserSessionId: session });
    assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
    assert.equal(result.changed, false);
    noChange(calls);
  }
});

test("create reports group_failed with changed:false when tabs.group rejects, and never retries or updates", async () => {
  const { mod, session, calls } = await loadWorker({
    tabs: {
      group: async () => {
        throw new Error("Tabs cannot be edited right now");
      },
    },
  });
  const result = await mod.configureGroup({ ...CREATE, browserSessionId: session, title: "Work" });
  assertEnvelope(result, { sourceOperation: "browser.configure_group", status: "error" });
  assert.equal(result.code, ERROR_CODES.GROUP_FAILED);
  assert.equal(result.detail, "Tabs cannot be edited right now");
  assert.equal(result.changed, false);
  assert.equal(calls.group.length, 1);
  assert.deepEqual(calls.update, []);
  assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
});

test("create returns the explicit partial outcome when the group was made but its title/color update failed, without retrying", async () => {
  const { mod, session, calls } = await loadWorker({
    tabGroups: {
      update: async () => {
        throw new Error("No group with id: 9");
      },
    },
  });
  const result = await mod.configureGroup({ ...CREATE, browserSessionId: session, title: "Work", color: "red" });
  assertEnvelope(result, { sourceOperation: "browser.configure_group", status: "incomplete" });
  assert.equal(result.code, ERROR_CODES.GROUP_UPDATE_FAILED);
  assert.equal(result.changed, true);
  assert.equal(result.groupId, 9);
  assert.equal(result.windowId, 2);
  assert.equal(result.tabId, 5);
  assert.equal(calls.group.length, 1, "no second group is created");
  assert.equal(calls.update.length, 1, "the update is not retried");
  assert.deepEqual(calls.groupsGet, [], "an unfinished change is not observed as if it were finished");
  assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
});

test("create returns the partial outcome when the group cannot be read back, or the browser returns no usable group id", async () => {
  {
    const { mod, session, calls } = await loadWorker({
      tabGroups: {
        get: async () => {
          throw new Error("No group with id: 9");
        },
      },
    });
    const result = await mod.configureGroup({ ...CREATE, browserSessionId: session, title: "Work" });
    assert.equal(result.status, "incomplete");
    assert.equal(result.code, ERROR_CODES.OBSERVE_FAILED);
    assert.equal(result.changed, true);
    assert.equal(result.groupId, 9);
    assert.equal(calls.group.length, 1);
    assert.equal(calls.update.length, 1);
    assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
  }
  for (const returned of [undefined, null, -1, "9"]) {
    const { mod, session, calls } = await loadWorker({ tabs: { group: async () => returned } });
    const result = await mod.configureGroup({ ...CREATE, browserSessionId: session, title: "Work" });
    assert.equal(result.status, "incomplete", String(returned));
    assert.equal(result.code, ERROR_CODES.OBSERVE_FAILED);
    assert.equal(result.changed, true);
    assert.equal(result.groupId, null);
    assert.deepEqual(calls.update, [], "nothing is applied to a group whose handle is unknown");
    assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
  }
});

test("create treats a tabGroups.get answer for a different group, or a malformed one, as the partial outcome", async () => {
  for (const get of [async () => ({ id: 10, windowId: 2 }), async () => undefined, async () => ({ id: 9 })]) {
    const { mod, session } = await loadWorker({ tabGroups: { get } });
    const result = await mod.configureGroup({ ...CREATE, browserSessionId: session, title: "Work" });
    assert.equal(result.status, "incomplete");
    assert.equal(result.code, ERROR_CODES.OBSERVE_FAILED);
    assert.equal(result.changed, true);
  }
});

// ---------------------------------------------------------------------------
// Worker: configureGroup — update
// ---------------------------------------------------------------------------

test("update renames and recolors an existing group once and reports the group read back", async () => {
  const { mod, session, calls, current } = await loadWorker();
  const result = await mod.configureGroup({ ...UPDATE, browserSessionId: session, title: "New", color: "red" });
  assertEnvelope(result, { sourceOperation: "browser.configure_group", status: "ok" });
  assert.equal(result.changed, true);
  assert.equal(result.operation, "update");
  assert.equal(result.tabId, null);
  assert.deepEqual(result.group, { groupId: 9, windowId: 2, title: "New", color: "red", collapsed: false });
  assert.deepEqual(calls.group, [], "an update never creates a group or moves a tab");
  assert.deepEqual(calls.update, [{ id: 9, props: { title: "New", color: "red" } }]);
  assert.equal(current.title, "New");
  assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
});

test("update with only a color leaves the title alone; update with title '' clears it", async () => {
  {
    const { mod, session, calls } = await loadWorker();
    const result = await mod.configureGroup({ ...UPDATE, browserSessionId: session, color: "green" });
    assert.deepEqual(calls.update, [{ id: 9, props: { color: "green" } }]);
    assert.equal(result.group.title, "Old");
    assert.equal(result.group.color, "green");
  }
  {
    const { mod, session, calls } = await loadWorker();
    const result = await mod.configureGroup({ ...UPDATE, browserSessionId: session, title: "" });
    assert.deepEqual(calls.update, [{ id: 9, props: { title: "" } }]);
    assert.equal(result.group.title, "");
    assert.equal(result.status, "ok");
  }
});

test("update requires an actual change and never touches the browser for a request that changes nothing", async () => {
  const { mod, session, calls } = await loadWorker();
  for (const request of [UPDATE, { ...UPDATE, title: "Old" }, { ...UPDATE, color: "blue" }, { ...UPDATE, title: "Old", color: "blue" }]) {
    const result = await mod.configureGroup({ ...request, browserSessionId: session });
    assert.equal(result.status, "error");
    assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
    assert.equal(result.changed, false);
  }
  assert.deepEqual(calls.groupsGet, []);
  noChange(calls);
});

test("update is refused as a state mismatch, changing nothing, when the group's window, title, or color is no longer as previewed", async () => {
  for (const group of [{ title: "Renamed elsewhere" }, { color: "red" }, { windowId: 3 }, { title: "" }]) {
    const { mod, session, calls } = await loadWorker({ group });
    const result = await mod.configureGroup({ ...UPDATE, browserSessionId: session, title: "New" });
    assert.equal(result.status, "error", JSON.stringify(group));
    assert.equal(result.code, ERROR_CODES.STATE_MISMATCH);
    assert.equal(result.changed, false);
    assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
    noChange(calls);
  }
});

test("update compares an untitled group's title as the empty string", async () => {
  const { mod, session, calls } = await loadWorker({ tabGroups: { get: async (id) => ({ id, windowId: 2, color: "blue", collapsed: false }) } });
  const result = await mod.configureGroup({ ...UPDATE, expectedTitle: "", browserSessionId: session, title: "Named" });
  assert.equal(result.code, undefined);
  assert.equal(calls.update.length, 1);
  assert.equal(result.changed, true);
});

test("update is refused as a stale handle when the group is gone or the browser answers for another group", async () => {
  for (const get of [
    async () => {
      throw new Error("No group with id: 9");
    },
    async () => ({ id: 10, windowId: 2, title: "Old", color: "blue" }),
    async () => undefined,
  ]) {
    const { mod, session, calls } = await loadWorker({ tabGroups: { get } });
    const result = await mod.configureGroup({ ...UPDATE, browserSessionId: session, title: "New" });
    assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
    assert.equal(result.changed, false);
    noChange(calls);
  }
});

test("update reports group_update_failed with changed:false when tabGroups.update rejects, and never retries", async () => {
  const { mod, session, calls } = await loadWorker({
    tabGroups: {
      update: async () => {
        throw new Error("The group is being dragged");
      },
    },
  });
  const result = await mod.configureGroup({ ...UPDATE, browserSessionId: session, title: "New" });
  assertEnvelope(result, { sourceOperation: "browser.configure_group", status: "error" });
  assert.equal(result.code, ERROR_CODES.GROUP_UPDATE_FAILED);
  assert.equal(result.changed, false);
  assert.equal(calls.update.length, 1);
  assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
});

test("update returns the partial outcome when the change was made but the group cannot be read back", async () => {
  let reads = 0;
  const { mod, session, calls } = await loadWorker({
    tabGroups: {
      get: async () => {
        reads += 1;
        if (reads > 1) throw new Error("No group with id: 9");
        return { id: 9, windowId: 2, title: "Old", color: "blue", collapsed: false };
      },
    },
  });
  const result = await mod.configureGroup({ ...UPDATE, browserSessionId: session, title: "New" });
  assert.equal(result.status, "incomplete");
  assert.equal(result.code, ERROR_CODES.OBSERVE_FAILED);
  assert.equal(result.changed, true);
  assert.equal(result.groupId, 9);
  assert.equal(result.windowId, 2);
  assert.equal(result.tabId, null);
  assert.equal(calls.update.length, 1);
  assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
});

// ---------------------------------------------------------------------------
// Worker: browsers without tab groups, and routing
// ---------------------------------------------------------------------------

test("configureGroup answers unsupported with changed:false, changing nothing, in a browser without tab groups", async () => {
  for (const options of [{ supported: false }]) {
    const { mod, session, calls } = await loadWorker(options);
    for (const request of [CREATE, UPDATE]) {
      const result = await mod.configureGroup({ ...request, browserSessionId: session, title: "x" });
      assertEnvelope(result, { sourceOperation: "browser.configure_group", status: "unsupported" });
      assert.equal(result.code, ERROR_CODES.UNSUPPORTED_FEATURE);
      assert.equal(result.changed, false);
      assert.equal(validateMethodResult("browser.configure_group", result).valid, true);
    }
    assert.deepEqual(calls.tabsGet, []);
  }
});

test("a browser with tabGroups but no tabs.group is also unsupported, never a half-working create", async () => {
  const browser = mockBrowser();
  delete browser.api.tabs.group;
  globalThis.chrome = browser.api;
  caseId += 1;
  const mod = await import(`../extension/service-worker.js?group-case=${caseId}`);
  const session = (await mod.getCapabilities()).browserSessionId;
  const result = await mod.configureGroup({ ...CREATE, browserSessionId: session });
  assert.equal(result.status, "unsupported");
  assert.equal(result.changed, false);
  assert.deepEqual(browser.calls.tabsGet, []);
});

test("routeServiceMessage routes both group methods; the read-only routeMessage and runtime.onMessage cannot reach either", async () => {
  let listener;
  const browser = mockBrowser();
  browser.api.runtime = { onMessage: { addListener: (fn) => (listener = fn) } };
  globalThis.chrome = browser.api;
  caseId += 1;
  const mod = await import(`../extension/service-worker.js?group-case=${caseId}`);
  const session = (await mod.getCapabilities()).browserSessionId;

  const inspected = await mod.routeServiceMessage({ method: "browser.inspect_group_target", tabId: 5 });
  assert.equal(inspected.status, "ok");
  assert.equal(inspected.tab.tabId, 5);
  const changed = await mod.routeServiceMessage({ method: "browser.configure_group", browserSessionId: session, ...UPDATE, color: "red" });
  assert.equal(changed.status, "ok");
  assert.equal(browser.calls.update.length, 1);

  const before = { group: browser.calls.group.length, update: browser.calls.update.length, tabsGet: browser.calls.tabsGet.length };
  for (const message of [
    { method: "browser.configure_group", browserSessionId: session, ...CREATE, title: "x" },
    { method: "browser.configure_group", browserSessionId: session, ...UPDATE, title: "x" },
    { method: "browser.inspect_group_target", tabId: 5 },
  ]) {
    for (const result of [await listener(message), await mod.routeMessage(message)]) {
      assert.equal(result.status, "error");
      assert.equal(result.code, "unknown_method");
    }
  }
  assert.deepEqual(
    { group: browser.calls.group.length, update: browser.calls.update.length, tabsGet: browser.calls.tabsGet.length },
    before,
    "an unknown method touches the browser not at all",
  );
});
