import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_RESULT_STATUSES,
  ERROR_CODES,
  MAX_OPEN_URL_LENGTH,
  MAX_TEXT_CHARACTERS,
  PROTOCOL_VERSION,
  RESULT_SCHEMA_VERSION,
  captureEnvelope,
  compareHistoryEntries,
  isNonEmptyString,
  isValidHandle,
  isValidSessionId,
  isValidTimestamp,
  normalizeHistoryEntry,
  normalizeOpenUrl,
  normalizeTab,
  normalizeTabGroup,
  normalizeWindow,
  pageTextSnapshot,
  requestError,
  validateMethodResult,
} from "../extension/protocol.js";

// pageTextSnapshot runs inside a tab in real use; here we stub the DOM
// globals it reads so the extraction logic is testable without a browser.
function withDom(bodyText, { hasBody = true, readyState = "complete" } = {}, run) {
  const hadDocument = "document" in globalThis;
  const hadLocation = "location" in globalThis;
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;

  globalThis.document = {
    title: "Fixture",
    readyState,
    body: hasBody ? { innerText: bodyText } : null,
  };
  globalThis.location = { href: "https://example.com/fixture" };

  try {
    return run();
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
    if (hadLocation) globalThis.location = previousLocation;
    else delete globalThis.location;
  }
}

test("normalizes a window without leaking browser-specific fields", () => {
  assert.deepEqual(normalizeWindow({ id: 7, focused: 1, type: "normal", state: "maximized", tabs: [{}, {}] }), {
    windowId: 7,
    focused: true,
    type: "normal",
    state: "maximized",
    tabCount: 2,
  });
});

test("normalizes tab metadata with explicit nulls for absent sensitive fields", () => {
  assert.deepEqual(normalizeTab({ id: 4, windowId: 7, index: 1, active: false, pinned: false, audible: false, discarded: false }), {
    tabId: 4,
    windowId: 7,
    index: 1,
    active: false,
    pinned: false,
    audible: false,
    discarded: false,
    status: "unknown",
    title: null,
    url: null,
  });
});

test("normalizes a tab group without leaking browser-specific fields", () => {
  assert.deepEqual(normalizeTabGroup({ id: 3, windowId: 7, title: "Work", color: "blue", collapsed: 1 }), {
    groupId: 3,
    windowId: 7,
    title: "Work",
    color: "blue",
    collapsed: true,
  });
});

test("normalizes a tab group with absent title/color as explicit nulls", () => {
  assert.deepEqual(normalizeTabGroup({ id: 3, windowId: 7, collapsed: false }), {
    groupId: 3,
    windowId: 7,
    title: null,
    color: null,
    collapsed: false,
  });
});

test("normalizes a history entry, carrying untrusted url/title through as data", () => {
  assert.deepEqual(
    normalizeHistoryEntry({ id: 42, url: "https://example.com", title: "Example", lastVisitTime: 1000, visitCount: 2, typedCount: 1 }),
    { id: "42", url: "https://example.com", title: "Example", lastVisitTime: 1000, visitCount: 2, typedCount: 1 },
  );
});

test("normalizeHistoryEntry defaults absent fields explicitly", () => {
  assert.deepEqual(normalizeHistoryEntry({}), { id: null, url: null, title: null, lastVisitTime: null, visitCount: 0, typedCount: 0 });
});

test("compareHistoryEntries orders by lastVisitTime descending", () => {
  const older = { id: "1", lastVisitTime: 100 };
  const newer = { id: "2", lastVisitTime: 200 };
  assert.ok(compareHistoryEntries(newer, older) < 0);
  assert.ok(compareHistoryEntries(older, newer) > 0);
});

test("compareHistoryEntries tie-breaks entries sharing the exact same lastVisitTime by id", () => {
  const a = { id: "a", lastVisitTime: 100 };
  const b = { id: "b", lastVisitTime: 100 };
  assert.ok(compareHistoryEntries(a, b) < 0);
  assert.ok(compareHistoryEntries(b, a) > 0);
  assert.equal(compareHistoryEntries(a, { id: "a", lastVisitTime: 100 }), 0);

  // A real-world use: sorting is deterministic regardless of input order.
  const entries = [b, a];
  entries.sort(compareHistoryEntries);
  assert.deepEqual(entries.map((entry) => entry.id), ["a", "b"]);
});

