import {
  DEFAULT_HISTORY_MAX_RESULTS,
  ERROR_CODES,
  MAX_HISTORY_RESULTS,
  MAX_HISTORY_SCAN,
  MAX_TAB_GROUPS_RETURNED,
  MAX_TABS_RETURNED,
  MAX_TEXT_CHARACTERS,
  MAX_WINDOWS_RETURNED,
  PROTOCOL_VERSION,
  captureEnvelope,
  compareHistoryEntries,
  isValidHandle,
  isValidSessionId,
  isValidTabRecord,
  isValidTimestamp,
  normalizeHistoryEntry,
  normalizeOpenUrl,
  normalizeTab,
  normalizeTabGroup,
  normalizeWindow,
  pageTextSnapshot,
  requestError,
} from "./protocol.js";
import { createServiceClient } from "./service-client.js";

const browserApi = globalThis.browser ?? globalThis.chrome;

function generateSessionId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  // Fallback for test/runtime environments without the Web Crypto API.
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Identifies this browser session (project.md protocol rules: every browser
// record carries a browser-session identifier), persisted across Manifest V3
// service-worker eviction via `chrome.storage.session` — in-memory storage
// the browser itself clears on a full browser restart, which is exactly the
// "rotate on browser restart" behavior wanted here: no separate rotation
// logic is needed, because the storage backing it is already scoped to one
// browser session.
//
// Falls back to a per-worker-load, non-persisted id when `storage.session`
// is unavailable (e.g. this module's own unit tests, or a future runtime
// without session storage). That fallback is safe but weaker: such a
// worker's id may also appear to rotate on mere worker eviction, not only a
// full browser restart — any caller holding a handle across that eviction
// simply gets an explicit `stale_session` rejection and must refetch, the
// same outcome as a genuine restart, never a silent misattribution.
async function getOrCreateSessionId() {
  const sessionStorage = browserApi.storage?.session;
  if (sessionStorage) {
    try {
      const stored = await sessionStorage.get(["browserSessionId"]);
      if (typeof stored.browserSessionId === "string" && stored.browserSessionId.length > 0) {
        return stored.browserSessionId;
      }
      const fresh = generateSessionId();
      await sessionStorage.set({ browserSessionId: fresh });
      return fresh;
    } catch {
      // Fall through to the ephemeral fallback below.
    }
  }
  return generateSessionId();
}

// Deliberately NOT awaited at module top level: Manifest V3 requires a
// service worker's event listeners (runtime.onMessage.addListener below,
// the alarms/storage listeners further down) to be registered during the
// first, synchronous turn of module evaluation, or Chrome may never
// recognize the worker as ready (observed as "could not locate the
// extension's service worker" in both smoke tests after this module grew a
// top-level `await getOrCreateSessionId()`). `browserSessionId` therefore
// starts `null` and is filled in once `sessionReady` resolves; every
// exported browser operation below awaits `sessionReady` as its first
// statement, before any envelope/checkSession use, instead of the module
// doing so at the top level.
let browserSessionId = null;
const sessionReady = getOrCreateSessionId().then((id) => {
  browserSessionId = id;
});

function envelope(sourceOperation, status) {
  return captureEnvelope(browserSessionId, sourceOperation, status);
}

function errMsg(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorResult(sourceOperation, code, detail) {
  return { ...envelope(sourceOperation, "error"), ...requestError(code, detail) };
}

// Every handle-consuming method (list_tabs, list_tab_groups, read_tab) must
// reject a missing or mismatched caller-supplied browserSessionId as a
// stale session *before* resolving any numeric window/tab handle — a stale
// or absent session is never silently retargeted at whatever the current
// session's handles happen to mean.
function checkSession(op, callerSessionId) {
  if (!isValidSessionId(callerSessionId) || callerSessionId !== browserSessionId) {
    return errorResult(op, ERROR_CODES.STALE_SESSION, "browserSessionId is missing or does not match the current browser session");
  }
  return null;
}

// Confirms a window handle still resolves before trusting it for a listing
// or capability query. Window/tab IDs are session-scoped handles (project.md
// protocol rules), never array positions or durable identities: a stale one
// must be rejected explicitly, not silently retargeted at whatever a
// looser query (e.g. tabs.query({windowId})) happens to match.
async function assertWindowExists(windowId) {
  await browserApi.windows.get(windowId);
}

export async function listWindows() {
  await sessionReady;
  const op = "browser.list_windows";
  try {
    const all = await browserApi.windows.getAll({ populate: true });
    const truncated = all.length > MAX_WINDOWS_RETURNED;
    const windows = all.slice(0, MAX_WINDOWS_RETURNED).map(normalizeWindow);
    return {
      ...envelope(op, "ok"),
      windows,
      returnedCount: windows.length,
      totalCount: all.length,
      truncated,
    };
  } catch (error) {
    return errorResult(op, ERROR_CODES.LISTING_FAILED, errMsg(error));
  }
}

export async function listTabs(windowId, callerSessionId) {
  await sessionReady;
  const op = "browser.list_tabs";
  const sessionError = checkSession(op, callerSessionId);
  if (sessionError) return sessionError;

  if (!isValidHandle(windowId)) {
    return errorResult(op, ERROR_CODES.INVALID_PARAMS, "windowId must be a non-negative safe integer");
  }

  try {
    await assertWindowExists(windowId);
  } catch (error) {
    return errorResult(op, ERROR_CODES.STALE_HANDLE, errMsg(error));
  }

  try {
    const all = await browserApi.tabs.query({ windowId });
    const truncated = all.length > MAX_TABS_RETURNED;
    const tabs = all.slice(0, MAX_TABS_RETURNED).map(normalizeTab);
    return {
      ...envelope(op, "ok"),
      windowId,
      tabs,
      returnedCount: tabs.length,
      totalCount: all.length,
      truncated,
    };
  } catch (error) {
    return errorResult(op, ERROR_CODES.LISTING_FAILED, errMsg(error));
  }
}

// Tab groups are not universally supported (a browser's current version may
// lack a tabGroups API entirely — Firefox, as of this writing). The handle
// itself is validated (session, then window existence) *before* the
// capability check below, so a stale/invalid window is never reported as
// merely "unsupported" — a caller can tell apart "your handle is no good"
// from "this browser can't do this" even when both would be true.
export async function listTabGroups(windowId, callerSessionId) {
  await sessionReady;
  const op = "browser.list_tab_groups";
  const sessionError = checkSession(op, callerSessionId);
  if (sessionError) return sessionError;

  if (!isValidHandle(windowId)) {
    return errorResult(op, ERROR_CODES.INVALID_PARAMS, "windowId must be a non-negative safe integer");
  }

  try {
    await assertWindowExists(windowId);
  } catch (error) {
    return errorResult(op, ERROR_CODES.STALE_HANDLE, errMsg(error));
  }

  if (!browserApi.tabGroups) {
    return {
      ...envelope(op, "unsupported"),
      windowId,
      code: ERROR_CODES.UNSUPPORTED_FEATURE,
      detail: "tabGroups API is not available in this browser",
    };
  }

  try {
    const all = await browserApi.tabGroups.query({ windowId });
    const truncated = all.length > MAX_TAB_GROUPS_RETURNED;
    const groups = all.slice(0, MAX_TAB_GROUPS_RETURNED).map(normalizeTabGroup);
    return {
      ...envelope(op, "ok"),
      windowId,
      groups,
      returnedCount: groups.length,
      totalCount: all.length,
      truncated,
    };
  } catch (error) {
    return errorResult(op, ERROR_CODES.TAB_GROUPS_QUERY_FAILED, errMsg(error));
  }
}

// Validates the object returned by the injected pageTextSnapshot function
// (extension/protocol.js) before any of its fields are accessed. That
// function is our own trusted code, but its return value crosses a
// serialization boundary (scripting.executeScript) and must not be assumed
// well-formed — a malformed result must become an explicit error result,
// never an accessed-undefined-field exception that rejects readTab's
// promise (see ERROR_CODES.INVALID_EXTENSION_RESPONSE's doc comment).
function isValidSnapshotResult(result) {
  if (result === null || typeof result !== "object") return false;
  if (result.status === "not_ready") {
    return typeof result.code === "string" && result.code.length > 0;
  }
  if (result.status === "ok") {
    return (
      typeof result.text === "string" &&
      typeof result.url === "string" &&
      typeof result.title === "string" &&
      typeof result.documentReadyState === "string" &&
      Number.isInteger(result.characterCount) &&
      typeof result.truncated === "boolean"
    );
  }
  return false;
}

export async function readTab(tabId, callerSessionId) {
  await sessionReady;
  const op = "browser.read_tab";
  const sessionError = checkSession(op, callerSessionId);
  if (sessionError) return sessionError;

  if (!isValidHandle(tabId)) {
    return errorResult(op, ERROR_CODES.INVALID_PARAMS, "tabId must be a non-negative safe integer");
  }

  // Confirmed to exist before injection is attempted, so a closed tab is
  // rejected explicitly as a stale handle rather than producing whatever
  // ambiguous error scripting.executeScript happens to throw for an ID that
  // no longer resolves to anything.
  let tabInfo;
  try {
    tabInfo = await browserApi.tabs.get(tabId);
  } catch (error) {
    return errorResult(op, ERROR_CODES.STALE_HANDLE, errMsg(error));
  }
  const windowId = tabInfo.windowId;

  // Caught before injection is attempted at all: scripting.executeScript on
  // a tab still mid-navigation can block for the remainder of that
  // navigation (observed hanging a real slow-loading page well past the
  // service's HTTP request timeout) rather than failing fast. tabs.get's
  // own `status` already tells us this without needing to inject anything.
  if (tabInfo.status === "loading") {
    return { ...envelope(op, "not_ready"), tabId, windowId, code: ERROR_CODES.TAB_LOADING };
  }

  let injections;
  try {
    injections = await browserApi.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: pageTextSnapshot,
      args: [MAX_TEXT_CHARACTERS, ERROR_CODES.DOCUMENT_HAS_NO_BODY],
    });
  } catch (error) {
    return {
      ...envelope(op, "unsupported"),
      tabId,
      windowId,
      code: ERROR_CODES.INJECTION_REJECTED,
      detail: errMsg(error),
    };
  }

  if (!Array.isArray(injections) || injections.length === 0) {
    return { ...envelope(op, "unsupported"), tabId, windowId, code: ERROR_CODES.NO_INJECTION_RESULT };
  }

  const result = injections[0]?.result;
  if (!result) {
    return { ...envelope(op, "unsupported"), tabId, windowId, code: ERROR_CODES.NO_MAIN_FRAME_RESULT };
  }

  if (!isValidSnapshotResult(result)) {
    return {
      ...envelope(op, "error"),
      tabId,
      windowId,
      code: ERROR_CODES.INVALID_EXTENSION_RESPONSE,
      detail: "the injected page-snapshot function returned an unexpected shape",
    };
  }

  if (result.status === "not_ready") {
    return { ...envelope(op, "not_ready"), tabId, windowId, code: result.code };
  }

  return {
    ...envelope(op, "ok"),
    tabId,
    windowId,
    url: result.url,
    title: result.title,
    documentReadyState: result.documentReadyState,
    text: result.text,
    characterCount: result.characterCount,
    returnedCharacterCount: result.text.length,
    truncated: result.truncated,
  };
}

