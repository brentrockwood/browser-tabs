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
import { createServiceClient } from "./service-client.js";

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

// Shared by the extension's own runtime.onMessage listener and by requests
// forwarded over the service WebSocket, so both entry points dispatch
// identically.
export async function routeMessage(message) {
  switch (message?.method) {
    case "browser.list_windows":
      return listWindows();
    case "browser.list_tabs":
      return listTabs(message.windowId);
    case "browser.read_tab":
      return readTab(message.tabId);
    default:
      return requestError(ERROR_CODES.UNKNOWN_METHOD, message?.method);
  }
}

browserApi.runtime.onMessage.addListener((message) => routeMessage(message));

// Only wired up when the real `storage` permission/API is present (absent
// from the lightweight mocks the unit tests install), so this never opens a
// network connection during `npm test`.
if (browserApi.storage?.local) {
  const serviceClient = createServiceClient({
    storage: browserApi.storage.local,
    routeMessage,
    alarms: browserApi.alarms,
  });
  serviceClient.start();
  browserApi.storage.onChanged?.addListener((changes, areaName) =>
    serviceClient.onStorageChanged(changes, areaName),
  );
  // Must be registered at the top level (not inside an async callback or
  // conditional reached only after some other event): Chrome only wakes a
  // terminated Manifest V3 service worker to deliver an alarm if a
  // `chrome.alarms.onAlarm` listener was added unconditionally while the
  // worker's script last ran. A `setTimeout`-based retry cannot survive
  // worker termination at all; this alarm is the platform-native backstop
  // for that case (see RECONNECT_ALARM_NAME in protocol.js).
  browserApi.alarms?.onAlarm.addListener((alarm) => serviceClient.onAlarm(alarm.name));
  // Registers browser startup as a wake event too: the extension is
  // already installed in an existing profile across a browser restart, so
  // `onInstalled` will not fire again, and nothing else would otherwise
  // start this worker until some other event happens to occur. The
  // listener body is intentionally a no-op — reconnecting is simply what
  // this whole module already does unconditionally (via the single
  // `serviceClient` constructed and started once above) whenever the
  // worker's script runs for any reason, so this must never itself call
  // `serviceClient.start()` or construct another client, which would
  // create a second, duplicate connection.
  browserApi.runtime.onStartup?.addListener(() => {});
  // Diagnostic-only: lets a CDP-attached test (test/smoke/stage1-bridge-
  // smoke.mjs) read the client's current connection state (e.g.
  // "not_paired", "connecting", "reconnecting", "connected") when a wait
  // times out, so a failure can be classified instead of only showing a
  // final boolean. Not read by any product code path.
  globalThis.__browserTabsServiceClientState = () => serviceClient.getState();
}
