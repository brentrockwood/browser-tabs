import {
  SNAPSHOT_SCHEMA_VERSION,
  normalizeTab,
  normalizeWindow,
  pageTextSnapshot,
  unsupportedSnapshot,
} from "./protocol.js";

const browserApi = globalThis.browser ?? globalThis.chrome;

export async function listWindows() {
  const windows = await browserApi.windows.getAll({ populate: true });
  return windows.map(normalizeWindow);
}

export async function listTabs(windowId) {
  const tabs = await browserApi.tabs.query({ windowId });
  return tabs.map(normalizeTab);
}

export async function readTab(tabId) {
  try {
    const injections = await browserApi.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: pageTextSnapshot,
    });
    const result = injections[0]?.result;
    if (!result) return unsupportedSnapshot(tabId, "no_main_frame_result");

    return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, tabId, ...result };
  } catch (error) {
    return unsupportedSnapshot(tabId, error instanceof Error ? error.message : String(error));
  }
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
      return Promise.reject(new Error("unknown_method"));
  }
});
