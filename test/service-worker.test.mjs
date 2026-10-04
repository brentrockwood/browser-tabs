import assert from "node:assert/strict";
import test from "node:test";

import { ERROR_CODES } from "../extension/protocol.js";

// service-worker.js resolves its browser API binding (globalThis.chrome) at
// import time, and registers an onMessage listener as a side effect of
// import. Each test installs a fresh mock before importing the module under
// a unique query string so Node's ESM loader evaluates a fresh instance
// against that test's mock instead of a cached one.
let caseId = 0;

function installBrowserApi(overrides = {}) {
  const api = {
    windows: { getAll: async () => [] },
    tabs: { query: async () => [] },
    scripting: { executeScript: async () => [] },
    runtime: { onMessage: { addListener: () => {} } },
    ...overrides,
  };
  globalThis.chrome = api;
  return api;
}

async function loadServiceWorker() {
  caseId += 1;
  return import(`../extension/service-worker.js?case=${caseId}`);
}

function captureListener(overrides = {}) {
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
  return () => listener;
}

test("listWindows normalizes windows returned by the browser API", async () => {
  installBrowserApi({
    windows: {
      getAll: async (options) => {
        assert.deepEqual(options, { populate: true });
        return [{ id: 1, focused: true, type: "normal", state: "normal", tabs: [{}, {}] }];
      },
    },
  });
  const { listWindows } = await loadServiceWorker();
  assert.deepEqual(await listWindows(), [
    { windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 2 },
  ]);
});

test("listWindows returns a stable error with diagnostic detail when the browser API fails", async () => {
  installBrowserApi({
    windows: {
      getAll: async () => {
        throw new Error("boom");
      },
    },
  });
  const { listWindows } = await loadServiceWorker();
  assert.deepEqual(await listWindows(), {
    status: "error",
    code: ERROR_CODES.LISTING_FAILED,
    detail: "boom",
  });
});

test("listTabs rejects an invalid windowId before calling the browser API", async () => {
  let called = false;
  installBrowserApi({
    tabs: {
      query: async () => {
        called = true;
        return [];
      },
    },
  });
  const { listTabs } = await loadServiceWorker();
  assert.deepEqual(await listTabs(-1), {
    status: "error",
    code: "invalid_params",
    detail: "windowId must be a non-negative safe integer",
  });
  assert.equal(called, false);
});

test("listTabs returns normalized tabs for a valid windowId", async () => {
  installBrowserApi({
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
        ];
      },
    },
  });
  const { listTabs } = await loadServiceWorker();
  const tabs = await listTabs(3);
  assert.equal(tabs.length, 1);
  assert.equal(tabs[0].tabId, 10);
  assert.equal(tabs[0].windowId, 3);
});

test("listTabs returns a stable error with diagnostic detail when the browser API fails", async () => {
  installBrowserApi({
    tabs: {
      query: async () => {
        throw new Error("No window with id: 999");
      },
    },
  });
  const { listTabs } = await loadServiceWorker();
  assert.deepEqual(await listTabs(999), {
    status: "error",
    code: ERROR_CODES.LISTING_FAILED,
    detail: "No window with id: 999",
  });
});

test("readTab rejects an invalid tabId before calling the browser API", async () => {
  let called = false;
  installBrowserApi({
    scripting: {
      executeScript: async () => {
        called = true;
        return [];
      },
    },
  });
  const { readTab } = await loadServiceWorker();
  assert.deepEqual(await readTab("not-a-tab"), {
    status: "error",
    code: "invalid_params",
    detail: "tabId must be a non-negative safe integer",
  });
  assert.equal(called, false);
});