test("captureEnvelope carries browser-session identity, source operation, status, and a fresh capture timestamp", () => {
  const before = Date.now();
  const envelope = captureEnvelope("session-1", "browser.list_windows", "ok");
  const after = Date.now();
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.browserSessionId, "session-1");
  assert.equal(envelope.sourceOperation, "browser.list_windows");
  assert.equal(envelope.status, "ok");
  assert.ok(envelope.capturedAt >= before && envelope.capturedAt <= after);
});

test("isValidTimestamp accepts only non-negative finite numbers", () => {
  assert.equal(isValidTimestamp(0), true);
  assert.equal(isValidTimestamp(1_700_000_000_000), true);
  assert.equal(isValidTimestamp(-1), false);
  assert.equal(isValidTimestamp(Infinity), false);
  assert.equal(isValidTimestamp(NaN), false);
  assert.equal(isValidTimestamp("1"), false);
  assert.equal(isValidTimestamp(undefined), false);
});

test("isNonEmptyString accepts only non-empty strings", () => {
  assert.equal(isNonEmptyString("a"), true);
  assert.equal(isNonEmptyString(""), false);
  assert.equal(isNonEmptyString(null), false);
  assert.equal(isNonEmptyString(undefined), false);
  assert.equal(isNonEmptyString(42), false);
});

test("isValidSessionId accepts only non-empty strings", () => {
  assert.equal(isValidSessionId("session-1"), true);
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId(undefined), false);
  assert.equal(isValidSessionId(123), false);
});

test("isValidHandle accepts only non-negative safe integers", () => {
  assert.equal(isValidHandle(0), true);
  assert.equal(isValidHandle(42), true);
  assert.equal(isValidHandle(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isValidHandle(-1), false);
  assert.equal(isValidHandle(1.5), false);
  assert.equal(isValidHandle("4"), false);
  assert.equal(isValidHandle(undefined), false);
  assert.equal(isValidHandle(2 ** 53), false);
});

test("requestError carries a stable code and optional diagnostic detail", () => {
  assert.deepEqual(requestError(ERROR_CODES.INVALID_PARAMS), {
    status: "error",
    code: "invalid_params",
  });
  assert.deepEqual(requestError(ERROR_CODES.INVALID_PARAMS, "windowId required"), {
    status: "error",
    code: "invalid_params",
    detail: "windowId required",
  });
});

function okWindowsResult(overrides = {}) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: "session-1",
    sourceOperation: "browser.list_windows",
    capturedAt: Date.now(),
    status: "ok",
    windows: [],
    returnedCount: 0,
    totalCount: 0,
    truncated: false,
    ...overrides,
  };
}

test("validateMethodResult accepts a well-formed ok result for the requested method", () => {
  assert.deepEqual(validateMethodResult("browser.list_windows", okWindowsResult()), { valid: true });
});

test("validateMethodResult rejects a legacy (pre-Stage-2) bare array response", () => {
  const result = validateMethodResult("browser.list_windows", [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 0 }]);
  assert.equal(result.valid, false);
  assert.match(result.reason, /not a plain object/);
});

test("validateMethodResult rejects a null or non-object result", () => {
  assert.equal(validateMethodResult("browser.list_windows", null).valid, false);
  assert.equal(validateMethodResult("browser.list_windows", "ok").valid, false);
  assert.equal(validateMethodResult("browser.list_windows", 42).valid, false);
  assert.equal(validateMethodResult("browser.list_windows", undefined).valid, false);
});