// Queries browsing-history metadata, kept deliberately separate from open
// tabs (project.md Stage 2). startTime/endTime are required so a caller
// always states an explicit range rather than implicitly querying all
// history; maxResults is bounded.
//
// `cursor` is a plain offset into a deterministic sort (compareHistoryEntries
// in extension/protocol.js) of chrome.history.search's own results for
// [startTime, endTime] — not a timestamp.
//
// Every page for a given [startTime, endTime] range re-fetches the *same*
// bounded scan set — up to MAX_HISTORY_SCAN entries, regardless of `offset`
// or `maxResults` — and sorts that whole set deterministically before
// slicing out the requested page. This is deliberate: chrome.history.search
// does not guarantee a stable relative order for entries sharing the exact
// same `lastVisitTime` across *differently-sized* `maxResults` requests (a
// LIMIT-N query's tie-breaking is not guaranteed consistent for different
// N), so an earlier design that requested a page-size-dependent amount
// (`offset + pageSize + 1`) could duplicate or skip tied entries across
// pages. Requesting the identical MAX_HISTORY_SCAN-sized set every time, and
// only ever slicing after sorting that one set, removes that inconsistency
// entirely: the same input always sorts to the same output.
//
// This does not protect against *history changing between two page
// requests* (a new visit recorded, or an existing one re-visited, between
// fetching page 1 and page 2) — that is an inherent limitation of stateless,
// non-transactional pagination over a live, mutable data source, not a bug;
// see README.md's "History pagination" section.
export async function queryHistory({ startTime, endTime, maxResults, cursor } = {}) {
  await sessionReady;
  const op = "browser.query_history";
  if (!browserApi.history) {
    return { ...envelope(op, "unsupported"), code: ERROR_CODES.UNSUPPORTED_FEATURE, detail: "history API is not available in this browser" };
  }

  if (!isValidTimestamp(startTime) || !isValidTimestamp(endTime) || startTime > endTime) {
    return errorResult(
      op,
      ERROR_CODES.INVALID_PARAMS,
      "startTime and endTime are required, must be non-negative numbers (ms since epoch), and startTime must not exceed endTime",
    );
  }

  const pageSize = maxResults === undefined ? DEFAULT_HISTORY_MAX_RESULTS : maxResults;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_RESULTS) {
    return errorResult(op, ERROR_CODES.INVALID_PARAMS, `maxResults must be an integer between 1 and ${MAX_HISTORY_RESULTS}`);
  }

  const offset = cursor === undefined ? 0 : cursor;
  if (!isValidHandle(offset)) {
    return errorResult(op, ERROR_CODES.INVALID_PARAMS, "cursor must be a non-negative safe integer offset");
  }

  if (offset >= MAX_HISTORY_SCAN) {
    return {
      ...envelope(op, "incomplete"),
      code: ERROR_CODES.PAGINATION_LIMIT_REACHED,
      detail: `cursor offset ${offset} is at or beyond the ${MAX_HISTORY_SCAN}-entry scan ceiling for a single query_history page`,
    };
  }

  try {
    const fetched = await browserApi.history.search({ text: "", startTime, endTime, maxResults: MAX_HISTORY_SCAN });
    const sorted = [...fetched].sort(compareHistoryEntries);
    const scannedEverything = sorted.length < MAX_HISTORY_SCAN;

    if (!scannedEverything && offset + pageSize >= sorted.length) {
      // The scan ceiling was reached (the browser had at least
      // MAX_HISTORY_SCAN matching entries), and this page's end touches or
      // exceeds the boundary of what was actually scanned — so neither this
      // page's full content nor whether a further page exists beyond it can
      // be determined reliably. Reported explicitly rather than silently
      // returning a possibly-incomplete "ok" page.
      return {
        ...envelope(op, "incomplete"),
        code: ERROR_CODES.PAGINATION_LIMIT_REACHED,
        detail: `the ${MAX_HISTORY_SCAN}-entry scan ceiling was reached before a complete page at offset ${offset} could be determined`,
      };
    }

    const page = sorted.slice(offset, offset + pageSize);
    const hasMore = sorted.length > offset + pageSize;
    return {
      ...envelope(op, "ok"),
      startTime,
      endTime,
      entries: page.map(normalizeHistoryEntry),
      returnedCount: page.length,
      truncated: hasMore,
      nextCursor: hasMore ? offset + pageSize : null,
    };
  } catch (error) {
    return errorResult(op, ERROR_CODES.HISTORY_QUERY_FAILED, errMsg(error));
  }
}

