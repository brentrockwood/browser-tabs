import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CODES,
  MAX_HISTORY_SCAN,
  MAX_TAB_GROUPS_RETURNED,
  MAX_TABS_RETURNED,
  MAX_WINDOWS_RETURNED,
  validateMethodResult,
} from "../extension/protocol.js";

// service-worker.js resolves its browser API binding (globalThis.chrome) at
// import time and registers an onMessage listener as a side effect of
// import, both synchronously — browserSessionId resolution
// (getOrCreateSessionId in the module) is deliberately NOT a top-level
// await (that previously broke real-browser worker registration; see the
// regression test below) and instead happens via a `sessionReady` promise
// every exported browser operation awaits internally. Each test installs a
// fresh mock before
// importing the module under a unique query string so Node's ESM loader
// evaluates a fresh instance against that test's mock instead of a cached
// one. Each such instance has its own browserSessionId — tests that call a
// handle-consuming function (list_tabs, list_tab_groups, read_tab) must
// first learn it (via listWindows(), which carries no session requirement)
// and pass it back as the caller-supplied session id, the same
// way a real client would.
let caseId = 0;

function installBrowserApi(overrides = {}) {
  const api = {
    windows: { getAll: async () => [], get: async () => ({ id: 0 }) },
    tabs: { query: async () => [], get: async () => ({ id: 0, windowId: 0 }) },
    scripting: { executeScript: async () => [] },
    runtime: { onMessage: { addListener: () => {} } },
    ...overrides,
  };
  globalThis.chrome = api;
  return api;
}

// Imports a fresh module instance against whatever mock is currently
// installed on globalThis.chrome, without touching that mock itself — used
// directly by tests that already called installBrowserApi themselves (e.g.
// to install a capturing runtime.onMessage listener) and must not have that
// setup overwritten by a second, unrelated install.
async function importServiceWorker() {
  caseId += 1;
  return import(`../extension/service-worker.js?case=${caseId}`);
}

async function loadServiceWorker(overrides = {}) {
  installBrowserApi(overrides);
  return importServiceWorker();
}

async function setupListener(overrides = {}) {
  let listener;
  installBrowserApi({
    ...overrides,
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listener = fn;
        },
      },
    },
  });
  const mod = await importServiceWorker();
  return { listener: (message) => listener(message), mod };
}

// Every result envelope carries the session, including an error result, so
// listWindows() reveals it whatever the mock's windows API does.
async function sessionIdOf(mod) {
  const windows = await mod.listWindows();
  return windows.browserSessionId;
}

function fakeSessionStorage(initial = {}) {
  let value = { ...initial };
  return {
    get: async (keys) => Object.fromEntries(keys.map((key) => [key, value[key]])),
    set: async (patch) => {
      value = { ...value, ...patch };
    },
  };
}

function assertEnvelope(result, { sourceOperation, status }) {
  assert.equal(result.schemaVersion, 1);
  assert.equal(typeof result.browserSessionId, "string");
  assert.ok(result.browserSessionId.length > 0);
  assert.equal(result.sourceOperation, sourceOperation);
  assert.equal(result.status, status);
  assert.equal(typeof result.capturedAt, "number");
}

function makeHistoryEntries(count, { startTime = 0 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: String(1000 + i),
    url: `https://example.com/${i}`,
    title: `Page ${i}`,
    lastVisitTime: startTime + i,
    visitCount: 1,
    typedCount: 0,
  }));
}

// --- browserSessionId persistence -------------------------------------

test("persists the browser session id across separate worker loads via chrome.storage.session (simulating MV3 eviction)", async () => {
  const sharedSessionStorage = fakeSessionStorage();
  const first = await loadServiceWorker({ storage: { session: sharedSessionStorage } });
  const firstId = await sessionIdOf(first);

  const second = await loadServiceWorker({ storage: { session: sharedSessionStorage } });
  const secondId = await sessionIdOf(second);

  assert.equal(secondId, firstId, "a worker reload must reuse the persisted session id, not mint a new one");
});

test("falls back to a non-persisted session id when chrome.storage.session is unavailable (documented limitation)", async () => {
  const first = await loadServiceWorker({});
  const firstId = await sessionIdOf(first);
  const second = await loadServiceWorker({});
  const secondId = await sessionIdOf(second);
  assert.notEqual(secondId, firstId, "without storage.session, each worker load mints its own ephemeral session id");
});