test("readTab returns an ok snapshot for a successful injection", async () => {
  installBrowserApi({
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
  const { readTab } = await loadServiceWorker();
  assert.deepEqual(await readTab(5), {
    schemaVersion: 1,
    tabId: 5,
    status: "ok",
    title: "T",
    url: "https://example.com",
    text: "hi",
    characterCount: 2,
    truncated: false,
    documentReadyState: "complete",
  });
});

test("readTab keeps the trusted schemaVersion and tabId even if the injected result collides with them", async () => {
  installBrowserApi({
    scripting: {
      executeScript: async () => [
        {
          result: {
            status: "ok",
            title: "T",
            url: "https://example.com",
            text: "hi",
            characterCount: 2,
            truncated: false,
            documentReadyState: "complete",
            schemaVersion: 999,
            tabId: "evil",
          },
        },
      ],
    },
  });
  const { readTab } = await loadServiceWorker();
  const result = await readTab(42);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.tabId, 42);
});

test("readTab reports an explicit outcome when injection yields no results", async () => {
  installBrowserApi({ scripting: { executeScript: async () => [] } });
  const { readTab } = await loadServiceWorker();
  assert.deepEqual(await readTab(6), {
    schemaVersion: 1,
    tabId: 6,
    status: "unsupported",
    code: "no_injection_result",
  });
});

test("readTab reports an explicit outcome when the main frame has no result", async () => {
  installBrowserApi({ scripting: { executeScript: async () => [{}] } });
  const { readTab } = await loadServiceWorker();
  assert.deepEqual(await readTab(7), {
    schemaVersion: 1,
    tabId: 7,
    status: "unsupported",
    code: "no_main_frame_result",
  });
});

test("readTab retains the browser error text as diagnostic detail when injection is rejected", async () => {
  installBrowserApi({
    scripting: {
      executeScript: async () => {
        throw new Error('Cannot access contents of url "chrome://version/"');
      },
    },
  });
  const { readTab } = await loadServiceWorker();
  assert.deepEqual(await readTab(8), {
    schemaVersion: 1,
    tabId: 8,
    status: "unsupported",
    code: "injection_rejected",
    detail: 'Cannot access contents of url "chrome://version/"',
  });
});

test("the registered onMessage listener routes browser.list_windows", async () => {
  const getListener = captureListener({
    windows: {
      getAll: async () => [{ id: 1, focused: true, type: "normal", state: "normal", tabs: [] }],
    },
  });
  await loadServiceWorker();
  assert.deepEqual(await getListener()({ method: "browser.list_windows" }), [
    { windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 0 },
  ]);
});

test("the registered onMessage listener routes browser.list_tabs with the windowId param", async () => {
  const getListener = captureListener({
    tabs: {
      query: async (filter) => {
        assert.deepEqual(filter, { windowId: 2 });
        return [];
      },
    },
  });
  await loadServiceWorker();
  assert.deepEqual(await getListener()({ method: "browser.list_tabs", windowId: 2 }), []);
});

test("the registered onMessage listener routes browser.read_tab with the tabId param", async () => {
  const getListener = captureListener({
    scripting: {
      executeScript: async ({ target }) => {
        assert.equal(target.tabId, 9);
        return [{ result: { status: "not_ready", code: ERROR_CODES.DOCUMENT_HAS_NO_BODY } }];
      },
    },
  });
  await loadServiceWorker();
  assert.deepEqual(await getListener()({ method: "browser.read_tab", tabId: 9 }), {
    schemaVersion: 1,
    tabId: 9,
    status: "not_ready",
    code: ERROR_CODES.DOCUMENT_HAS_NO_BODY,
  });
});

test("the registered onMessage listener returns a stable error for an unknown method", async () => {
  const getListener = captureListener();
  await loadServiceWorker();
  assert.deepEqual(await getListener()({ method: "browser.not_a_real_method" }), {
    status: "error",
    code: "unknown_method",
    detail: "browser.not_a_real_method",
  });
});

test("the registered onMessage listener returns a stable error for a malformed or missing message", async () => {
  const getListener = captureListener();
  await loadServiceWorker();
  assert.deepEqual(await getListener()(undefined), { status: "error", code: "unknown_method" });
  assert.deepEqual(await getListener()({}), { status: "error", code: "unknown_method" });
});
