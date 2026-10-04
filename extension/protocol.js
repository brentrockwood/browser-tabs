export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_TEXT_CHARACTERS = 500_000;

export const ERROR_CODES = Object.freeze({
  INVALID_PARAMS: "invalid_params",
  UNKNOWN_METHOD: "unknown_method",
  LISTING_FAILED: "listing_failed",
  NO_INJECTION_RESULT: "no_injection_result",
  NO_MAIN_FRAME_RESULT: "no_main_frame_result",
  INJECTION_REJECTED: "injection_rejected",
  DOCUMENT_HAS_NO_BODY: "document_has_no_body",
});

export function isValidHandle(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function requestError(code, detail) {
  const error = { status: "error", code };
  if (detail !== undefined) error.detail = detail;
  return error;
}

export function unsupportedSnapshot(tabId, code, detail) {
  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    tabId,
    status: "unsupported",
    code,
  };
  if (detail !== undefined) snapshot.detail = detail;
  return snapshot;
}

export function normalizeWindow(window) {
  return {
    windowId: window.id,
    focused: Boolean(window.focused),
    type: window.type,
    state: window.state,
    tabCount: Array.isArray(window.tabs) ? window.tabs.length : 0,
  };
}

export function normalizeTab(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: Boolean(tab.active),
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
    discarded: Boolean(tab.discarded),
    status: tab.status ?? "unknown",
    title: tab.title ?? null,
    url: tab.url ?? null,
  };
}

// Runs inside the target tab via scripting.executeScript. The browser
// serializes this function body alone, so it cannot close over module
// lexical scope (e.g. MAX_TEXT_CHARACTERS or ERROR_CODES) — values must
// arrive as arguments. The default parameter below is literal syntax
// baked into the serialized function source, not a closure, so it is safe;
// callers should still pass ERROR_CODES.DOCUMENT_HAS_NO_BODY explicitly to
// keep a single source of truth for the code string.
export function pageTextSnapshot(maxCharacters, documentHasNoBodyCode = "document_has_no_body") {
  const body = document.body;
  if (!body) {
    return { status: "not_ready", code: documentHasNoBodyCode };
  }

  const fullText = body.innerText.replace(/\r\n/g, "\n");
  const truncated = fullText.length > maxCharacters;
  const text = fullText.slice(0, maxCharacters);
  return {
    status: "ok",
    title: document.title,
    url: location.href,
    text,
    characterCount: fullText.length,
    truncated,
    documentReadyState: document.readyState,
  };
}