test("validateMethodResult rejects a result with the wrong schemaVersion", () => {
  const result = validateMethodResult("browser.list_windows", okWindowsResult({ schemaVersion: 999 }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /schemaVersion/);
});

test("validateMethodResult rejects a missing or empty browserSessionId", () => {
  assert.equal(validateMethodResult("browser.list_windows", okWindowsResult({ browserSessionId: "" })).valid, false);
  assert.equal(validateMethodResult("browser.list_windows", okWindowsResult({ browserSessionId: undefined })).valid, false);
});

test("validateMethodResult rejects a result whose sourceOperation does not exactly match the requested method", () => {
  const result = validateMethodResult("browser.list_windows", okWindowsResult({ sourceOperation: "browser.list_tabs" }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /sourceOperation/);
});

test("validateMethodResult rejects a non-finite capturedAt", () => {
  assert.equal(validateMethodResult("browser.list_windows", okWindowsResult({ capturedAt: NaN })).valid, false);
  assert.equal(validateMethodResult("browser.list_windows", okWindowsResult({ capturedAt: Infinity })).valid, false);
  assert.equal(validateMethodResult("browser.list_windows", okWindowsResult({ capturedAt: "now" })).valid, false);
});

test("validateMethodResult rejects a status outside the allowed set", () => {
  const result = validateMethodResult("browser.list_windows", okWindowsResult({ status: "weird" }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /status must be one of/);
});

test("validateMethodResult accepts every allowed status with a non-empty code (except ok)", () => {
  for (const status of ALLOWED_RESULT_STATUSES) {
    if (status === "ok") continue;
    const result = validateMethodResult(
      "browser.list_windows",
      okWindowsResult({ status, code: "some_code", windows: undefined, returnedCount: undefined, totalCount: undefined, truncated: undefined }),
    );
    assert.equal(result.valid, true, `status "${status}" with a code should validate`);
  }
});

test("validateMethodResult rejects a non-ok status missing its code", () => {
  const result = validateMethodResult("browser.list_windows", okWindowsResult({ status: "error", code: undefined }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /code/);
});

test("validateMethodResult rejects an ok result missing method-specific fields", () => {
  const result = validateMethodResult("browser.list_windows", okWindowsResult({ windows: undefined }));
  assert.equal(result.valid, false);
  assert.match(result.reason, /missing required fields/);
});

test("validateMethodResult rejects a window list containing a malformed record", () => {
  const malformed = okWindowsResult({ windows: [{ windowId: 1, focused: "yes", type: "normal", state: "normal", tabCount: 0 }] });
  assert.equal(validateMethodResult("browser.list_windows", malformed).valid, false);
});

test("validateMethodResult rejects a returnedCount that does not match the actual array length", () => {
  const mismatched = okWindowsResult({
    windows: [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 0 }],
    returnedCount: 2,
  });
  assert.equal(validateMethodResult("browser.list_windows", mismatched).valid, false);
});

test("validateMethodResult rejects a totalCount smaller than returnedCount", () => {
  const impossible = okWindowsResult({
    windows: [{ windowId: 1, focused: true, type: "normal", state: "normal", tabCount: 0 }],
    returnedCount: 1,
    totalCount: 0,
  });
  assert.equal(validateMethodResult("browser.list_windows", impossible).valid, false);
});

test("validateMethodResult rejects a negative capturedAt", () => {
  assert.equal(validateMethodResult("browser.list_windows", okWindowsResult({ capturedAt: -1 })).valid, false);
});

test("validateMethodResult checks list_tabs-specific fields, including each tab record's own shape", () => {
  const ok = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: "s",
    sourceOperation: "browser.list_tabs",
    capturedAt: Date.now(),
    status: "ok",
    windowId: 1,
    tabs: [
      {
        tabId: 5,
        windowId: 1,
        index: 0,
        active: true,
        pinned: false,
        audible: false,
        discarded: false,
        status: "complete",
        title: null,
        url: null,
      },
    ],
    returnedCount: 1,
    totalCount: 1,
    truncated: false,
  };
  assert.equal(validateMethodResult("browser.list_tabs", ok).valid, true);
  assert.equal(validateMethodResult("browser.list_tabs", { ...ok, windowId: "not-a-handle" }).valid, false);
  assert.equal(validateMethodResult("browser.list_tabs", { ...ok, tabs: "not-an-array" }).valid, false);
  assert.equal(
    validateMethodResult("browser.list_tabs", { ...ok, tabs: [{ ...ok.tabs[0], active: "yes" }] }).valid,
    false,
    "a malformed nested tab record must be rejected, not merely 'it is an array'",
  );
  assert.equal(
    validateMethodResult("browser.list_tabs", { ...ok, returnedCount: 2 }).valid,
    false,
    "returnedCount must equal the actual tabs array length",
  );
  assert.equal(
    validateMethodResult("browser.list_tabs", { ...ok, totalCount: 0 }).valid,
    false,
    "totalCount must never be smaller than returnedCount",
  );
});

test("validateMethodResult checks read_tab-specific fields", () => {
  const ok = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: "s",
    sourceOperation: "browser.read_tab",
    capturedAt: Date.now(),
    status: "ok",
    tabId: 1,
    windowId: 2,
    url: "https://example.com",
    title: "T",
    documentReadyState: "complete",
    text: "hi",
    characterCount: 2,
    returnedCharacterCount: 2,
    truncated: false,
  };
  assert.equal(validateMethodResult("browser.read_tab", ok).valid, true);
  assert.equal(validateMethodResult("browser.read_tab", { ...ok, text: 123 }).valid, false);
  assert.equal(validateMethodResult("browser.read_tab", { ...ok, characterCount: "2" }).valid, false);
  assert.equal(validateMethodResult("browser.read_tab", { ...ok, returnedCharacterCount: undefined }).valid, false);
  assert.equal(validateMethodResult("browser.read_tab", { ...ok, url: null, title: null }).valid, true, "url/title are nullable strings");
  assert.equal(
    validateMethodResult("browser.read_tab", { ...ok, returnedCharacterCount: 1 }).valid,
    false,
    "returnedCharacterCount must exactly equal text.length",
  );
  assert.equal(
    validateMethodResult("browser.read_tab", { ...ok, characterCount: 1 }).valid,
    false,
    "characterCount can never be smaller than returnedCharacterCount",
  );
  assert.equal(
    validateMethodResult("browser.read_tab", { ...ok, truncated: true }).valid,
    false,
    "truncated must not claim true when characterCount === returnedCharacterCount",
  );
  assert.equal(
    validateMethodResult("browser.read_tab", { ...ok, characterCount: 20, truncated: false }).valid,
    false,
    "truncated must not claim false when characterCount exceeds returnedCharacterCount",
  );
  assert.equal(
    validateMethodResult("browser.read_tab", { ...ok, characterCount: 20, truncated: true }).valid,
    true,
    "truncated: true is consistent once characterCount exceeds returnedCharacterCount",
  );
});

test("validateMethodResult checks query_history-specific fields, including a null or numeric nextCursor", () => {
  const ok = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: "s",
    sourceOperation: "browser.query_history",
    capturedAt: Date.now(),
    status: "ok",
    startTime: 0,
    endTime: 1000,
    entries: [],
    returnedCount: 0,
    truncated: false,
    nextCursor: null,
  };
  assert.equal(validateMethodResult("browser.query_history", ok).valid, true);
  assert.equal(validateMethodResult("browser.query_history", { ...ok, nextCursor: 20 }).valid, true);
  assert.equal(validateMethodResult("browser.query_history", { ...ok, nextCursor: -1 }).valid, false);
  assert.equal(validateMethodResult("browser.query_history", { ...ok, nextCursor: "20" }).valid, false);
  assert.equal(validateMethodResult("browser.query_history", { ...ok, entries: {} }).valid, false);
  assert.equal(
    validateMethodResult("browser.query_history", { ...ok, startTime: 2000, endTime: 1000 }).valid,
    false,
    "startTime must not exceed endTime",
  );
  assert.equal(validateMethodResult("browser.query_history", { ...ok, startTime: -1 }).valid, false);
  assert.equal(
    validateMethodResult("browser.query_history", { ...ok, returnedCount: 1 }).valid,
    false,
    "returnedCount must equal the actual entries array length",
  );

  const withEntry = {
    ...ok,
    entries: [{ id: "1", url: "https://example.com", title: null, lastVisitTime: 100, visitCount: 1, typedCount: 0 }],
    returnedCount: 1,
  };
  assert.equal(validateMethodResult("browser.query_history", withEntry).valid, true);
  assert.equal(
    validateMethodResult("browser.query_history", { ...withEntry, entries: [{ ...withEntry.entries[0], visitCount: -1 }] }).valid,
    false,
    "a malformed nested history entry must be rejected",
  );
});