// Lets a client check what this browser supports before calling a
// capability-dependent method, instead of inferring support from brand name
// (project.md Stage 2).
export async function getCapabilities() {
  await sessionReady;
  const op = "browser.get_capabilities";
  return {
    ...envelope(op, "ok"),
    protocolVersion: PROTOCOL_VERSION,
    tabGroups: Boolean(browserApi.tabGroups),
    history: Boolean(browserApi.history),
    scripting: Boolean(browserApi.scripting),
    maxTextCharacters: MAX_TEXT_CHARACTERS,
    maxWindowsReturned: MAX_WINDOWS_RETURNED,
    maxTabsReturned: MAX_TABS_RETURNED,
    maxTabGroupsReturned: MAX_TAB_GROUPS_RETURNED,
    maxHistoryResults: MAX_HISTORY_RESULTS,
  };
}

// Phase 2 Action 1: opens `url` in one new tab — the extension's only
// browser mutation. The service sends this only after the owner approved a
// stored preview; this function still trusts nothing it was sent:
//
// - `callerSessionId` must be the current browser session, checked here, with
//   no `await` between that check and `tabs.create`, so a preview taken
//   before a browser restart can never open anything (`stale_session`,
//   `created: false`, no mutation).
// - `url` is re-validated with the same rules the preview used and must
//   already be in normalized form, so the tab opened is exactly the URL the
//   owner was shown.
// - `tabs.create` is called at most once and never retried. Its result is
//   not trusted as the outcome: the new tab is re-read with `tabs.get` and
//   that is what is reported. If the create succeeded but the re-read did
//   not, the result is the explicit partial outcome (`incomplete`,
//   `observe_failed`, `created: true`) rather than a failure — retrying would
//   open a second tab.
export async function openTab(url, callerSessionId) {
  await sessionReady;
  const op = "browser.open_tab";
  const refuse = (result) => ({ ...result, created: false });

  const sessionError = checkSession(op, callerSessionId);
  if (sessionError) return refuse(sessionError);

  const checked = normalizeOpenUrl(url);
  if (!checked.valid) return refuse(errorResult(op, ERROR_CODES.INVALID_PARAMS, checked.reason));
  if (checked.url !== url) {
    return refuse(errorResult(op, ERROR_CODES.INVALID_PARAMS, "url must already be in normalized form"));
  }

  let created;
  try {
    created = await browserApi.tabs.create({ url, active: true });
  } catch (error) {
    return refuse(errorResult(op, ERROR_CODES.OPEN_TAB_FAILED, errMsg(error)));
  }

  const tabId = isValidHandle(created?.id) ? created.id : null;
  const windowId = isValidHandle(created?.windowId) ? created.windowId : null;
  const partial = (detail) => ({
    ...envelope(op, "incomplete"),
    code: ERROR_CODES.OBSERVE_FAILED,
    detail,
    created: true,
    tabId,
    windowId,
  });
  if (tabId === null) return partial("tabs.create returned no usable tab id, so the new tab could not be observed");

  let observed;
  try {
    observed = await browserApi.tabs.get(tabId);
  } catch (error) {
    return partial(errMsg(error));
  }
  const tab = normalizeTab(observed ?? {});
  if (tab.tabId !== tabId || !isValidTabRecord(tab)) {
    return partial("tabs.get did not return the tab that was just created");
  }

  return {
    ...envelope(op, "ok"),
    created: true,
    requestedUrl: url,
    tab,
    pendingUrl: typeof observed.pendingUrl === "string" ? observed.pendingUrl : null,
  };
}

