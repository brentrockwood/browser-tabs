// Test-only content script, injected only into the temporary copy of the
// Firefox extension staged by test/smoke/firefox-smoke.mjs (never part of
// extension/manifest.firefox.json or the real build/build-extension.mjs
// output) — matching only the smoke test's own local fixture page, by host,
// regardless of its ephemeral port (WebExtension match patterns ignore the
// port unless one is explicitly given).
//
// A content script already has access to `browser.runtime.sendMessage`
// (talking only to its own extension's background) and `browser.storage`
// (already permitted by the "storage" permission every build declares) —
// exactly the same two capabilities a real pairing/read-API caller uses, so
// this exercises the real `routeMessage` dispatch in service-worker.js, not
// a stand-in. The pairing token is read from this page's own URL
// query string (set by firefox-smoke.mjs when it navigates here), so no
// privileged, browser-internal lookup (e.g. the extension's moz-extension://
// UUID) is ever needed.
(async () => {
  const result = { ok: false, steps: {} };
  try {
    const token = new URL(location.href).searchParams.get("browserTabsSmokeToken");
    if (token) {
      await browser.storage.local.set({ serviceToken: token });
    }

    const windows = await browser.runtime.sendMessage({ method: "browser.list_windows" });
    result.steps.windows = windows;
    const browserSessionId = windows?.browserSessionId;

    const ownTab = Array.isArray(windows?.windows) ? windows.windows[0] : undefined;
    const tabs = ownTab
      ? await browser.runtime.sendMessage({ method: "browser.list_tabs", windowId: ownTab.windowId, browserSessionId })
      : null;
    result.steps.tabs = tabs;

    const thisTab = Array.isArray(tabs?.tabs) ? tabs.tabs.find((tab) => tab.url === location.href) : undefined;
    const snapshot = thisTab
      ? await browser.runtime.sendMessage({ method: "browser.read_tab", tabId: thisTab.tabId, browserSessionId })
      : null;
    result.steps.snapshot = snapshot;
    result.tabId = thisTab?.tabId ?? null;
    result.browserSessionId = browserSessionId ?? null;

    result.steps.groups = ownTab
      ? await browser.runtime.sendMessage({ method: "browser.list_tab_groups", windowId: ownTab.windowId, browserSessionId })
      : null;

    result.steps.history = await browser.runtime.sendMessage({
      method: "browser.query_history",
      startTime: 0,
      endTime: Date.now(),
      browserSessionId,
    });

    result.ok = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  document.documentElement.setAttribute("data-browser-tabs-smoke-result", JSON.stringify(result));
})();
