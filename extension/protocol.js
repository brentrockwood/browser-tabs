export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MAX_TEXT_CHARACTERS = 500_000;

export function unsupportedSnapshot(tabId, reason) {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    tabId,
    status: "unsupported",
    reason,
  };
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

export function pageTextSnapshot() {
  const body = document.body;
  if (!body) {
    return { status: "not_ready", reason: "document_has_no_body" };
  }

  const fullText = body.innerText.replace(/\r\n/g, "\n");
  const truncated = fullText.length > MAX_TEXT_CHARACTERS;
  const text = fullText.slice(0, MAX_TEXT_CHARACTERS);
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