test("falls back gracefully (without throwing) if chrome.storage.session.get itself fails", async () => {
  const brokenSessionStorage = {
    get: async () => {
      throw new Error("boom");
    },
    set: async () => {},
  };
  const mod = await loadServiceWorker({ storage: { session: brokenSessionStorage } });
  const result = await mod.listWindows();
  assert.equal(result.status, "ok");
  assert.equal(typeof result.browserSessionId, "string");
  assert.ok(result.browserSessionId.length > 0);
});

// Startup regression guard: a prior revision computed browserSessionId with
// a top-level `await getOrCreateSessionId()`, which — because top-level
// await suspends the *whole module's* evaluation, including the
// runtime.onMessage/alarms/storage listener registrations further down —
// broke real-browser worker startup entirely (both smoke tests could no
// longer locate the extension's service worker). This cannot be exercised
// against a real browser without one, but it can be proven here: with a
// storage.session.get() that never resolves, module evaluation (and so the
// dynamic import() below) must still complete, and the listener must still
// be registered, without ever waiting on session-id resolution.
test("module evaluation (and its listener registration) completes without blocking on session-id resolution", async () => {
  let listenerRegistered = false;
  installBrowserApi({
    storage: {
      session: {
        get: () => new Promise(() => {}), // deliberately never resolves
        set: () => new Promise(() => {}),
      },
    },
    runtime: {
      onMessage: {
        addListener: () => {
          listenerRegistered = true;
        },
      },
    },
  });

  const importPromise = importServiceWorker();
  const outcome = await Promise.race([
    importPromise.then(() => "imported"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 200)),
  ]);

  assert.equal(
    outcome,
    "imported",
    "the module must finish evaluating without waiting on session-id resolution; a top-level " +
      "`await getOrCreateSessionId()` (or any other top-level await of an unresolved promise) would hang here",
  );
  assert.equal(listenerRegistered, true, "runtime.onMessage.addListener must run during synchronous module evaluation");

  const mod = await importPromise;
  assert.equal(typeof mod.listWindows, "function");
});

// --- listWindows ---------------------------------------------------------

test("listWindows normalizes windows and reports bounded-list provenance", async () => {
  const { listWindows } = await loadServiceWorker({
    windows: {
      getAll: async (options) => {
        assert.deepEqual(options, { populate: true });
        return [{ id: 1, focused: true, type: "normal", state: "normal", tabs: [{}, {}] }];
      },
    },
  });
  const result = await listWindows();
  assertEnvelope(result, { sourceOperation: "browser.list_windows", status: "ok" });
  assert.deepEqual(result.windows, [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 2 }]);
  assert.equal(result.returnedCount, 1);
  assert.equal(result.totalCount, 1);
  assert.equal(result.truncated, false);
});

test("listWindows returns a stable error with diagnostic detail when the browser API fails", async () => {
  const { listWindows } = await loadServiceWorker({
    windows: {
      getAll: async () => {
        throw new Error("boom");
      },
    },
  });
  const result = await listWindows();
  assertEnvelope(result, { sourceOperation: "browser.list_windows", status: "error" });
  assert.equal(result.code, ERROR_CODES.LISTING_FAILED);
  assert.equal(result.detail, "boom");
});

test("listWindows truncates and reports it when more windows exist than the bound allows", async () => {
  const total = MAX_WINDOWS_RETURNED + 5;
  const all = Array.from({ length: total }, (_, i) => ({ id: i, focused: false, type: "normal", state: "normal", tabs: [] }));
  const { listWindows } = await loadServiceWorker({ windows: { getAll: async () => all } });
  const result = await listWindows();
  assert.equal(result.returnedCount, MAX_WINDOWS_RETURNED);
  assert.equal(result.totalCount, total);
  assert.equal(result.truncated, true);
});

// --- listTabs --------------------------------------------------------------

test("listTabs rejects a missing browserSessionId as stale_session, before validating windowId", async () => {
  let windowsGetCalled = false;
  const mod = await loadServiceWorker({ windows: { get: async () => ((windowsGetCalled = true), { id: 0 }) } });
  // Deliberately an invalid windowId too, to prove the session check wins.
  const result = await mod.listTabs(-1, undefined);
  assertEnvelope(result, { sourceOperation: "browser.list_tabs", status: "error" });
  assert.equal(result.code, ERROR_CODES.STALE_SESSION);
  assert.equal(windowsGetCalled, false, "must not resolve any handle before the session check");
});

test("listTabs rejects a mismatched browserSessionId as stale_session", async () => {
  const mod = await loadServiceWorker({});
  const result = await mod.listTabs(0, "not-the-real-session");
  assert.equal(result.code, ERROR_CODES.STALE_SESSION);
});

