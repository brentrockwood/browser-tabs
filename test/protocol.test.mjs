import assert from "node:assert/strict";
import test from "node:test";

import {
  ERROR_CODES,
  MAX_TEXT_CHARACTERS,
  isValidHandle,
  normalizeTab,
  normalizeWindow,
  pageTextSnapshot,
  requestError,
  unsupportedSnapshot,
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

test("represents unavailable content as an explicit unsupported result with diagnostic detail", () => {
  assert.deepEqual(unsupportedSnapshot(9, "injection_rejected", "Cannot access contents"), {
    schemaVersion: 1,
    tabId: 9,
    status: "unsupported",
    code: "injection_rejected",
    detail: "Cannot access contents",
  });
});

test("unsupportedSnapshot omits detail when none is given", () => {
  assert.deepEqual(unsupportedSnapshot(9, "no_injection_result"), {
    schemaVersion: 1,
    tabId: 9,
    status: "unsupported",
    code: "no_injection_result",
  });
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