// Shared by the extension's own runtime.onMessage listener and by requests
// forwarded over the service WebSocket, so both entry points dispatch
// identically — for read-only methods. Browser mutations are deliberately not
// here: see routeServiceMessage.
export async function routeMessage(message) {
  switch (message?.method) {
    case "browser.list_windows":
      return listWindows();
    case "browser.list_tabs":
      return listTabs(message.windowId, message.browserSessionId);
    case "browser.list_tab_groups":
      return listTabGroups(message.windowId, message.browserSessionId);
    case "browser.read_tab":
      return readTab(message.tabId, message.browserSessionId);
    case "browser.query_history":
      return queryHistory({
        startTime: message.startTime,
        endTime: message.endTime,
        maxResults: message.maxResults,
        cursor: message.cursor,
      });
    case "browser.get_capabilities":
      return getCapabilities();
    default:
      return errorResult(
        typeof message?.method === "string" ? message.method : "unknown",
        ERROR_CODES.UNKNOWN_METHOD,
        message?.method,
      );
  }
}

// The service WebSocket's dispatcher: everything routeMessage handles, plus
// the mutating `browser.open_tab`. Only requests from the authenticated
// service reach it; `runtime.onMessage` below uses the read-only
// routeMessage, so extension pages and other message senders cannot open
// tabs.
export async function routeServiceMessage(message) {
  if (message?.method === "browser.open_tab") return openTab(message.url, message.browserSessionId);
  return routeMessage(message);
}

browserApi.runtime.onMessage.addListener((message) => routeMessage(message));

// Only wired up when the real `storage` permission/API is present (absent
// from the lightweight mocks the unit tests install), so this never opens a
// network connection during `npm test`.
if (browserApi.storage?.local) {
  const serviceClient = createServiceClient({
    storage: browserApi.storage.local,
    routeMessage: routeServiceMessage,
    alarms: browserApi.alarms,
    // Used only if routeMessage itself rejects (a product bug, not an
    // expected outcome) — see service-client.js's catch handler — so that
    // even that failure mode still produces a valid capture-provenance
    // envelope instead of a second, unrelated validation failure masking
    // the original error.
    getBrowserSessionId: () => browserSessionId,
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
  // Diagnostic-only, same rationale as above: lets a smoke test read the
  // current browser-session id directly (e.g. to confirm it rotates across
  // a full browser restart) without depending on a particular API call's
  // result shape.
  globalThis.__browserTabsSessionId = () => browserSessionId;
}