test("validateMethodResult checks get_capabilities-specific fields", () => {
  const ok = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: "s",
    sourceOperation: "browser.get_capabilities",
    capturedAt: Date.now(),
    status: "ok",
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
  assert.equal(validateMethodResult("browser.get_capabilities", ok).valid, true);
  assert.equal(validateMethodResult("browser.get_capabilities", { ...ok, tabGroups: "yes" }).valid, false);
  assert.equal(
    validateMethodResult("browser.get_capabilities", { ...ok, protocolVersion: PROTOCOL_VERSION + 1 }).valid,
    false,
    "protocolVersion must match this service's own PROTOCOL_VERSION",
  );
  assert.equal(validateMethodResult("browser.get_capabilities", { ...ok, maxTextCharacters: 0 }).valid, false);
  assert.equal(validateMethodResult("browser.get_capabilities", { ...ok, maxHistoryResults: -1 }).valid, false);
});

// --- Phase 2 Action 1: browser.open_tab -----------------------------------

test("the protocol version was bumped for the first mutating method", () => {
  assert.equal(PROTOCOL_VERSION, 3);
});

test("normalizeOpenUrl accepts absolute http(s) URLs and returns the WHATWG-normalized form", () => {
  assert.deepEqual(normalizeOpenUrl("https://example.com"), { valid: true, url: "https://example.com/" });
  assert.deepEqual(normalizeOpenUrl("HTTP://Example.COM:80/a/../b?q=1#frag"), { valid: true, url: "http://example.com/b?q=1#frag" });
  assert.deepEqual(normalizeOpenUrl("https://example.com/a b".replace(" ", "%20")), { valid: true, url: "https://example.com/a%20b" });
  assert.equal(normalizeOpenUrl("https://münchen.example/").url, "https://xn--mnchen-3ya.example/");
});

