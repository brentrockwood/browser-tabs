import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCreateTabRequest, normalizeSetTabPinnedRequest, validateMethodResult } from "../extension/protocol.js";

const CREATE = "browser.create_tab";
const PIN = "browser.set_tab_pinned";
const request = { url: "https://example.com/", windowId: 2 };
let caseId = 0;

async function load(overrides = {}) {
  const calls = [];
  const tabs = new Map([[1, { id: 1, windowId: 2, index: 0, pinned: false, groupId: -1 }]]);
  let listener;
  const api = {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; } } },
    windows: { getAll: async () => [], get: async (id) => {
      if (id !== 2) throw new Error("missing window");
      return { id };
    } },
    tabGroups: { get: async (id) => {
      if (id !== 3 && id !== 4) throw new Error("missing group");
      return { id, windowId: id === 3 ? 2 : 9 };
    } },
    tabs: {
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("missing tab");
        return { ...tabs.get(id) };
      },
      create: async (props) => {
        calls.push(["create", props]);
        tabs.set(5, { id: 5, index: 1, groupId: -1, ...props });
        return { ...tabs.get(5) };
      },
      update: async (id, props) => {
        calls.push(["update", id, props]);
        Object.assign(tabs.get(id), props);
        return { ...tabs.get(id) };
      },
      group: async (props) => {
        calls.push(["group", props]);
        tabs.get(props.tabIds[0]).groupId = props.groupId;
        return props.groupId;
      },
      ungroup: async () => {},
    },
  };
  overrides.setup?.(api, tabs, calls);
  globalThis.chrome = api;
  const mod = await import(`../extension/service-worker.js?tab-case=${++caseId}`);
  const session = (await mod.listWindows()).browserSessionId;
  const run = async (method, params) => {
    const result = await mod.routeServiceMessage({ method, browserSessionId: session, ...params });
    assert.equal(validateMethodResult(method, result).valid, true, JSON.stringify(result));
    return result;
  };
  return { run, mod, session, calls, tabs, listener };
}

function outcome(result, status, changed, code) {
  assert.equal(result.status, status, JSON.stringify(result));
  assert.equal(result.changed, changed);
  if (code) assert.equal(result.code, code);
}

test("create and pin requests require explicit, typed fields and reject unsupported options", () => {
  assert.deepEqual(normalizeCreateTabRequest(request).request, { ...request, pinned: false, groupId: null });
  for (const url of ["about:blank", "file:///tmp/page.html", "https://example.com/a%20b"]) {
    assert.equal(normalizeCreateTabRequest({ ...request, url }).valid, true);
  }
  for (const bad of [null, [], {}, { ...request, url: "" }, { ...request, url: "example.com" },
    { ...request, url: "javascript:alert(1)" }, { ...request, url: "https://exa\nmple.com" },
    { ...request, url: " https://example.com" }, { ...request, url: 1 }, { ...request, windowId: -1 },
    { ...request, windowId: "2" }, { ...request, pinned: null }, { ...request, pinned: 1 },
    { ...request, groupId: -1 }, { ...request, groupId: "3" }, { ...request, pinned: true, groupId: 3 },
    { ...request, active: false }]) {
    assert.equal(normalizeCreateTabRequest(bad).valid, false, JSON.stringify(bad));
  }
  assert.deepEqual(normalizeSetTabPinnedRequest({ tabId: 1, pinned: false }).request, { tabId: 1, pinned: false });
  for (const bad of [null, [], {}, { tabId: 1 }, { tabId: -1, pinned: true }, { tabId: "1", pinned: true },
    { tabId: 1, pinned: null }, { tabId: 1, pinned: "true" }, { tabId: 1, pinned: true, groupId: 3 }]) {
    assert.equal(normalizeSetTabPinnedRequest(bad).valid, false, JSON.stringify(bad));
  }
});

test("create plain, pinned, or grouped tab uses explicit window and reads the tab back", async () => {
  for (const extra of [{}, { pinned: true }, { groupId: 3 }]) {
    const ctx = await load();
    const result = await ctx.run(CREATE, { ...request, ...extra });
    outcome(result, "ok", true);
    assert.equal(result.tab.tabId, 5);
    assert.equal(result.tab.windowId, 2);
    assert.equal(result.tab.pinned, extra.pinned ?? false);
    assert.equal(result.tab.groupId, extra.groupId ?? -1);
    assert.deepEqual(ctx.calls, [["create", { ...request, pinned: extra.pinned ?? false }],
      ...(extra.groupId ? [["group", { groupId: 3, tabIds: [5] }]] : [])]);
  }
});

test("pin and unpin use one update; repeated request is no_change", async () => {
  const ctx = await load();
  for (const pinned of [true, false]) {
    const result = await ctx.run(PIN, { tabId: 1, pinned });
    outcome(result, "ok", true);
    assert.equal(result.tab.pinned, pinned);
    outcome(await ctx.run(PIN, { tabId: 1, pinned }), "error", false, "no_change");
  }
  assert.deepEqual(ctx.calls, [["update", 1, { pinned: true }], ["update", 1, { pinned: false }]]);
});

