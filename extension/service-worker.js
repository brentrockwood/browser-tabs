import {
  ERROR_CODES,
  MAX_TEXT_CHARACTERS,
  SNAPSHOT_SCHEMA_VERSION,
  isValidHandle,
  normalizeTab,
  normalizeWindow,
  pageTextSnapshot,
  requestError,
  unsupportedSnapshot,
} from "./protocol.js";

const browserApi = globalThis.browser ?? globalThis.chrome;

export async function listWindows() {
  try {
    const windows = await browserApi.windows.getAll({ populate: true });
    return windows.map(normalizeWindow);
  } catch (error) {
    return requestError(ERROR_CODES.LISTING_FAILED, error instanceof Error ? error.message : String(error));
  }
}

export async function listTabs(windowId) {
  if (!isValidHandle(windowId)) {
    return requestError(ERROR_CODES.INVALID_PARAMS, "windowId must be a non-negative safe integer");
  }

  try {
    const tabs = await browserApi.tabs.query({ windowId });
    return tabs.map(normalizeTab);
  } catch (error) {
    return requestError(ERROR_CODES.LISTING_FAILED, error instanceof Error ? error.message : String(error));
  }
}

export async function readTab(tabId) {
  if (!isValidHandle(tabId)) {
    return requestError(ERROR_CODES.INVALID_PARAMS, "tabId must be a non-negative safe integer");
  }

  let injections;
  try {
    injections = await browserApi.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: pageTextSnapshot,
      args: [MAX_TEXT_CHARACTERS, ERROR_CODES.DOCUMENT_HAS_NO_BODY],
    });
  } catch (error) {
    return unsupportedSnapshot(
      tabId,
      ERROR_CODES.INJECTION_REJECTED,
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!Array.isArray(injections) || injections.length === 0) {
    return unsupportedSnapshot(tabId, ERROR_CODES.NO_INJECTION_RESULT);
  }

  const result = injections[0]?.result;
  if (!result) {
    return unsupportedSnapshot(tabId, ERROR_CODES.NO_MAIN_FRAME_RESULT);
  }

  // `result` was produced by code running in the page's world; a page can
  // never be trusted to not shadow fields. Spread it first so the trusted
  // envelope fields always win, even if `result` happens to contain keys
  // named `schemaVersion` or `tabId`.
  return { ...result, schemaVersion: SNAPSHOT_SCHEMA_VERSION, tabId };
}

browserApi.runtime.onMessage.addListener((message) => {
  switch (message?.method) {
    case "browser.list_windows":
      return listWindows();
    case "browser.list_tabs":
      return listTabs(message.windowId);
    case "browser.read_tab":
      return readTab(message.tabId);
    default:
      return Promise.resolve(requestError(ERROR_CODES.UNKNOWN_METHOD, message?.method));
  }
});