test("normalizeOpenUrl is idempotent: a normalized URL normalizes to itself", () => {
  const first = normalizeOpenUrl("HTTPS://Example.com:443/a/./b?x=1");
  assert.equal(normalizeOpenUrl(first.url).url, first.url);
});

test("normalizeOpenUrl rejects every non-http(s) scheme", () => {
  for (const url of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "chrome://settings",
    "chrome-extension://abc/page.html",
    "about:blank",
    "ftp://example.com/",
    "blob:https://example.com/uuid",
    "view-source:https://example.com/",
    "ws://example.com/",
  ]) {
    assert.equal(normalizeOpenUrl(url).valid, false, `${url} must be rejected`);
  }
});

test("normalizeOpenUrl rejects relative, scheme-relative, and scheme-less input", () => {
  for (const url of ["example.com", "/path", "//example.com/", "http:example.com", "https:/example.com", "http:\\\\example.com", "?q=1"]) {
    assert.equal(normalizeOpenUrl(url).valid, false, `${JSON.stringify(url)} must be rejected`);
  }
});

test("normalizeOpenUrl rejects embedded credentials", () => {
  for (const url of ["https://user@example.com/", "https://user:pass@example.com/", "http://:pass@example.com/"]) {
    const result = normalizeOpenUrl(url);
    assert.equal(result.valid, false, `${url} must be rejected`);
    assert.match(result.reason, /credentials/);
  }
});

test("normalizeOpenUrl rejects whitespace and control characters rather than letting the parser strip them", () => {
  for (const url of [" https://example.com/", "https://example.com/ ", "https://exa mple.com/", "https://example.com/\n", "https://example.com/\tx", "https://example.com/\u0000", "https://example.com/\u007f", "https://example.com/\u0085"]) {
    assert.equal(normalizeOpenUrl(url).valid, false, `${JSON.stringify(url)} must be rejected`);
  }
});