test("stale sessions, handles, cross-window groups, invalid requests, and grouped pinning never mutate", async () => {
  const ctx = await load();
  for (const [method, params, code] of [
    [CREATE, { ...request, browserSessionId: "old" }, "stale_session"],
    [PIN, { tabId: 1, pinned: true, browserSessionId: undefined }, "stale_session"],
    [CREATE, { ...request, windowId: 99 }, "stale_handle"],
    [CREATE, { ...request, groupId: 99 }, "stale_handle"],
    [CREATE, { ...request, groupId: 4 }, "window_mismatch"],
    [CREATE, { ...request, pinned: true, groupId: 3 }, "invalid_params"],
    [PIN, { tabId: 99, pinned: true }, "stale_handle"],
    [PIN, { tabId: 1, pinned: "true" }, "invalid_params"],
  ]) outcome(await ctx.run(method, params), "error", false, code);
  ctx.tabs.get(1).groupId = 3;
  outcome(await ctx.run(PIN, { tabId: 1, pinned: true }), "error", false, "grouped_tab");
  assert.deepEqual(ctx.calls, []);
});

test("without group support plain creation and pinning work but grouped creation refuses before create", async () => {
  const ctx = await load({ setup(api) { delete api.tabGroups; delete api.tabs.group; delete api.tabs.ungroup; } });
  outcome(await ctx.run(CREATE, { ...request, groupId: 3 }), "unsupported", false, "unsupported_feature");
  assert.deepEqual(ctx.calls, []);
  outcome(await ctx.run(CREATE, request), "ok", true);
  outcome(await ctx.run(PIN, { tabId: 1, pinned: true }), "ok", true);
});

test("mutation rejection is unknown, never retried; grouping rejection preserves created tab identity", async () => {
  for (const [method, params, native, code, changed] of [
    [CREATE, request, "create", "tab_create_failed", null],
    [PIN, { tabId: 1, pinned: true }, "update", "tab_update_failed", null],
    [CREATE, { ...request, groupId: 3 }, "group", "group_failed", true],
  ]) {
    const ctx = await load({ setup(api, tabs, calls) {
      api.tabs[native] = async () => { calls.push([native]); throw new Error("rejected"); };
    } });
    const result = await ctx.run(method, params);
    outcome(result, changed ? "incomplete" : "error", changed, code);
    assert.equal(ctx.calls.filter(([name]) => name === native).length, 1);
    if (changed) { assert.equal(result.tabId, 5); assert.equal(result.windowId, 2); assert.ok(ctx.tabs.has(5)); }
  }
});

test("readback failure or state mismatch is incomplete and never retried", async () => {
  for (const method of [CREATE, PIN]) {
    for (const mismatch of [false, true]) {
      const ctx = await load({ setup(api, tabs, calls) {
        const get = api.tabs.get;
        api.tabs.get = async (id) => {
          if (calls.length) {
            if (!mismatch) throw new Error("readback failed");
            return { ...await get(id), windowId: 99 };
          }
          return get(id);
        };
      } });
      const result = await ctx.run(method, method === CREATE ? { ...request, groupId: 3 } : { tabId: 1, pinned: true });
      outcome(result, "incomplete", true, "observe_failed");
      assert.equal(result.tabId, method === CREATE ? 5 : 1);
      assert.equal(ctx.calls.length, 1);
    }
  }
});

test("group readback must show requested membership; creation without an id is unknown", async () => {
  const ctx = await load({ setup(api, tabs, calls) { api.tabs.group = async () => { calls.push(["group"]); return 3; }; } });
  outcome(await ctx.run(CREATE, { ...request, groupId: 3 }), "incomplete", true, "observe_failed");
  assert.equal(ctx.calls.length, 2);
  const noId = await load({ setup(api) { api.tabs.create = async () => ({}); } });
  outcome(await noId.run(CREATE, request), "error", null, "observe_failed");
});

test("runtime messages cannot create or pin tabs", async () => {
  const ctx = await load();
  for (const method of [CREATE, PIN]) {
    assert.equal((await ctx.listener({ method, browserSessionId: ctx.session, ...request, tabId: 1, pinned: true })).code, "unknown_method");
  }
  assert.deepEqual(ctx.calls, []);
});

test("tab result shapes reject malformed records and inconsistent partial outcomes", async () => {
  const ctx = await load();
  for (const [method, params] of [[CREATE, request], [PIN, { tabId: 1, pinned: true }]]) {
    const good = await ctx.run(method, params);
    for (const patch of [{ changed: false }, { tab: {} }, { tab: { ...good.tab, pinned: "true" } },
      { tab: { ...good.tab, pinned: true, groupId: 3 } },
      { status: "incomplete", code: "observe_failed", tabId: 1 },
      { status: "error", changed: true, code: "observe_failed", tabId: 1, windowId: 2 },
      { status: "incomplete", code: "bogus", tabId: 1, windowId: 2 }]) {
      assert.equal(validateMethodResult(method, { ...good, ...patch }).valid, false, JSON.stringify(patch));
    }
  }
});