test("listTabs rejects an invalid windowId once the session matches", async () => {
  let called = false;
  const mod = await loadServiceWorker({
    tabs: {
      query: async () => {
        called = true;
        return [];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabs(-1, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tabs", status: "error" });
  assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
  assert.equal(called, false);
});

test("listTabs rejects a stale (nonexistent) windowId instead of silently returning an empty list", async () => {
  let queried = false;
  const mod = await loadServiceWorker({
    windows: {
      get: async () => {
        throw new Error("No window with id: 3.");
      },
    },
    tabs: {
      query: async () => {
        queried = true;
        return [];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabs(3, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tabs", status: "error" });
  assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
  assert.equal(result.detail, "No window with id: 3.");
  assert.equal(queried, false, "must not query tabs for a window that failed the existence check");
});

test("listTabs returns normalized tabs with counts and windowId for a valid windowId", async () => {
  const mod = await loadServiceWorker({
    windows: { get: async (id) => ({ id }) },
    tabs: {
      query: async (filter) => {
        assert.deepEqual(filter, { windowId: 3 });
        return [
          {
            id: 10,
            windowId: 3,
            index: 0,
            active: true,
            pinned: false,
            audible: false,
            discarded: false,
            status: "complete",
            title: "T",
            url: "https://example.com",
          },
          { id: 11, windowId: 3, index: 1, groupId: 8, status: "complete" },
        ];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabs(3, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tabs", status: "ok" });
  assert.equal(result.windowId, 3);
  assert.equal(result.tabs.length, 2);
  assert.equal(result.tabs[0].tabId, 10);
  assert.equal(result.tabs[0].groupId, -1, "a browser that omits groupId reports no group");
  assert.equal(result.tabs[1].groupId, 8);
  assert.equal(validateMethodResult("browser.list_tabs", result).valid, true);
  assert.equal(result.returnedCount, 2);
  assert.equal(result.totalCount, 2);
  assert.equal(result.truncated, false);
});

test("listTabs returns a stable error with diagnostic detail when the browser API fails after the window exists", async () => {
  const mod = await loadServiceWorker({
    windows: { get: async (id) => ({ id }) },
    tabs: {
      query: async () => {
        throw new Error("something else went wrong");
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabs(999, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tabs", status: "error" });
  assert.equal(result.code, ERROR_CODES.LISTING_FAILED);
  assert.equal(result.detail, "something else went wrong");
});

test("listTabs truncates and reports it when more tabs exist than the bound allows", async () => {
  const total = MAX_TABS_RETURNED + 5;
  const all = Array.from({ length: total }, (_, i) => ({
    id: i,
    windowId: 1,
    index: i,
    active: false,
    pinned: false,
    audible: false,
    discarded: false,
  }));
  const mod = await loadServiceWorker({
    windows: { get: async (id) => ({ id }) },
    tabs: { query: async () => all },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabs(1, sessionId);
  assert.equal(result.returnedCount, MAX_TABS_RETURNED);
  assert.equal(result.totalCount, total);
  assert.equal(result.truncated, true);
});

// --- listTabGroups -----------------------------------------------------

test("listTabGroups rejects a missing or mismatched browserSessionId as stale_session before anything else", async () => {
  let windowsGetCalled = false;
  const mod = await loadServiceWorker({
    windows: { get: async () => ((windowsGetCalled = true), { id: 0 }) },
    tabGroups: undefined,
  });
  const missing = await mod.listTabGroups(0, undefined);
  assert.equal(missing.code, ERROR_CODES.STALE_SESSION);
  const mismatched = await mod.listTabGroups(0, "wrong-session");
  assert.equal(mismatched.code, ERROR_CODES.STALE_SESSION);
  assert.equal(windowsGetCalled, false, "must not resolve the window handle before the session check");
});

test("listTabGroups rejects an invalid windowId once the session matches", async () => {
  const mod = await loadServiceWorker({ tabGroups: undefined });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabGroups("nope", sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tab_groups", status: "error" });
  assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
});

test("listTabGroups rejects a stale window handle even when the browser does not support tabGroups at all", async () => {
  // Handle validity is checked before the capability check (project.md
  // Stage 2 remediation): a caller gets "your handle is no good", not a
  // possibly-misleading "unsupported", when both would technically be true.
  const mod = await loadServiceWorker({
    windows: {
      get: async () => {
        throw new Error("No window with id: 9.");
      },
    },
    tabGroups: undefined,
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabGroups(9, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tab_groups", status: "error" });
  assert.equal(result.code, ERROR_CODES.STALE_HANDLE, "a stale handle must win over an unsupported-capability outcome");
});

test("listTabGroups rejects a stale windowId when tabGroups is supported", async () => {
  const mod = await loadServiceWorker({
    windows: {
      get: async () => {
        throw new Error("No window with id: 9.");
      },
    },
    tabGroups: { query: async () => [] },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabGroups(9, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tab_groups", status: "error" });
  assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
});

test("listTabGroups reports the capability explicitly when the window exists but the browser has no tabGroups API", async () => {
  const mod = await loadServiceWorker({ windows: { get: async (id) => ({ id }) }, tabGroups: undefined });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabGroups(3, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tab_groups", status: "unsupported" });
  assert.equal(result.code, ERROR_CODES.UNSUPPORTED_FEATURE);
  assert.equal(result.windowId, 3);
});

test("listTabGroups returns normalized groups with counts for a supported browser", async () => {
  const mod = await loadServiceWorker({
    windows: { get: async (id) => ({ id }) },
    tabGroups: {
      query: async (filter) => {
        assert.deepEqual(filter, { windowId: 4 });
        return [{ id: 1, windowId: 4, title: "Work", color: "blue", collapsed: false }];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabGroups(4, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tab_groups", status: "ok" });
  assert.equal(result.windowId, 4);
  assert.deepEqual(result.groups, [{ groupId: 1, windowId: 4, title: "Work", color: "blue", collapsed: false }]);
  assert.equal(result.returnedCount, 1);
  assert.equal(result.totalCount, 1);
  assert.equal(result.truncated, false);
});

test("listTabGroups truncates and reports it when more groups exist than the bound allows", async () => {
  const total = MAX_TAB_GROUPS_RETURNED + 5;
  const all = Array.from({ length: total }, (_, i) => ({ id: i, windowId: 4, title: `G${i}`, color: "grey", collapsed: false }));
  const mod = await loadServiceWorker({
    windows: { get: async (id) => ({ id }) },
    tabGroups: { query: async () => all },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabGroups(4, sessionId);
  assert.equal(result.returnedCount, MAX_TAB_GROUPS_RETURNED);
  assert.equal(result.totalCount, total);
  assert.equal(result.truncated, true);
});

test("listTabGroups returns a stable error when the query itself fails", async () => {
  const mod = await loadServiceWorker({
    windows: { get: async (id) => ({ id }) },
    tabGroups: {
      query: async () => {
        throw new Error("boom");
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.listTabGroups(4, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.list_tab_groups", status: "error" });
  assert.equal(result.code, ERROR_CODES.TAB_GROUPS_QUERY_FAILED);
  assert.equal(result.detail, "boom");
});

// --- readTab -----------------------------------------------------------

test("readTab rejects a missing or mismatched browserSessionId as stale_session before resolving the tab handle", async () => {
  let tabsGetCalled = false;
  const mod = await loadServiceWorker({ tabs: { get: async () => ((tabsGetCalled = true), { id: 0, windowId: 0 }) } });
  const missing = await mod.readTab(0, undefined);
  assert.equal(missing.code, ERROR_CODES.STALE_SESSION);
  const mismatched = await mod.readTab(0, "wrong-session");
  assert.equal(mismatched.code, ERROR_CODES.STALE_SESSION);
  assert.equal(tabsGetCalled, false);
});

test("readTab rejects an invalid tabId once the session matches", async () => {
  let called = false;
  const mod = await loadServiceWorker({
    scripting: {
      executeScript: async () => {
        called = true;
        return [];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab("not-a-tab", sessionId);
  assertEnvelope(result, { sourceOperation: "browser.read_tab", status: "error" });
  assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);
  assert.equal(called, false);
});

test("readTab rejects a stale (closed) tabId instead of attempting injection", async () => {
  let injected = false;
  const mod = await loadServiceWorker({
    tabs: {
      get: async () => {
        throw new Error("No tab with id: 6.");
      },
    },
    scripting: {
      executeScript: async () => {
        injected = true;
        return [];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(6, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.read_tab", status: "error" });
  assert.equal(result.code, ERROR_CODES.STALE_HANDLE);
  assert.equal(result.detail, "No tab with id: 6.");
  assert.equal(injected, false, "must not attempt injection against a handle that failed the existence check");
});

test("readTab reports tab_loading and skips injection entirely for a tab still mid-navigation", async () => {
  let injected = false;
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 3, status: "loading" }) },
    scripting: {
      executeScript: async () => {
        injected = true;
        return [];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(11, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.read_tab", status: "not_ready" });
  assert.equal(result.code, ERROR_CODES.TAB_LOADING);
  assert.equal(result.tabId, 11);
  assert.equal(result.windowId, 3);
  assert.equal(injected, false, "scripting.executeScript must never be called against a tab still mid-navigation");
});

test("readTab returns an ok snapshot with full and returned character counts for a successful injection", async () => {
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 7 }) },
    scripting: {
      executeScript: async ({ target, func, args }) => {
        assert.equal(target.tabId, 5);
        assert.equal(target.allFrames, false);
        assert.equal(typeof func, "function");
        assert.deepEqual(args, [500_000, ERROR_CODES.DOCUMENT_HAS_NO_BODY]);
        return [
          {
            result: {
              status: "ok",
              title: "T",
              url: "https://example.com",
              text: "hi",
              characterCount: 2,
              truncated: false,
              documentReadyState: "complete",
            },
          },
        ];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(5, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.read_tab", status: "ok" });
  assert.equal(result.tabId, 5);
  assert.equal(result.windowId, 7);
  assert.equal(result.title, "T");
  assert.equal(result.url, "https://example.com");
  assert.equal(result.text, "hi");
  assert.equal(result.characterCount, 2);
  assert.equal(result.returnedCharacterCount, 2);
  assert.equal(result.truncated, false);
  assert.equal(result.documentReadyState, "complete");
});

test("readTab reports the returned character count separately from the full count when truncated", async () => {
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 1 }) },
    scripting: {
      executeScript: async () => [
        {
          result: {
            status: "ok",
            title: "T",
            url: "https://example.com",
            text: "0123",
            characterCount: 10,
            truncated: true,
            documentReadyState: "complete",
          },
        },
      ],
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(5, sessionId);
  assert.equal(result.characterCount, 10);
  assert.equal(result.returnedCharacterCount, 4);
  assert.equal(result.truncated, true);
});

test("readTab reports an explicit outcome when injection yields no results", async () => {
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 1 }) },
    scripting: { executeScript: async () => [] },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(6, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.read_tab", status: "unsupported" });
  assert.equal(result.code, ERROR_CODES.NO_INJECTION_RESULT);
  assert.equal(result.tabId, 6);
  assert.equal(result.windowId, 1);
});

test("readTab reports an explicit outcome when the main frame has no result", async () => {
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 1 }) },
    scripting: { executeScript: async () => [{}] },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(7, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.read_tab", status: "unsupported" });
  assert.equal(result.code, ERROR_CODES.NO_MAIN_FRAME_RESULT);
});

test("readTab reports not_ready with the propagated code when the document has no body", async () => {
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 1 }) },
    scripting: { executeScript: async () => [{ result: { status: "not_ready", code: ERROR_CODES.DOCUMENT_HAS_NO_BODY } }] },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(9, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.read_tab", status: "not_ready" });
  assert.equal(result.code, ERROR_CODES.DOCUMENT_HAS_NO_BODY);
});

test("readTab retains the browser error text as diagnostic detail when injection is rejected", async () => {
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 1 }) },
    scripting: {
      executeScript: async () => {
        throw new Error('Cannot access contents of url "chrome://version/"');
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(8, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.read_tab", status: "unsupported" });
  assert.equal(result.code, ERROR_CODES.INJECTION_REJECTED);
  assert.equal(result.detail, 'Cannot access contents of url "chrome://version/"');
});

test("readTab returns an explicit internal error (not a rejected promise) when the injected snapshot result is malformed", async () => {
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 1 }) },
    // Missing `text`/`characterCount`/etc: a shape no real pageTextSnapshot
    // call would ever produce, simulating a corrupted/unexpected result.
    scripting: { executeScript: async () => [{ result: { status: "ok" } }] },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(5, sessionId);
  assertEnvelope(result, { sourceOperation: "browser.read_tab", status: "error" });
  assert.equal(result.code, ERROR_CODES.INVALID_EXTENSION_RESPONSE);
  assert.equal(result.tabId, 5);
  assert.equal(result.windowId, 1);
});

test("readTab returns an explicit internal error for a snapshot result with an unrecognized status", async () => {
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 1 }) },
    scripting: { executeScript: async () => [{ result: { status: "something-else" } }] },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(5, sessionId);
  assert.equal(result.status, "error");
  assert.equal(result.code, ERROR_CODES.INVALID_EXTENSION_RESPONSE);
});

test("readTab returns an explicit internal error for a not_ready snapshot result missing its code", async () => {
  const mod = await loadServiceWorker({
    tabs: { get: async (id) => ({ id, windowId: 1 }) },
    scripting: { executeScript: async () => [{ result: { status: "not_ready" } }] },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await mod.readTab(5, sessionId);
  assert.equal(result.status, "error");
  assert.equal(result.code, ERROR_CODES.INVALID_EXTENSION_RESPONSE);
});

// --- queryHistory (offset-based pagination) -----------------------------

test("queryHistory reports the capability explicitly when the browser has no history API", async () => {
  const { queryHistory } = await loadServiceWorker({ history: undefined });
  const result = await queryHistory({ startTime: 0, endTime: 1000 });
  assertEnvelope(result, { sourceOperation: "browser.query_history", status: "unsupported" });
  assert.equal(result.code, ERROR_CODES.UNSUPPORTED_FEATURE);
});

test("queryHistory rejects a missing or inverted time range", async () => {
  const { queryHistory } = await loadServiceWorker({ history: { search: async () => [] } });
  const missing = await queryHistory({});
  assertEnvelope(missing, { sourceOperation: "browser.query_history", status: "error" });
  assert.equal(missing.code, ERROR_CODES.INVALID_PARAMS);

  const inverted = await queryHistory({ startTime: 1000, endTime: 0 });
  assert.equal(inverted.code, ERROR_CODES.INVALID_PARAMS);
});

test("queryHistory rejects an out-of-bounds maxResults", async () => {
  const { queryHistory } = await loadServiceWorker({ history: { search: async () => [] } });
  const result = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 0 });
  assert.equal(result.code, ERROR_CODES.INVALID_PARAMS);

  const tooMany = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 100_000 });
  assert.equal(tooMany.code, ERROR_CODES.INVALID_PARAMS);
});

test("queryHistory rejects a negative or non-integer cursor", async () => {
  const { queryHistory } = await loadServiceWorker({ history: { search: async () => [] } });
  const negative = await queryHistory({ startTime: 0, endTime: 1000, cursor: -1 });
  assert.equal(negative.code, ERROR_CODES.INVALID_PARAMS);
  const fractional = await queryHistory({ startTime: 0, endTime: 1000, cursor: 1.5 });
  assert.equal(fractional.code, ERROR_CODES.INVALID_PARAMS);
});

test("queryHistory returns an explicit incomplete/pagination_limit_reached outcome, without querying the browser, once the cursor is at or beyond the scan ceiling", async () => {
  let searched = false;
  const { queryHistory } = await loadServiceWorker({
    history: {
      search: async () => {
        searched = true;
        return [];
      },
    },
  });
  const result = await queryHistory({ startTime: 0, endTime: 1000, cursor: MAX_HISTORY_SCAN });
  assertEnvelope(result, { sourceOperation: "browser.query_history", status: "incomplete" });
  assert.equal(result.code, ERROR_CODES.PAGINATION_LIMIT_REACHED);
  assert.equal(searched, false, "must not scan at all once the offset itself is beyond the ceiling");
});

test("queryHistory always scans the full MAX_HISTORY_SCAN-sized set (not a page-size-dependent amount) and sorts it deterministically, tie-breaking entries sharing the exact same lastVisitTime by id", async () => {
  const { queryHistory } = await loadServiceWorker({
    history: {
      search: async ({ text, startTime, endTime, maxResults }) => {
        assert.equal(text, "");
        assert.equal(startTime, 0);
        assert.equal(endTime, 1000);
        assert.equal(maxResults, MAX_HISTORY_SCAN, "every page must request the same bounded scan set, regardless of pageSize/offset");
        return [
          { id: "b", url: "https://b.example", title: "B", lastVisitTime: 100, visitCount: 2, typedCount: 1 },
          { id: "a", url: "https://a.example", title: "A", lastVisitTime: 100, visitCount: 1, typedCount: 0 },
        ];
      },
    },
  });
  const result = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 2 });
  assertEnvelope(result, { sourceOperation: "browser.query_history", status: "ok" });
  assert.equal(result.startTime, 0);
  assert.equal(result.endTime, 1000);
  // Same lastVisitTime for both; deterministic tie-break puts "a" first.
  assert.deepEqual(result.entries.map((entry) => entry.id), ["a", "b"]);
  assert.equal(result.returnedCount, 2);
});

// Regression: a prior implementation requested a page-size-dependent amount
// (offset + pageSize + 1) from the browser on each call. Because
// chrome.history.search's tie-breaking for entries sharing the exact same
// lastVisitTime is not guaranteed stable across *different-sized* maxResults
// requests, two pages computed from two differently-sized requests could, in
// principle, duplicate or skip a tied entry. Here all three entries share
// one lastVisitTime, and the mock deliberately returns them in a scrambled
// order ([c, b, a]) every time — proving that because every page now
// requests the identical MAX_HISTORY_SCAN-sized set and sorts it the same
// way, two sequential one-entry pages return distinct, deterministic
// entries (a, then b), never a duplicate or a skip.
test("exact-equal-timestamp entries paginate as distinct, deterministic entries across pages (duplicate/skip regression)", async () => {
  const tied = (id) => ({ id, url: `https://${id}.example`, title: id.toUpperCase(), lastVisitTime: 100, visitCount: 1, typedCount: 0 });
  const browserOrder = [tied("c"), tied("b"), tied("a")];
  const { queryHistory } = await loadServiceWorker({
    history: { search: async () => browserOrder },
  });

  const first = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 1 });
  assert.deepEqual(first.entries.map((entry) => entry.id), ["a"]);
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, 1);

  const second = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 1, cursor: first.nextCursor });
  assert.deepEqual(second.entries.map((entry) => entry.id), ["b"]);
  assert.equal(second.truncated, true);
  assert.equal(second.nextCursor, 2);

  const third = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 1, cursor: second.nextCursor });
  assert.deepEqual(third.entries.map((entry) => entry.id), ["c"]);
  assert.equal(third.truncated, false);
  assert.equal(third.nextCursor, null);
});

test("queryHistory reports no further pages (exhaustive scan) when fewer entries than the scan ceiling are returned", async () => {
  const { queryHistory } = await loadServiceWorker({
    history: {
      search: async () => [{ id: "1", url: "https://a.example", title: "A", lastVisitTime: 100, visitCount: 1, typedCount: 0 }],
    },
  });
  const result = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 10 });
  assert.equal(result.truncated, false);
  assert.equal(result.nextCursor, null);
  assert.equal(result.returnedCount, 1);
});

test("queryHistory reports truncated with a nextCursor equal to offset + pageSize when more entries exist within the scanned set", async () => {
  const entries = makeHistoryEntries(3);
  const { queryHistory } = await loadServiceWorker({ history: { search: async () => entries } });
  const result = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 2 });
  assert.equal(result.returnedCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.nextCursor, 2);
});

test("queryHistory's cursor pages correctly across two sequential calls", async () => {
  const entries = makeHistoryEntries(2); // exactly two entries total
  const { queryHistory } = await loadServiceWorker({ history: { search: async () => entries } });

  const first = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 1 });
  assert.equal(first.entries.length, 1);
  assert.equal(first.truncated, true);
  assert.equal(first.nextCursor, 1);

  const second = await queryHistory({ startTime: 0, endTime: 1000, maxResults: 1, cursor: first.nextCursor });
  assert.equal(second.entries.length, 1);
  assert.notEqual(second.entries[0].id, first.entries[0].id);
  assert.equal(second.truncated, false);
  assert.equal(second.nextCursor, null);
});

test("queryHistory returns an explicit incomplete outcome when the scan ceiling is reached before a full page can be determined", async () => {
  // offset + pageSize reaches the MAX_HISTORY_SCAN boundary, and the browser
  // mock returns exactly MAX_HISTORY_SCAN entries (as if there could be
  // more beyond the ceiling that was never scanned).
  const offset = MAX_HISTORY_SCAN - 5;
  const entries = makeHistoryEntries(MAX_HISTORY_SCAN);
  const { queryHistory } = await loadServiceWorker({
    history: {
      search: async ({ maxResults }) => {
        assert.equal(maxResults, MAX_HISTORY_SCAN);
        return entries;
      },
    },
  });
  const result = await queryHistory({ startTime: 0, endTime: 1_000_000, maxResults: 10, cursor: offset });
  assertEnvelope(result, { sourceOperation: "browser.query_history", status: "incomplete" });
  assert.equal(result.code, ERROR_CODES.PAGINATION_LIMIT_REACHED);
});

test("queryHistory returns a stable error with diagnostic detail when the browser API fails", async () => {
  const { queryHistory } = await loadServiceWorker({
    history: {
      search: async () => {
        throw new Error("boom");
      },
    },
  });
  const result = await queryHistory({ startTime: 0, endTime: 1000 });
  assertEnvelope(result, { sourceOperation: "browser.query_history", status: "error" });
  assert.equal(result.code, ERROR_CODES.HISTORY_QUERY_FAILED);
  assert.equal(result.detail, "boom");
});

test("readTab, listWindows, and listTabs from the same module instance share one browserSessionId", async () => {
  const mod = await loadServiceWorker({
    windows: { getAll: async () => [], get: async (id) => ({ id }) },
    tabs: { query: async () => [], get: async (id) => ({ id, windowId: 1 }) },
    scripting: { executeScript: async () => [{ result: { status: "not_ready", code: ERROR_CODES.DOCUMENT_HAS_NO_BODY } }] },
  });
  const sessionId = await sessionIdOf(mod);
  const [windows, tabs, tab] = await Promise.all([mod.listWindows(), mod.listTabs(1, sessionId), mod.readTab(2, sessionId)]);
  assert.equal(windows.browserSessionId, sessionId);
  assert.equal(tabs.browserSessionId, sessionId);
  assert.equal(tab.browserSessionId, sessionId);
});

// --- the registered runtime.onMessage listener --------------------------

test("the registered onMessage listener routes browser.list_windows", async () => {
  const { listener } = await setupListener({
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: "normal", state: "normal", tabs: [] }],
    },
  });
  const result = await listener({ method: "browser.list_windows" });
  assert.deepEqual(result.windows, [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 0 }]);
});

test("the registered onMessage listener routes browser.list_tabs with windowId and browserSessionId", async () => {
  const { listener, mod } = await setupListener({
    windows: { get: async (id) => ({ id }) },
    tabs: {
      query: async (filter) => {
        assert.deepEqual(filter, { windowId: 2 });
        return [];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await listener({ method: "browser.list_tabs", windowId: 2, browserSessionId: sessionId });
  assert.deepEqual(result.tabs, []);
});

test("the registered onMessage listener rejects browser.list_tabs with a missing browserSessionId", async () => {
  const { listener } = await setupListener({});
  const result = await listener({ method: "browser.list_tabs", windowId: 2 });
  assert.equal(result.code, ERROR_CODES.STALE_SESSION);
});

test("the registered onMessage listener routes browser.list_tab_groups with windowId and browserSessionId", async () => {
  const { listener, mod } = await setupListener({
    windows: { get: async (id) => ({ id }) },
    tabGroups: {
      query: async (filter) => {
        assert.deepEqual(filter, { windowId: 2 });
        return [];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await listener({ method: "browser.list_tab_groups", windowId: 2, browserSessionId: sessionId });
  assert.deepEqual(result.groups, []);
});

test("the registered onMessage listener routes browser.read_tab with tabId and browserSessionId", async () => {
  const { listener, mod } = await setupListener({
    tabs: { get: async (id) => ({ id, windowId: 1 }) },
    scripting: {
      executeScript: async ({ target }) => {
        assert.equal(target.tabId, 9);
        return [{ result: { status: "not_ready", code: ERROR_CODES.DOCUMENT_HAS_NO_BODY } }];
      },
    },
  });
  const sessionId = await sessionIdOf(mod);
  const result = await listener({ method: "browser.read_tab", tabId: 9, browserSessionId: sessionId });
  assert.equal(result.tabId, 9);
  assert.equal(result.status, "not_ready");
  assert.equal(result.code, ERROR_CODES.DOCUMENT_HAS_NO_BODY);
});

test("the registered onMessage listener routes browser.query_history with its params (no session required)", async () => {
  const { listener } = await setupListener({
    history: {
      search: async ({ startTime, endTime, maxResults }) => {
        assert.equal(startTime, 0);
        assert.equal(endTime, 1000);
        assert.equal(maxResults, MAX_HISTORY_SCAN);
        return [];
      },
    },
  });
  const result = await listener({ method: "browser.query_history", startTime: 0, endTime: 1000, maxResults: 5 });
  assert.deepEqual(result.entries, []);
});

test("the registered onMessage listener returns a stable error for an unknown method", async () => {
  const { listener } = await setupListener({});
  const result = await listener({ method: "browser.not_a_real_method" });
  assert.equal(result.status, "error");
  assert.equal(result.code, "unknown_method");
  assert.equal(result.detail, "browser.not_a_real_method");
});

test("the registered onMessage listener returns a stable error for a malformed or missing message", async () => {
  const { listener } = await setupListener({});
  const undefinedResult = await listener(undefined);
  assert.equal(undefinedResult.status, "error");
  assert.equal(undefinedResult.code, "unknown_method");
  const emptyResult = await listener({});
  assert.equal(emptyResult.status, "error");
  assert.equal(emptyResult.code, "unknown_method");
});