test("normalizeOpenUrl rejects non-strings, empty input, and an empty host", () => {
  for (const value of [undefined, null, 5, {}, [], true, "", "https://", "https://:443/"]) {
    assert.equal(normalizeOpenUrl(value).valid, false, `${JSON.stringify(value)} must be rejected`);
  }
});

test("normalizeOpenUrl bounds the URL both before and after normalization", () => {
  const prefix = "https://example.com/";
  const atLimit = prefix + "a".repeat(MAX_OPEN_URL_LENGTH - prefix.length);
  assert.equal(normalizeOpenUrl(atLimit).valid, true);
  assert.equal(normalizeOpenUrl(atLimit + "a").valid, false, "raw input over the bound is rejected");
  // Percent-encoding can grow a URL: this is within the bound as typed and over it once normalized.
  const grows = prefix + "é".repeat(Math.floor((MAX_OPEN_URL_LENGTH - prefix.length) / 2));
  assert.ok(grows.length <= MAX_OPEN_URL_LENGTH);
  assert.equal(normalizeOpenUrl(grows).valid, false, "normalized length over the bound is rejected");
});

function openTabTab(overrides = {}) {
  return { tabId: 12, windowId: 3, index: 4, active: true, pinned: false, audible: false, discarded: false, status: "loading", title: null, url: null, ...overrides };
}

function openTabResult(overrides = {}) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: "s",
    sourceOperation: "browser.open_tab",
    capturedAt: Date.now(),
    status: "ok",
    created: true,
    requestedUrl: "https://example.com/",
    tab: openTabTab(),
    pendingUrl: "https://example.com/",
    ...overrides,
  };
}

test("validateMethodResult accepts a fully observed browser.open_tab result and checks its fields", () => {
  assert.equal(validateMethodResult("browser.open_tab", openTabResult()).valid, true);
  assert.equal(validateMethodResult("browser.open_tab", openTabResult({ pendingUrl: null })).valid, true);
  assert.equal(validateMethodResult("browser.open_tab", openTabResult({ created: false })).valid, false, "an ok result must say a tab was created");
  assert.equal(validateMethodResult("browser.open_tab", openTabResult({ created: undefined })).valid, false);
  assert.equal(validateMethodResult("browser.open_tab", openTabResult({ requestedUrl: "" })).valid, false);
  assert.equal(validateMethodResult("browser.open_tab", openTabResult({ tab: undefined })).valid, false);
  assert.equal(validateMethodResult("browser.open_tab", openTabResult({ tab: openTabTab({ tabId: -1 }) })).valid, false);
  assert.equal(validateMethodResult("browser.open_tab", openTabResult({ tab: openTabTab({ active: "yes" }) })).valid, false);
  assert.equal(validateMethodResult("browser.open_tab", openTabResult({ pendingUrl: 5 })).valid, false);
});

test("validateMethodResult requires every non-ok browser.open_tab result to state consistently whether a tab was created", () => {
  const refusal = { ...openTabResult({ status: "error", code: "stale_session", created: false }), tab: undefined, requestedUrl: undefined, pendingUrl: undefined };
  assert.equal(validateMethodResult("browser.open_tab", refusal).valid, true);
  assert.equal(validateMethodResult("browser.open_tab", { ...refusal, created: undefined }).valid, false, "a legacy peer's bare error has no created flag");
  assert.equal(validateMethodResult("browser.open_tab", { ...refusal, created: true }).valid, false, "an error claiming a tab was created, other than the partial outcome, is invalid");
  assert.equal(validateMethodResult("browser.open_tab", { ...refusal, created: "no" }).valid, false);
  assert.equal(validateMethodResult("browser.open_tab", { ...refusal, status: "incomplete" }).valid, false, "incomplete always means a tab was created");

  const partial = { ...refusal, status: "incomplete", code: ERROR_CODES.OBSERVE_FAILED, created: true, tabId: 12, windowId: 3 };
  assert.equal(validateMethodResult("browser.open_tab", partial).valid, true);
  assert.equal(validateMethodResult("browser.open_tab", { ...partial, tabId: null, windowId: null }).valid, true, "tabs.create may return no usable handles");
  assert.equal(validateMethodResult("browser.open_tab", { ...partial, tabId: "12" }).valid, false);
  assert.equal(validateMethodResult("browser.open_tab", { ...partial, tabId: undefined }).valid, false);
  assert.equal(validateMethodResult("browser.open_tab", { ...partial, code: "something_else" }).valid, false, "only observe_failed is the partial outcome");
  assert.equal(validateMethodResult("browser.open_tab", { ...partial, status: "error" }).valid, false, "a created tab is never an ordinary error");
});

