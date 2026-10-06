import {
  DEFAULT_HISTORY_MAX_RESULTS,
  ERROR_CODES,
  MAX_HISTORY_RESULTS,
  MAX_HISTORY_SCAN,
  MAX_TAB_GROUPS_RETURNED,
  MAX_TABS_RETURNED,
  MAX_TEXT_CHARACTERS,
  MAX_WINDOWS_RETURNED,
  TAB_GROUP_ID_NONE,
  captureEnvelope,
  compareHistoryEntries,
  isValidHandle,
  isValidSessionId,
  isValidTimestamp,
  normalizeCreateTabGroupRequest,
  normalizeHistoryEntry,
  normalizeMoveTabsRequest,
  normalizeTab,
  normalizeTabGroup,
  normalizeUpdateTabGroupRequest,
  normalizeWindow,
  pageTextSnapshot,
  requestError,
  tabGroupMembership,
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

// The tab-group mutations need the `tabGroups` API plus `tabs.group` and
// `tabs.ungroup`, each feature-detected (never inferred from the browser's
// name): a browser without them answers `unsupported` before anything is read
// or changed.
function groupsSupported() {
  return Boolean(browserApi.tabGroups) && typeof browserApi.tabs?.group === "function" && typeof browserApi.tabs?.ungroup === "function";
}

function unsupportedGroups(op) {
  return {
    ...envelope(op, "unsupported"),
    code: ERROR_CODES.UNSUPPORTED_FEATURE,
    detail: "tab groups cannot be created or changed in this browser",
  };
}

// Mutation outcomes, each stating `changed` (see isValidMutationNonOkShape in
// protocol.js): refused before the one mutation call (`false`); that call
// attempted without a usable answer (`null`, unknown — never retried); or the
// call resolved but a follow-up step did not complete (`true`, incomplete).
function refuse(result) {
  return { ...result, changed: false };
}

function unknownChange(op, code, detail) {
  return { ...errorResult(op, code, detail), changed: null };
}

function partial(op, code, detail, { groupId = null, windowId = null, tabIds = null } = {}) {
  return {
    ...envelope(op, "incomplete"),
    code,
    detail,
    changed: true,
    groupId: isValidHandle(groupId) ? groupId : null,
    windowId: isValidHandle(windowId) ? windowId : null,
    tabIds: tabIds !== null && tabIds.length > 0 ? tabIds : null,
  };
}

// Re-reads every selected tab immediately before a mutation and applies the
// rules every mutation shares: each handle still resolves to that tab, all of
// them are in one window, and none is pinned (grouping a pinned tab could
// unpin or reorder it). Returns `{ refusal }` or `{ tabs, windowId }`.
async function readSelectedTabs(op, tabIds) {
  let found;
  try {
    found = await Promise.all(tabIds.map((id) => browserApi.tabs.get(id)));
  } catch (error) {
    return { refusal: refuse(errorResult(op, ERROR_CODES.STALE_HANDLE, errMsg(error))) };
  }
  for (let i = 0; i < tabIds.length; i += 1) {
    if (found[i]?.id !== tabIds[i] || !isValidHandle(found[i].windowId)) {
      return { refusal: refuse(errorResult(op, ERROR_CODES.STALE_HANDLE, "tabs.get did not return a requested tab with its window")) };
    }
  }
  const windowId = found[0].windowId;
  if (found.some((tab) => tab.windowId !== windowId)) {
    return { refusal: refuse(errorResult(op, ERROR_CODES.WINDOW_MISMATCH, "the tabs are not all in one window")) };
  }
  if (found.some((tab) => tab.pinned)) {
    return { refusal: refuse(errorResult(op, ERROR_CODES.PINNED_TAB, "a selected tab is pinned; pinned tabs cannot be grouped or ungrouped")) };
  }
  return { tabs: found, windowId };
}

// Reads one existing group. Returns `{ refusal }` or `{ group }`.
async function readGroup(op, groupId) {
  let found;
  try {
    found = await browserApi.tabGroups.get(groupId);
  } catch (error) {
    return { refusal: refuse(errorResult(op, ERROR_CODES.STALE_HANDLE, errMsg(error))) };
  }
  const group = normalizeTabGroup(found ?? {});
  if (group.groupId !== groupId || !isValidHandle(group.windowId)) {
    return { refusal: refuse(errorResult(op, ERROR_CODES.STALE_HANDLE, "tabGroups.get did not return the requested group")) };
  }
  return { group };
}

function requestedMetadataMissing(group, title, color) {
  return (title !== null && (group.title ?? "") !== title) || (color !== null && group.color !== color);
}

// Reads the selected tabs back after a mutation and keeps, in request order,
// only those observed in `groupId` (TAB_GROUP_ID_NONE for "no group") in
// `windowId`. Throws if the browser cannot be read.
async function observeTabsIn(tabIds, groupId, windowId) {
  const found = await Promise.all(tabIds.map((id) => browserApi.tabs.get(id)));
  const observed = [];
  for (let i = 0; i < tabIds.length; i += 1) {
    const tab = found[i];
    if (tab?.id === tabIds[i] && tab.windowId === windowId && tabGroupMembership(tab) === groupId) {
      observed.push({ tabId: tab.id, windowId: tab.windowId, groupId: tabGroupMembership(tab) });
    }
  }
  return observed;
}

function missingTabDetail(tabIds, observed, place) {
  const missing = tabIds.find((id) => !observed.some((tab) => tab.tabId === id));
  return `tab ${missing} was not observed ${place} after the change`;
}

// The read-back after a call that put `tabIds` into `groupId`: the group and
// every tab as the browser now reports them. Anything less is the explicit
// partial outcome, naming only the tabs actually observed in the group.
async function observeGroupedTabs(op, { groupId, windowId, tabIds, title = null, color = null }) {
  let found;
  let observed;
  try {
    [found, observed] = await Promise.all([browserApi.tabGroups.get(groupId), observeTabsIn(tabIds, groupId, windowId)]);
  } catch (error) {
    return partial(op, ERROR_CODES.OBSERVE_FAILED, errMsg(error), { groupId, windowId });
  }
  const group = normalizeTabGroup(found ?? {});
  if (group.groupId !== groupId || group.windowId !== windowId) {
    return partial(op, ERROR_CODES.OBSERVE_FAILED, "tabGroups.get did not return the group in the tabs' window", { groupId, windowId });
  }
  const observedIds = observed.map((tab) => tab.tabId);
  if (observed.length !== tabIds.length) {
    return partial(op, ERROR_CODES.OBSERVE_FAILED, missingTabDetail(tabIds, observed, "in the group"), { groupId, windowId, tabIds: observedIds });
  }
  if (requestedMetadataMissing(group, title, color)) {
    return partial(op, ERROR_CODES.OBSERVE_FAILED, "the group was not observed with the requested title and color", { groupId, windowId, tabIds: observedIds });
  }
  return { ...envelope(op, "ok"), changed: true, group, tabs: observed };
}

// Every mutation below trusts nothing it was sent, even from the
// authenticated service:
//
// - the browser session must be the current one (`stale_session`), checked
//   before anything else, so a handle from before a browser restart is never
//   retargeted;
// - the request is re-validated with the rules the service used;
// - the relevant current state is re-read immediately before the mutation and
//   must satisfy the method's rules, otherwise the result is a refusal with
//   `changed: false` and nothing is changed;
// - the one mutation call is made at most once and never retried. Its outcome
//   is the browser state read back afterwards, not an echo of the request.
//
// The browser offers no atomic check-and-mutate, so a user action between the
// re-read and the call is not detectable; a call that then fails is reported
// as an unknown outcome (`changed: null`).

// `browser.create_tab_group`: one `tabs.group` call creating a group around
// all the selected tabs in their window, then at most one `tabGroups.update`
// for the requested title/color.
export async function createTabGroup(params) {
  await sessionReady;
  const op = "browser.create_tab_group";
  const sessionError = checkSession(op, params?.browserSessionId);
  if (sessionError) return refuse(sessionError);
  const checked = normalizeCreateTabGroupRequest(params);
  if (!checked.valid) return refuse(errorResult(op, ERROR_CODES.INVALID_PARAMS, checked.reason));
  if (!groupsSupported()) return refuse(unsupportedGroups(op));
  const { tabIds, title, color } = checked.request;

  const selected = await readSelectedTabs(op, tabIds);
  if (selected.refusal) return selected.refusal;
  const { windowId } = selected;

  let groupId;
  try {
    // The window is stated explicitly: without it a browser may place the new
    // group in its current window, moving the tabs out of theirs.
    groupId = await browserApi.tabs.group({ tabIds, createProperties: { windowId } });
  } catch (error) {
    return unknownChange(op, ERROR_CODES.GROUP_FAILED, errMsg(error));
  }
  if (!isValidHandle(groupId)) {
    return unknownChange(op, ERROR_CODES.OBSERVE_FAILED, "tabs.group returned no usable group id, so whether it changed anything is unknown");
  }

  const props = {};
  if (title !== null) props.title = title;
  if (color !== null) props.color = color;
  if (Object.keys(props).length > 0) {
    try {
      await browserApi.tabGroups.update(groupId, props);
    } catch (error) {
      return partial(op, ERROR_CODES.GROUP_UPDATE_FAILED, errMsg(error), { groupId, windowId });
    }
  }
  return observeGroupedTabs(op, { groupId, windowId, tabIds, title, color });
}

// `browser.update_tab_group`: one `tabGroups.update` call carrying only the
// requested fields that differ from the group's current title/color. A
// request that would change neither is refused as `no_change`.
export async function updateTabGroup(params) {
  await sessionReady;
  const op = "browser.update_tab_group";
  const sessionError = checkSession(op, params?.browserSessionId);
  if (sessionError) return refuse(sessionError);
  const checked = normalizeUpdateTabGroupRequest(params);
  if (!checked.valid) return refuse(errorResult(op, ERROR_CODES.INVALID_PARAMS, checked.reason));
  if (!groupsSupported()) return refuse(unsupportedGroups(op));
  const { groupId, title, color } = checked.request;

  const current = await readGroup(op, groupId);
  if (current.refusal) return current.refusal;
  const { windowId } = current.group;
  const props = {};
  if (title !== null && title !== (current.group.title ?? "")) props.title = title;
  if (color !== null && color !== current.group.color) props.color = color;
  if (Object.keys(props).length === 0) {
    return refuse(errorResult(op, ERROR_CODES.NO_CHANGE, "the group already has the requested title and color"));
  }

  try {
    await browserApi.tabGroups.update(groupId, props);
  } catch (error) {
    return unknownChange(op, ERROR_CODES.GROUP_UPDATE_FAILED, errMsg(error));
  }

  let found;
  try {
    found = await browserApi.tabGroups.get(groupId);
  } catch (error) {
    return partial(op, ERROR_CODES.OBSERVE_FAILED, errMsg(error), { groupId, windowId });
  }
  const group = normalizeTabGroup(found ?? {});
  if (group.groupId !== groupId || !isValidHandle(group.windowId)) {
    return partial(op, ERROR_CODES.OBSERVE_FAILED, "tabGroups.get did not return the group that was just updated", { groupId, windowId });
  }
  if (requestedMetadataMissing(group, title, color)) {
    return partial(op, ERROR_CODES.OBSERVE_FAILED, "the group was not observed with the requested title and color", { groupId, windowId: group.windowId });
  }
  return { ...envelope(op, "ok"), changed: true, group };
}

// `browser.move_tabs`: with a `groupId`, one `tabs.group` call moving every
// selected tab into that existing group in the same window; with
// `groupId: null`, one `tabs.ungroup` call removing them from their groups.
// Tabs may come from several source groups; a source group left with no tabs
// is removed by the browser itself (not reported as a separate change). A move
// that would leave every tab where it already is is refused as `no_change`.
export async function moveTabs(params) {
  await sessionReady;
  const op = "browser.move_tabs";
  const sessionError = checkSession(op, params?.browserSessionId);
  if (sessionError) return refuse(sessionError);
  const checked = normalizeMoveTabsRequest(params);
  if (!checked.valid) return refuse(errorResult(op, ERROR_CODES.INVALID_PARAMS, checked.reason));
  if (!groupsSupported()) return refuse(unsupportedGroups(op));
  const { tabIds, groupId } = checked.request;

  const selected = await readSelectedTabs(op, tabIds);
  if (selected.refusal) return selected.refusal;
  const { windowId } = selected;

  if (groupId !== null) {
    const destination = await readGroup(op, groupId);
    if (destination.refusal) return destination.refusal;
    if (destination.group.windowId !== windowId) {
      return refuse(errorResult(op, ERROR_CODES.WINDOW_MISMATCH, "the destination group is not in the tabs' window"));
    }
    if (selected.tabs.every((tab) => tabGroupMembership(tab) === groupId)) {
      return refuse(errorResult(op, ERROR_CODES.NO_CHANGE, "every selected tab is already in the group"));
    }
    try {
      await browserApi.tabs.group({ groupId, tabIds });
    } catch (error) {
      return unknownChange(op, ERROR_CODES.GROUP_FAILED, errMsg(error));
    }
    return observeGroupedTabs(op, { groupId, windowId, tabIds });
  }

  if (selected.tabs.every((tab) => tabGroupMembership(tab) === TAB_GROUP_ID_NONE)) {
    return refuse(errorResult(op, ERROR_CODES.NO_CHANGE, "none of the selected tabs is in a group"));
  }
  try {
    await browserApi.tabs.ungroup(tabIds);
  } catch (error) {
    return unknownChange(op, ERROR_CODES.UNGROUP_FAILED, errMsg(error));
  }
  let observed;
  try {
    observed = await observeTabsIn(tabIds, TAB_GROUP_ID_NONE, windowId);
  } catch (error) {
    return partial(op, ERROR_CODES.OBSERVE_FAILED, errMsg(error), { windowId });
  }
  if (observed.length !== tabIds.length) {
    return partial(op, ERROR_CODES.OBSERVE_FAILED, missingTabDetail(tabIds, observed, "outside every group"), {
      windowId,
      tabIds: observed.map((tab) => tab.tabId),
    });
  }
  return { ...envelope(op, "ok"), changed: true, group: null, tabs: observed };
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
    default:
      return errorResult(
        typeof message?.method === "string" ? message.method : "unknown",
        ERROR_CODES.UNKNOWN_METHOD,
        message?.method,
      );
  }
}

// The service WebSocket's dispatcher: everything routeMessage handles, plus
// the three tab-group mutations. Only requests from the authenticated service
// reach it; `runtime.onMessage` below uses the read-only routeMessage, so
// extension pages and other message senders cannot change the browser.
// A forwarded request's parameters arrive as the message's own fields
// alongside `method`, which is not a request field and is dropped here.
export async function routeServiceMessage(message) {
  const { method, ...params } = message ?? {};
  if (method === "browser.create_tab_group") return createTabGroup(params);
  if (method === "browser.update_tab_group") return updateTabGroup(params);
  if (method === "browser.move_tabs") return moveTabs(params);
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