test("validateMethodResult never lets another method's non-ok result be held to the open_tab created rule", () => {
  const readFailure = { schemaVersion: RESULT_SCHEMA_VERSION, browserSessionId: "s", sourceOperation: "browser.read_tab", capturedAt: 1, status: "error", code: "stale_handle" };
  assert.equal(validateMethodResult("browser.read_tab", readFailure).valid, true);
});

test("validateMethodResult never crashes or false-rejects for a method name that collides with an Object.prototype member", () => {
  // Confirms the per-method shape lookup uses Object.hasOwn (not `in` or a
  // bare property access), so a method name like "toString" or "__proto__"
  // — which would otherwise resolve to an inherited Object.prototype value
  // instead of `undefined` — is never mistaken for a registered validator.
  // There is no such registered browser.* method in practice (server.mjs's
  // route table is a fixed allowlist), but this function must not crash
  // either way.
  for (const method of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
    const result = okWindowsResult({ sourceOperation: method });
    assert.doesNotThrow(() => validateMethodResult(method, result));
    assert.equal(validateMethodResult(method, result).valid, true);
  }
});

test("pageTextSnapshot returns an ok snapshot with title, url, and readiness", () => {
  const result = withDom("hello world", {}, () => pageTextSnapshot(MAX_TEXT_CHARACTERS));
  assert.deepEqual(result, {
    status: "ok",
    title: "Fixture",
    url: "https://example.com/fixture",
    text: "hello world",
    characterCount: 11,
    truncated: false,
    documentReadyState: "complete",
  });
});

test("pageTextSnapshot reports not_ready when the document has no body", () => {
  const result = withDom("", { hasBody: false }, () =>
    pageTextSnapshot(MAX_TEXT_CHARACTERS, ERROR_CODES.DOCUMENT_HAS_NO_BODY),
  );
  assert.deepEqual(result, { status: "not_ready", code: ERROR_CODES.DOCUMENT_HAS_NO_BODY });
});

test("pageTextSnapshot falls back to the literal document_has_no_body code if none is passed", () => {
  const result = withDom("", { hasBody: false }, () => pageTextSnapshot(MAX_TEXT_CHARACTERS));
  assert.deepEqual(result, { status: "not_ready", code: "document_has_no_body" });
});

test("pageTextSnapshot normalizes CRLF line endings to LF", () => {
  const result = withDom("line one\r\nline two\r\n", {}, () => pageTextSnapshot(MAX_TEXT_CHARACTERS));
  assert.equal(result.text, "line one\nline two\n");
  assert.equal(result.characterCount, result.text.length);
});

test("pageTextSnapshot reports the full character count even when truncated", () => {
  const result = withDom("a".repeat(10), {}, () => pageTextSnapshot(5));
  assert.equal(result.characterCount, 10);
  assert.equal(result.text.length, 5);
  assert.equal(result.truncated, true);
});

test("pageTextSnapshot truncates text at the configured limit", () => {
  const result = withDom("0123456789", {}, () => pageTextSnapshot(4));
  assert.equal(result.text, "0123");
  assert.equal(result.truncated, true);
  assert.equal(result.characterCount, 10);
});

test("pageTextSnapshot does not truncate text at or under the configured limit", () => {
  const result = withDom("0123456789", {}, () => pageTextSnapshot(10));
  assert.equal(result.text, "0123456789");
  assert.equal(result.truncated, false);
  assert.equal(result.characterCount, 10);
});
