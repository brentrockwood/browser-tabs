// Stage 5 local review UI. Plain DOM APIs and native ES modules only — no
// framework, no build step, no bundler. Every value that could possibly
// have come from the browser or from a derived record (titles, URLs,
// captured text, summary text, rationale, payload JSON, tag/collection
// names, ...) is written with `textContent` only; this file never assigns
// to `innerHTML` or `outerHTML`, and never builds an HTML string by
// concatenating untrusted data. See the per-render functions below.
//
// Stage 5 remediation (Terra findings): this file now guards every
// asynchronous operation against three distinct kinds of race —
// disconnect-during-request, stale/old browser-session responses, and an
// older list refresh overwriting a newer one — using the small, pure
// helpers in ui/lib.mjs (see that file and test/ui-lib.test.mjs for the
// deterministic, DOM-free unit tests of the actual race-prevention logic).
import { createDecisionTracker, createGenerationCounter, createListVersionGuard, isReplacedSession } from "./lib.mjs";

// Must match extension/protocol.js's PROTOCOL_VERSION. Duplicated here
// (not imported) because this is a standalone static page with no build
// step and no access to that module's path.
const PROTOCOL_VERSION = 4;

// Mirrors extension/protocol.js's ERROR_CODES.STALE_SESSION — the one
// code this page must react to specially (see handleStaleBrowserSession
// below), everywhere a browser.*/workflow.* result can carry it.
const STALE_SESSION_CODE = "stale_session";

// Bounded list size used for every "refresh" fetch on this page — well
// under the service's own MAX_LIST_LIMIT (200) — so no list render here is
// ever unbounded, independent of whatever bound the service itself already
// enforces.
const LIST_LIMIT = 200;
const DETAIL_CHUNK_CHARS = 10000;

const state = {
  // The owner token, kept only in this module's memory for as long as the
  // page stays open. Never written to the URL, localStorage,
  // sessionStorage, a cookie, or any console/log statement — see the
  // "Owner token" section of ui/index.html and this file's connect/
  // disconnect handlers below.
  token: null,
  // Established *only* by a fresh, successful `browser.list_windows`
  // result (see rememberSessionFromWindowsResult below) — never adopted
  // from any other route's response, and never from a stale/superseded
  // one. project.md Stage 5 remediation: "only a fresh browser.list_windows
  // result may establish/change browserSessionId."
  sessionId: null,
  // Bumped on Disconnect only. Every async operation that mutates
  // auth-gated UI state (captures/summaries/tags/collections/queue/
  // proposals, capture detail) captures this at the start and checks it
  // again immediately before any DOM mutation — "Connect cannot complete
  // after disconnect," generalized to every other operation too.
  generation: createGenerationCounter(),
  // A second, independent generation for the browser windows/tabs/groups/
  // capture-button tree: bumped on Disconnect (together with `generation`
  // above), on every fresh "Load windows" click, and whenever a stale
  // browser session is detected. This is what guarantees an old,
  // slow-to-resolve "Load tabs"/"Load groups"/"Capture" request issued
  // against a since-replaced window list can never write into the DOM —
  // "never combine old numeric handles with new session."
  browserGeneration: createGenerationCounter(),
  // Aborts every in-flight fetch made while connected. Created fresh at
  // the start of each Connect attempt (before that attempt's own fetch),
  // so a Disconnect click can always cancel it — including a Connect
  // attempt that has not yet succeeded.
  abortController: null,
  // The currently selected capture's detail-view session (`{ id, offset
  // }`), or `null` when no capture is selected. `offset` is mutated only
  // by the chunk-loading code below, and only after confirming (via
  // reference identity: `state.detailSession === session`) that this
  // session has not been superseded by a different selection in the
  // meantime — see selectCapture/loadCaptureDetailChunk.
  detailSession: null,
  historyParams: null,
  historyNextCursor: null,
};

// Tracks each proposal decision's own in-flight/committed lifecycle
// *outside* any one rendered `<li>` (ui/lib.mjs's own header comment
// explains why), so a list re-render after a decision can never lose
// track of "this one is already committed, never offer to decide it
// again" even though the row itself gets destroyed and recreated.
const proposalDecisions = createDecisionTracker();
// Guards store.proposals.list refreshes specifically (explicitly called
// for in the remediation: "generation/version list requests so older
// refresh cannot overwrite newer").
const proposalsListGuard = createListVersionGuard();
// How many proposal decisions are currently mid-flight (PATCH and/or its
// follow-up confirmation re-read); while this is nonzero, the manual
// "Refresh proposals" button is disabled too, so a user-triggered refresh
// can never race a decision's own refresh.
let proposalDecisionsInFlight = 0;

// The same three primitives, instantiated for browser actions (Phase 2):
// each action decision's in-flight lifecycle outside any rendered row, a
// version guard so an older list refresh cannot overwrite a newer one, and a
// count of decisions mid-flight that disables manual refreshes while any is.
const actionDecisions = createDecisionTracker();
const actionsListGuard = createListVersionGuard();
const auditListGuard = createListVersionGuard();
let actionDecisionsInFlight = 0;
// The tab or group chosen for the tab-group form (`{ operation, tabId |
// groupId }`), or null — see "tab groups" below.
let groupTarget = null;

function qs(id) {
  return document.getElementById(id);
}

function setStatus(element, text, isError = false) {
  element.textContent = text;
  element.classList.toggle("error-text", isError);
}

function clearChildren(element) {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function formatTimestamp(ms) {
  if (ms === null || ms === undefined) return "—";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toISOString();
}

function formatBoolean(value) {
  if (value === null || value === undefined) return "—";
  return String(value);
}

// A small DOM-builder helper so every render function below can describe
// structure declaratively without ever touching innerHTML. `text`, when
// given, is always set via `textContent` (never parsed as markup).
// `attrs` may set accessibility attributes (role, aria-live, tabindex) in
// addition to ordinary ones — never anything derived from untrusted data.
function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

// A per-row/per-section async status element: always an ARIA live region,
// so an in-place update (loading/success/error) is announced the same way
// the static, HTML-authored status paragraphs already are. Stage 5
// remediation: every *dynamically created* status element (tabs/groups/
// capture/collection-items/tag-assignments/decision status — previously
// plain, silent elements) now goes through this helper.
function statusElement(tagName = "p") {
  return el(tagName, { attrs: { role: "status", "aria-live": "polite" } });
}

function dlEntry(dl, label, value) {
  dl.appendChild(el("dt", { text: label }));
  dl.appendChild(el("dd", { text: value }));
}

class ApiError extends Error {
  constructor(status, code, detail) {
    super(detail ? `${code}: ${detail}` : String(code));
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function describeError(error) {
  if (error instanceof ApiError) return `${error.message} (HTTP ${error.status})`;
  return error instanceof Error ? error.message : String(error);
}

// Every call this page makes to its own service goes through this one
// function: it always sends the required protocol-version header, the
// owner token held in memory (unless `auth` is explicitly false), and the
// signal of the current connection's AbortController (if any) — so a
// Disconnect can always cancel every outstanding request, not merely the
// ones that happen to still care about their own result. `redirect:
// "error"` so a redirect response is never silently followed with the
// Authorization header attached to an unknown destination.
async function apiRequest(path, { method = "GET", body, auth = true, signal } = {}) {
  const headers = { "X-Protocol-Version": String(PROTOCOL_VERSION) };
  if (auth) {
    if (!state.token) throw new Error("Connect with the owner token first.");
    headers.Authorization = `Bearer ${state.token}`;
  }
  const init = { method, headers, redirect: "error", credentials: "omit" };
  const effectiveSignal = signal ?? state.abortController?.signal;
  if (effectiveSignal) init.signal = effectiveSignal;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new Error(`network error contacting the service: ${error instanceof Error ? error.message : String(error)}`);
  }

  let json = null;
  try {
    json = await response.json();
  } catch {
    // leave json null; handled below
  }

  if (!response.ok || !json || json.error) {
    const code = json?.error?.code ?? `http_${response.status}`;
    throw new ApiError(response.status, code, json?.error?.detail);
  }
  return json;
}

// The *only* place state.sessionId is ever written (project.md Stage 5
// remediation: "only a fresh browser.list_windows result may establish/
// change browserSessionId. Never adopt it from history/stale responses").
function rememberSessionFromWindowsResult(result) {
  if (result && typeof result.browserSessionId === "string" && result.browserSessionId.length > 0) {
    // A different session than the one previously known replaces it: the chosen
    // tab-group target belongs to the old one, so drop it before anything from
    // the new list is rendered. The same session leaves the target alone.
    if (isReplacedSession(state.sessionId, result.browserSessionId)) clearGroupTarget();
    state.sessionId = result.browserSessionId;
  }
}

// True if `result` is the server's explicit "this browserSessionId no
// longer matches the extension's current session" outcome.
function isStaleSessionResult(result) {
  return Boolean(result) && result.status === "error" && result.code === STALE_SESSION_CODE;
}

// Stage 5 remediation: on any stale_session outcome (from list_tabs,
// list_tab_groups, or workflow.capture_tab), the *entire* browser
// inspector tree is torn down — every window/tab/group row and every
// capture button along with it — and an explicit reload requirement is
// shown, rather than leaving a partially-stale tree on screen or silently
// retrying. `state.sessionId` is cleared too, so nothing downstream can
// accidentally keep using the now-invalid id. Bumping `browserGeneration`
// here is what makes any other still-in-flight tabs/groups/capture
// request for the torn-down tree a no-op when it eventually resolves.
function handleStaleBrowserSession() {
  state.browserGeneration.bump();
  state.sessionId = null;
  clearGroupTarget();
  clearChildren(qs("windows-list"));
  setStatus(
    qs("inspector-status"),
    "The browser session changed (or was lost) since this list was loaded. Click \"Load windows\" to continue.",
    true,
  );
}

// ---- connection status (service/extension/store), unauthenticated ----

async function pollHealth() {
  try {
    const response = await fetch("/health", { headers: { "X-Protocol-Version": String(PROTOCOL_VERSION) }, redirect: "error" });
    const json = await response.json();
    qs("service-state").textContent = json.ok ? `running (started ${formatTimestamp(json.service?.startedAt)})` : "error";
    qs("extension-state").textContent = json.extension?.connected
      ? `connected (since ${formatTimestamp(json.extension?.connectedAt)})`
      : "not connected";
    qs("store-state").textContent = json.store?.available ? "available" : "unavailable";
  } catch (error) {
    qs("service-state").textContent = `unreachable (${describeError(error)})`;
    qs("extension-state").textContent = "unknown";
    qs("store-state").textContent = "unknown";
  }
}

// ---- owner token ----

const AUTH_GATED_BUTTON_IDS = [
  "load-windows-button",
  "load-history-button",
  "refresh-captures-button",
  "refresh-summaries-button",
  "refresh-proposals-button",
  "preview-button",
  "group-preview-button",
  "refresh-actions-button",
  "refresh-audit-button",
  "refresh-tags-button",
  "refresh-collections-button",
  "refresh-queue-button",
  "clear-all-button",
];

function setAuthenticatedControlsEnabled(enabled) {
  for (const id of AUTH_GATED_BUTTON_IDS) qs(id).disabled = !enabled;
  qs("disconnect-button").disabled = !enabled;
}

function resetDisplayedData() {
  clearChildren(qs("windows-list"));
  clearChildren(qs("history-list"));
  qs("history-next-button").hidden = true;
  clearChildren(qs("captures-table-body"));
  clearChildren(qs("summaries-list"));
  clearChildren(qs("proposals-list"));
  clearChildren(qs("actions-list"));
  clearChildren(qs("audit-list"));
  for (const id of ["action-form-status", "group-form-status", "action-decision-status", "actions-status", "audit-status"]) qs(id).textContent = "";
  clearGroupTarget();
  clearChildren(qs("tags-list"));
  clearChildren(qs("collections-list"));
  clearChildren(qs("queue-list"));
  qs("detail-section").hidden = true;
  state.detailSession = null;
  state.historyParams = null;
  state.historyNextCursor = null;
}

qs("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = qs("token-input");
  const candidate = input.value;
  if (!candidate) return;

  const connectButton = qs("connect-button");
  connectButton.disabled = true;
  // Captured *before* the request starts: if Disconnect runs while this
  // fetch is in flight, `state.generation` changes and this attempt must
  // never commit a token, enable controls, or show a stale status —
  // "Connect cannot complete after disconnect."
  const startGeneration = state.generation.snapshot();
  const controller = new AbortController();
  // Assigned immediately (not only on success) so Disconnect can always
  // abort *this* attempt's own request, even before it has succeeded.
  state.abortController = controller;
  setStatus(qs("auth-status"), "Connecting…");
  try {
    // Stage 5 remediation: validated via the extension-independent
    // owner.status probe, never browser.get_capabilities — that route
    // round-trips through the extension and would fail with
    // `disconnected` whenever the extension is not connected, and (being
    // agent-allowed too) does not actually distinguish an owner token
    // from an agent one for the purpose of entering this UI at all.
    const headers = { "X-Protocol-Version": String(PROTOCOL_VERSION), Authorization: `Bearer ${candidate}` };
    const response = await fetch("/api/owner.status", { headers, redirect: "error", credentials: "omit", signal: controller.signal });
    const json = await response.json();
    if (!response.ok || !json || json.error) {
      const code = json?.error?.code ?? `http_${response.status}`;
      throw new ApiError(response.status, code, json?.error?.detail);
    }
    if (state.generation.isStale(startGeneration)) return; // disconnected meanwhile; abandon silently
    state.token = candidate;
    // Cleared immediately after capturing it into memory: the token value
    // itself is never left sitting in the visible form field once this
    // page holds it, and it is never written anywhere else (URL, storage,
    // logs). Re-entering it is required again after Disconnect or reload.
    input.value = "";
    setStatus(qs("auth-status"), "Connected: owner scope confirmed via owner.status.");
    setAuthenticatedControlsEnabled(true);
    // "then health separately" — an immediate, explicit read right after
    // connecting, rather than waiting for the next 5-second poll tick.
    pollHealth();
  } catch (error) {
    if (state.generation.isStale(startGeneration)) return; // a disconnect already reset the UI; nothing to report
    if (error?.name === "AbortError") return; // cancelled by Disconnect; nothing to report
    state.token = null;
    setStatus(qs("auth-status"), `Could not connect: ${describeError(error)}`, true);
  } finally {
    connectButton.disabled = false;
  }
});

qs("disconnect-button").addEventListener("click", () => {
  state.generation.bump();
  state.browserGeneration.bump();
  state.abortController?.abort();
  state.abortController = null;
  state.token = null;
  state.sessionId = null;
  qs("token-input").value = "";
  setStatus(qs("auth-status"), "Disconnected. Token cleared from memory.");
  setAuthenticatedControlsEnabled(false);
  resetDisplayedData();
});

// ---- windows / tabs / groups ----

function renderWindowInfo(w) {
  return el("p", {
    text: `Window ${w.windowId} — type: ${w.type}, state: ${w.state}, focused: ${w.focused}, tab count: ${w.tabCount}`,
  });
}

function renderTabRow(t) {
  const captureStatus = statusElement("span");
  const captureButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Capture")]);
  captureButton.addEventListener("click", async () => {
    const bgen = state.browserGeneration.snapshot();
    if (!state.sessionId) {
      captureStatus.textContent = "No browser session known; load windows again first.";
      return;
    }
    captureButton.disabled = true;
    captureStatus.textContent = "Capturing…";
    try {
      const path = `/api/workflow.capture_tab?tabId=${encodeURIComponent(t.tabId)}&browserSessionId=${encodeURIComponent(state.sessionId)}`;
      const { result } = await apiRequest(path, { method: "POST" });
      if (state.browserGeneration.isStale(bgen)) return;
      if (isStaleSessionResult(result)) {
        handleStaleBrowserSession();
        return;
      }
      if (result.status === "ok") {
        captureStatus.textContent = `Captured as capture #${result.id} (${result.textLength ?? 0} character(s)).`;
      } else {
        captureStatus.textContent = `Capture outcome: ${result.status}${result.code ? ` (${result.code})` : ""}`;
      }
    } catch (error) {
      if (state.browserGeneration.isStale(bgen)) return;
      captureStatus.textContent = `Error: ${describeError(error)}`;
      captureStatus.classList.add("error-text");
    } finally {
      if (!state.browserGeneration.isStale(bgen)) captureButton.disabled = false;
    }
  });

  const infoLine = el("p", {
    text:
      `Tab ${t.tabId} — ${t.active ? "active" : "background"}` +
      `${t.pinned ? ", pinned" : ""}${t.audible ? ", audible" : ""}${t.discarded ? ", discarded" : ""}, status: ${t.status}`,
  });
  const titleLine = el("p", { text: `Title: ${t.title ?? "(none)"}` });
  const urlLine = el("p", { text: `URL: ${t.url ?? "(none)"}` });

  // Choosing a target only fills the tab-group form below; nothing is sent
  // until that form's own Preview, and nothing changes until Apply.
  const groupButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Group this tab…")]);
  groupButton.addEventListener("click", () => chooseGroupTarget({ operation: "create", tabId: t.tabId }, `Tab ${t.tabId} — ${t.title ?? "(none)"}`));

  return el("li", {}, [infoLine, titleLine, urlLine, captureButton, el("span", { text: " " }), groupButton, el("span", { text: " " }), captureStatus]);
}

function renderGroupRow(g) {
  const description = `Group ${g.groupId} — title: ${g.title ?? "(none)"}, color: ${g.color ?? "(none)"}, collapsed: ${g.collapsed}`;
  const editButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Edit this group…")]);
  editButton.addEventListener("click", () => chooseGroupTarget({ operation: "update", groupId: g.groupId }, description));
  return el("li", {}, [el("p", { text: description }), editButton]);
}

function renderWindowRow(w) {
  const tabsList = el("ul", { className: "plain-list" });
  const tabsStatus = statusElement();
  const groupsList = el("ul", { className: "plain-list" });
  const groupsStatus = statusElement();

  const loadTabsButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Load tabs")]);
  loadTabsButton.addEventListener("click", async () => {
    const bgen = state.browserGeneration.snapshot();
    loadTabsButton.disabled = true;
    setStatus(tabsStatus, "Loading…");
    try {
      const path = `/api/browser.list_tabs?windowId=${encodeURIComponent(w.windowId)}&browserSessionId=${encodeURIComponent(state.sessionId ?? "")}`;
      const { result } = await apiRequest(path);
      if (state.browserGeneration.isStale(bgen)) return;
      if (isStaleSessionResult(result)) {
        handleStaleBrowserSession();
        return;
      }
      clearChildren(tabsList);
      if (result.status !== "ok") {
        setStatus(tabsStatus, `${result.status}${result.code ? `: ${result.code}` : ""}`, true);
      } else {
        for (const tab of result.tabs) tabsList.appendChild(renderTabRow(tab));
        setStatus(tabsStatus, `Loaded ${result.returnedCount} of ${result.totalCount} tab(s).${result.truncated ? " (truncated)" : ""}`);
      }
    } catch (error) {
      if (state.browserGeneration.isStale(bgen)) return;
      setStatus(tabsStatus, describeError(error), true);
    } finally {
      if (!state.browserGeneration.isStale(bgen)) loadTabsButton.disabled = false;
    }
  });

  const loadGroupsButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Load groups")]);
  loadGroupsButton.addEventListener("click", async () => {
    const bgen = state.browserGeneration.snapshot();
    loadGroupsButton.disabled = true;
    setStatus(groupsStatus, "Loading…");
    try {
      const path = `/api/browser.list_tab_groups?windowId=${encodeURIComponent(w.windowId)}&browserSessionId=${encodeURIComponent(state.sessionId ?? "")}`;
      const { result } = await apiRequest(path);
      if (state.browserGeneration.isStale(bgen)) return;
      if (isStaleSessionResult(result)) {
        handleStaleBrowserSession();
        return;
      }
      clearChildren(groupsList);
      if (result.status === "unsupported") {
        setStatus(groupsStatus, "Tab groups are not supported by this browser.");
      } else if (result.status !== "ok") {
        setStatus(groupsStatus, `${result.status}${result.code ? `: ${result.code}` : ""}`, true);
      } else {
        for (const group of result.groups) groupsList.appendChild(renderGroupRow(group));
        setStatus(groupsStatus, `Loaded ${result.returnedCount} of ${result.totalCount} group(s).${result.truncated ? " (truncated)" : ""}`);
      }
    } catch (error) {
      if (state.browserGeneration.isStale(bgen)) return;
      setStatus(groupsStatus, describeError(error), true);
    } finally {
      if (!state.browserGeneration.isStale(bgen)) loadGroupsButton.disabled = false;
    }
  });

  return el("li", {}, [renderWindowInfo(w), loadTabsButton, loadGroupsButton, tabsStatus, tabsList, groupsStatus, groupsList]);
}

qs("load-windows-button").addEventListener("click", async () => {
  const button = qs("load-windows-button");
  // A fresh, explicit "Load windows" immediately supersedes any
  // still-in-flight tabs/groups/capture request issued against whatever
  // window list is currently rendered — bumped *before* this request even
  // starts, not only after it resolves.
  const bgen = state.browserGeneration.bump();
  button.disabled = true;
  setStatus(qs("inspector-status"), "Loading…");
  try {
    const { result } = await apiRequest("/api/browser.list_windows");
    if (state.browserGeneration.isStale(bgen)) return;
    rememberSessionFromWindowsResult(result);
    const list = qs("windows-list");
    clearChildren(list);
    for (const w of result.windows) list.appendChild(renderWindowRow(w));
    setStatus(qs("inspector-status"), `Loaded ${result.returnedCount} of ${result.totalCount} window(s).${result.truncated ? " (truncated)" : ""}`);
  } catch (error) {
    if (state.browserGeneration.isStale(bgen)) return;
    setStatus(qs("inspector-status"), describeError(error), true);
  } finally {
    if (!state.browserGeneration.isStale(bgen)) button.disabled = false;
  }
});

// ---- history ----

function renderHistoryEntry(entry) {
  return el("li", {}, [
    el("p", { text: `Title: ${entry.title ?? "(none)"}` }),
    el("p", { text: `URL: ${entry.url ?? "(none)"}` }),
    el("p", {
      text: `Last visit: ${formatTimestamp(entry.lastVisitTime)} — visits: ${entry.visitCount}, typed: ${entry.typedCount}`,
    }),
  ]);
}

async function loadHistoryPage(params, cursor, { reset }) {
  const gen = state.generation.snapshot();
  const nextButton = qs("history-next-button");
  qs("load-history-button").disabled = true;
  nextButton.disabled = true;
  setStatus(qs("history-status"), "Loading…");
  try {
    let path = `/api/browser.query_history?startTime=${params.startTime}&endTime=${params.endTime}&maxResults=${params.maxResults}`;
    if (cursor !== undefined) path += `&cursor=${encodeURIComponent(cursor)}`;
    const { result } = await apiRequest(path);
    if (state.generation.isStale(gen)) return;
    const list = qs("history-list");
    if (reset) clearChildren(list);
    if (result.status !== "ok") {
      setStatus(qs("history-status"), `Incomplete: ${result.code ?? result.status}`, true);
      nextButton.hidden = true;
    } else {
      for (const entry of result.entries) list.appendChild(renderHistoryEntry(entry));
      const more = result.nextCursor !== null;
      setStatus(
        qs("history-status"),
        `Returned ${result.returnedCount} entr${result.returnedCount === 1 ? "y" : "ies"} this page.` +
          `${result.truncated ? " This page was truncated." : ""} ${more ? "More results are available." : "No further results (complete)."}`,
      );
      nextButton.hidden = !more;
      state.historyParams = params;
      state.historyNextCursor = result.nextCursor;
    }
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("history-status"), describeError(error), true);
  } finally {
    if (!state.generation.isStale(gen)) {
      qs("load-history-button").disabled = false;
      nextButton.disabled = false;
    }
  }
}

qs("history-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const startValue = qs("history-start").value;
  const endValue = qs("history-end").value;
  const startTime = startValue ? new Date(startValue).getTime() : 0;
  const endTime = endValue ? new Date(endValue).getTime() : Date.now();
  const maxResults = Number(qs("history-max-results").value) || 50;
  loadHistoryPage({ startTime, endTime, maxResults }, undefined, { reset: true });
});

qs("history-next-button").addEventListener("click", () => {
  if (state.historyParams && state.historyNextCursor !== null) {
    loadHistoryPage(state.historyParams, state.historyNextCursor, { reset: false });
  }
});

// ---- captures ----

async function performDelete(path, confirmMessage, onDeleted) {
  if (!window.confirm(confirmMessage)) return;
  const gen = state.generation.snapshot();
  try {
    await apiRequest(path, { method: "DELETE" });
    if (state.generation.isStale(gen)) return;
    onDeleted();
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    window.alert(`Delete failed: ${describeError(error)}`);
  }
}

async function deleteCapture(id, row) {
  if (!window.confirm(`Delete capture #${id}? This cannot be undone.`)) return;
  const gen = state.generation.snapshot();
  try {
    await apiRequest(`/api/store.captures.delete?id=${id}`, { method: "DELETE" });
    if (state.generation.isStale(gen)) return;
    row.remove();
    if (state.detailSession?.id === id) qs("detail-section").hidden = true;
    return;
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    if (!(error instanceof ApiError) || error.code !== "has_dependents") {
      window.alert(`Delete failed: ${describeError(error)}`);
      return;
    }
  }
  if (!window.confirm(`Capture #${id} is cited by summaries or proposals. Delete it and every dependent (cascade)?`)) return;
  try {
    await apiRequest(`/api/store.captures.delete?id=${id}&cascade=true`, { method: "DELETE" });
    if (state.generation.isStale(gen)) return;
    row.remove();
    if (state.detailSession?.id === id) qs("detail-section").hidden = true;
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    window.alert(`Cascading delete failed: ${describeError(error)}`);
  }
}

function renderCaptureRow(c) {
  const row = document.createElement("tr");
  row.appendChild(el("td", { text: String(c.id) }));
  row.appendChild(el("td", { text: `${c.title ?? "(no title)"} — ${c.url ?? "(no url)"}` }));
  row.appendChild(el("td", { text: c.status }));
  row.appendChild(el("td", { text: formatTimestamp(c.capturedAt) }));
  row.appendChild(el("td", { text: c.textLength === null ? "—" : String(c.textLength) }));
  row.appendChild(el("td", { text: formatBoolean(c.truncated) }));

  const viewButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("View")]);
  viewButton.addEventListener("click", () => selectCapture(c.id));
  const deleteButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Delete")]);
  deleteButton.addEventListener("click", () => deleteCapture(c.id, row));
  row.appendChild(el("td", {}, [viewButton, deleteButton]));

  return row;
}

async function refreshCaptures() {
  const button = qs("refresh-captures-button");
  const gen = state.generation.snapshot();
  button.disabled = true;
  setStatus(qs("captures-status"), "Loading…");
  try {
    const { result } = await apiRequest(`/api/store.captures.list?limit=${LIST_LIMIT}`);
    if (state.generation.isStale(gen)) return;
    const body = qs("captures-table-body");
    clearChildren(body);
    for (const capture of result.items) body.appendChild(renderCaptureRow(capture));
    setStatus(qs("captures-status"), `Showing ${result.items.length} of ${result.total} capture(s).`);
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("captures-status"), describeError(error), true);
  } finally {
    if (!state.generation.isStale(gen)) button.disabled = false;
  }
}
qs("refresh-captures-button").addEventListener("click", refreshCaptures);

// ---- capture detail (bounded text + related summaries/proposals) ----

function renderDetailMetadata(result) {
  const dl = qs("detail-metadata");
  clearChildren(dl);
  dlEntry(dl, "Capture ID", String(result.id));
  dlEntry(dl, "Status", result.status);
  dlEntry(dl, "URL", result.url ?? "—");
  dlEntry(dl, "Title", result.title ?? "—");
  dlEntry(dl, "Document ready state", result.documentReadyState ?? "—");
  dlEntry(dl, "Captured at", formatTimestamp(result.capturedAt));
  dlEntry(dl, "Browser session ID", result.browserSessionId ?? "—");
  dlEntry(dl, "Source operation", result.sourceOperation ?? "—");
  dlEntry(dl, "Schema version", result.schemaVersion === null || result.schemaVersion === undefined ? "—" : String(result.schemaVersion));
  dlEntry(dl, "Character count", result.characterCount === null ? "—" : String(result.characterCount));
  dlEntry(dl, "Returned character count", result.returnedCharacterCount === null ? "—" : String(result.returnedCharacterCount));
  dlEntry(dl, "Truncated", formatBoolean(result.truncated));
  dlEntry(dl, "Code", result.code ?? "—");
  dlEntry(dl, "Detail", result.detail ?? "—");
}

function renderRelatedSummary(s) {
  return el("li", {}, [
    el("p", { text: `Summary #${s.id} — creator: ${s.creatorType}${s.creatorName ? ` (${s.creatorName})` : ""}` }),
    el("p", { text: s.text }),
  ]);
}

function renderRelatedProposal(p) {
  return el("li", {}, [
    el("p", { text: `Proposal #${p.id} — kind: ${p.kind}, state: ${p.state}` }),
    el("p", { text: p.rationale }),
  ]);
}

// `session` is the exact object created by selectCapture — every check
// below compares it by *reference* against `state.detailSession`, which is
// what detects "the user selected a different capture while this request
// was in flight" even if (improbably) that different capture happened to
// share the same id. `authGen` is the auth generation snapshot taken at
// selection time, checked independently so a Disconnect mid-fetch is caught
// too. The offset requested is read from `session.offset` *before* the
// await (an immutable snapshot for this one request) and the next offset
// is computed from that same snapshot, never from whatever
// `session.offset` happens to hold by the time the response arrives — so
// two overlapping chunk requests for the same session can never corrupt
// each other's bookkeeping.
async function loadCaptureDetailChunk(session, authGen, { reset }) {
  const isCurrent = () => state.detailSession === session && !state.generation.isStale(authGen);
  if (!isCurrent()) return;
  const loadMoreButton = qs("detail-load-more-button");
  loadMoreButton.disabled = true;
  setStatus(qs("detail-text-status"), "Loading…");
  const requestedOffset = session.offset;
  try {
    const path = `/api/store.captures.read?id=${session.id}&offset=${requestedOffset}&maxChars=${DETAIL_CHUNK_CHARS}`;
    const { result } = await apiRequest(path);
    if (!isCurrent()) return;
    if (reset) renderDetailMetadata(result);
    qs("detail-text").textContent += result.chunk;
    session.offset = requestedOffset + result.chunkLength;
    const total = result.textLength ?? 0;
    const hasMore = session.offset < total;
    loadMoreButton.hidden = !hasMore;
    setStatus(qs("detail-text-status"), `Showing ${session.offset} of ${total} character(s).`);
  } catch (error) {
    if (!isCurrent()) return;
    setStatus(qs("detail-text-status"), describeError(error), true);
  } finally {
    if (isCurrent()) loadMoreButton.disabled = false;
  }
}

async function loadRelatedRecords(session, authGen, captureId) {
  const isCurrent = () => state.detailSession === session && !state.generation.isStale(authGen);
  if (!isCurrent()) return;
  const summariesList = qs("detail-summaries-list");
  const proposalsList = qs("detail-proposals-list");
  clearChildren(summariesList);
  clearChildren(proposalsList);
  try {
    const { result } = await apiRequest(`/api/store.summaries.list?limit=${LIST_LIMIT}`);
    if (!isCurrent()) return;
    const related = result.items.filter((s) => Array.isArray(s.sourceCaptureIds) && s.sourceCaptureIds.includes(captureId));
    if (related.length === 0) summariesList.appendChild(el("li", { text: "(none found among the most recent summaries)" }));
    for (const summary of related) summariesList.appendChild(renderRelatedSummary(summary));
  } catch (error) {
    if (!isCurrent()) return;
    summariesList.appendChild(el("li", { text: describeError(error), className: "error-text" }));
  }
  try {
    const { result } = await apiRequest(`/api/store.proposals.list?limit=${LIST_LIMIT}`);
    if (!isCurrent()) return;
    const related = result.items.filter((p) => Array.isArray(p.sourceCaptureIds) && p.sourceCaptureIds.includes(captureId));
    if (related.length === 0) proposalsList.appendChild(el("li", { text: "(none found among the most recent proposals)" }));
    for (const proposal of related) proposalsList.appendChild(renderRelatedProposal(proposal));
  } catch (error) {
    if (!isCurrent()) return;
    proposalsList.appendChild(el("li", { text: describeError(error), className: "error-text" }));
  }
}

function selectCapture(id) {
  const authGen = state.generation.snapshot();
  // A fresh object identity per selection: this — not the capture id alone
  // — is what loadCaptureDetailChunk/loadRelatedRecords compare against to
  // detect "superseded by a different selection," so re-selecting the same
  // id (e.g. clicking "View" twice) also cleanly supersedes any still-
  // in-flight request from the first click.
  const session = { id, offset: 0 };
  state.detailSession = session;
  const detailSection = qs("detail-section");
  const heading = qs("detail-heading");
  detailSection.hidden = false;
  qs("detail-text").textContent = "";
  detailSection.scrollIntoView({ block: "start" });
  // Accessibility: moves focus to the (programmatically focusable, via
  // tabindex="-1" in ui/index.html) detail heading so a keyboard/screen-
  // reader user lands on the newly revealed section instead of staying
  // wherever the "View" button was.
  heading.focus();
  loadCaptureDetailChunk(session, authGen, { reset: true });
  loadRelatedRecords(session, authGen, id);
}

qs("detail-load-more-button").addEventListener("click", () => {
  const session = state.detailSession;
  if (!session) return;
  loadCaptureDetailChunk(session, state.generation.snapshot(), { reset: false });
});

// ---- summaries ----

function renderSummaryItem(s) {
  const details = el("details");
  details.appendChild(el("summary", { text: `Summary #${s.id} — ${s.creatorType}${s.creatorName ? ` (${s.creatorName})` : ""}` }));
  const dl = el("dl");
  dlEntry(dl, "Created at", formatTimestamp(s.createdAt));
  dlEntry(dl, "Updated at", formatTimestamp(s.updatedAt));
  dlEntry(dl, "Source capture IDs", s.sourceCaptureIds.length ? s.sourceCaptureIds.join(", ") : "—");
  details.appendChild(dl);
  details.appendChild(el("pre", { text: s.text }));
  if (s.modelMetadata) details.appendChild(el("pre", { text: JSON.stringify(s.modelMetadata) }));

  const deleteButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Delete")]);
  const li = el("li", {}, [details, deleteButton]);
  deleteButton.addEventListener("click", () =>
    performDelete(`/api/store.summaries.delete?id=${s.id}`, `Delete summary #${s.id}?`, () => li.remove()),
  );
  return li;
}

async function refreshSummaries() {
  const button = qs("refresh-summaries-button");
  const gen = state.generation.snapshot();
  button.disabled = true;
  setStatus(qs("summaries-status"), "Loading…");
  try {
    const { result } = await apiRequest(`/api/store.summaries.list?limit=${LIST_LIMIT}`);
    if (state.generation.isStale(gen)) return;
    const list = qs("summaries-list");
    clearChildren(list);
    for (const summary of result.items) list.appendChild(renderSummaryItem(summary));
    setStatus(qs("summaries-status"), `Showing ${result.items.length} of ${result.total} summary(ies).`);
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("summaries-status"), describeError(error), true);
  } finally {
    if (!state.generation.isStale(gen)) button.disabled = false;
  }
}
qs("refresh-summaries-button").addEventListener("click", refreshSummaries);

// ---- proposals ----

function setProposalsRefreshDisabled(disabled) {
  qs("refresh-proposals-button").disabled = disabled;
}

function renderProposalItem(p) {
  const details = el("details");
  details.appendChild(el("summary", { text: `Proposal #${p.id} — kind: ${p.kind}, state: ${p.state}` }));
  const dl = el("dl");
  dlEntry(dl, "Creator", `${p.creatorType}${p.creatorName ? ` (${p.creatorName})` : ""}`);
  dlEntry(dl, "Created at", formatTimestamp(p.createdAt));
  dlEntry(dl, "Source capture IDs", p.sourceCaptureIds.length ? p.sourceCaptureIds.join(", ") : "—");
  dlEntry(dl, "Source summary IDs", p.sourceSummaryIds.length ? p.sourceSummaryIds.join(", ") : "—");
  if (p.state !== "pending") {
    dlEntry(dl, "Decided at", formatTimestamp(p.decidedAt));
    dlEntry(dl, "Decided by", `${p.decidedByCreatorType ?? "—"}${p.decidedByCreatorName ? ` (${p.decidedByCreatorName})` : ""}`);
  }
  details.appendChild(dl);
  details.appendChild(el("p", { text: p.rationale }));
  details.appendChild(el("pre", { text: JSON.stringify(p.payload) }));

  const li = el("li", {}, [details]);

  // A proposal already known to be committed (by this page, in this
  // session) never shows decision buttons at all, even if `p.state` were
  // somehow still "pending" in a response this page is currently
  // rendering (e.g. a slow, now-superseded refresh) — proposalDecisions
  // is the authority on "already decided from here," independent of
  // whichever server snapshot happens to be rendering.
  if (p.state === "pending" && !proposalDecisions.isCommitted(p.id)) {
    const decisionStatus = statusElement();
    const acceptButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Accept")]);
    const rejectButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Reject")]);
    const buttonsRow = el("div", { className: "decision-buttons" }, [acceptButton, rejectButton]);
    li.appendChild(buttonsRow);
    li.appendChild(decisionStatus);

    if (proposalDecisions.isSubmitting(p.id)) {
      acceptButton.disabled = true;
      rejectButton.disabled = true;
      setStatus(decisionStatus, "Submitting decision…");
    }

    // Explicit accept/reject only, never auto-applied. Stage 5
    // remediation: PATCH failure (never reached/accepted by the server) is
    // distinguished from PATCH success followed by a failed confirmation
    // re-read — the latter must never re-enable these buttons, since the
    // decision is already recorded server-side and retrying would attempt
    // to decide an already-decided proposal.
    const decide = async (newState) => {
      if (!proposalDecisions.begin(p.id)) return; // already submitting or already committed
      const gen = state.generation.snapshot();
      acceptButton.disabled = true;
      rejectButton.disabled = true;
      proposalDecisionsInFlight += 1;
      setProposalsRefreshDisabled(true);
      setStatus(decisionStatus, "Submitting decision…");
      let patchSucceeded = false;
      try {
        await apiRequest(`/api/store.proposals.update?id=${p.id}`, { method: "PATCH", body: { state: newState, creatorType: "user" } });
        patchSucceeded = true;
        // Recorded server-side now — permanently committed from this
        // tracker's point of view, regardless of what happens next.
        proposalDecisions.commit(p.id);
        if (state.generation.isStale(gen)) return;
        setStatus(decisionStatus, "Decision recorded; refreshing…");
        try {
          await refreshProposals();
          // On success, refreshProposals() has already rebuilt the whole
          // list (including this row, now rendered from its own decided
          // state) — nothing further to do with this specific row.
        } catch (refreshError) {
          if (state.generation.isStale(gen)) return;
          // The decision itself already committed — a failed confirmation
          // re-read must never be presented as retryable, and the buttons
          // must stay disabled.
          setStatus(decisionStatus, `Decision recorded, but refreshing the list failed: ${describeError(refreshError)}`, true);
        }
      } catch (error) {
        if (!patchSucceeded) {
          proposalDecisions.fail(p.id);
          if (state.generation.isStale(gen)) return;
          setStatus(decisionStatus, `Error: ${describeError(error)}`, true);
          acceptButton.disabled = false;
          rejectButton.disabled = false;
        }
      } finally {
        proposalDecisionsInFlight = Math.max(0, proposalDecisionsInFlight - 1);
        if (proposalDecisionsInFlight === 0) setProposalsRefreshDisabled(false);
      }
    };
    acceptButton.addEventListener("click", () => decide("accepted"));
    rejectButton.addEventListener("click", () => decide("rejected"));
  } else if (p.state !== "pending") {
    const deleteButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Delete")]);
    deleteButton.addEventListener("click", () =>
      performDelete(`/api/store.proposals.delete?id=${p.id}`, `Delete proposal #${p.id}?`, () => li.remove()),
    );
    li.appendChild(deleteButton);
  }

  return li;
}

// Throws on failure (after already updating the status text) so a
// decision's own post-commit reread can distinguish "the reread itself
// failed" from "it succeeded" — see `decide` above. The manual refresh
// button's own click listener (registered below) swallows that rejection,
// since the status element already communicates the failure.
async function refreshProposals() {
  const button = qs("refresh-proposals-button");
  const gen = state.generation.snapshot();
  const token = proposalsListGuard.start();
  button.disabled = true;
  setStatus(qs("proposals-status"), "Loading…");
  try {
    const { result } = await apiRequest(`/api/store.proposals.list?limit=${LIST_LIMIT}`);
    if (state.generation.isStale(gen) || !proposalsListGuard.canApply(token)) return;
    proposalsListGuard.apply(token);
    const list = qs("proposals-list");
    clearChildren(list);
    for (const proposal of result.items) list.appendChild(renderProposalItem(proposal));
    setStatus(qs("proposals-status"), `Showing ${result.items.length} of ${result.total} proposal(s).`);
    // Accessibility + Stage 5 remediation: restores focus to the section
    // heading after a rerender, so a keyboard/screen-reader user is not
    // silently left focused on a now-detached or repurposed element.
    qs("proposals-heading").focus();
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("proposals-status"), describeError(error), true);
    throw error;
  } finally {
    if (!state.generation.isStale(gen) && proposalDecisionsInFlight === 0) button.disabled = false;
  }
}
qs("refresh-proposals-button").addEventListener("click", () => {
  refreshProposals().catch(() => {}); // status element already shows the error
});

// ---- browser actions: open a URL in a new tab (Phase 2 Action 1) ----

// Page-side bounds for the two lists below, under the service's own caps
// (and small enough that the list response stays well inside its size bound).
const ACTIONS_LIMIT = 50;
const AUDIT_LIMIT = 100;

const ACTION_STATE_LABELS = {
  previewed: "awaiting your decision — nothing has been opened",
  approved: "approved — no result recorded yet",
  rejected: "rejected — nothing was opened",
  executed: "opened",
  partial: "partly done — a tab was opened but could not be observed afterwards",
  stale: "refused as stale — nothing was opened",
  failed: "failed",
};

const ACTION_MUTATION_LABELS = {
  created: "yes — one new tab was created",
  none: "no — nothing was opened",
  unknown: "unknown — the request may have been acted on, but no usable answer came back",
};

// Phase 2 Action 2 (tab groups) states and wording, kept apart from the
// open-a-tab ones above because every sentence there is about a tab.
const GROUP_STATE_LABELS = {
  previewed: "awaiting your decision — nothing has been changed",
  approved: "approved — no result recorded yet",
  rejected: "rejected — nothing was changed",
  executed: "applied",
  partial: "partly done — a change was made but could not be completed or observed afterwards",
  stale: "refused as stale — what was previewed no longer holds, nothing was changed",
  failed: "failed",
};

const GROUP_MUTATION_LABELS = {
  created: "yes — one new group was created around the chosen tab",
  updated: "yes — one existing group was changed",
  none: "no — nothing was changed",
  unknown: "unknown — the request may have been acted on, but no usable answer came back",
};

function actionStateLabel(a) {
  const labels = a.kind === "configure_group" ? GROUP_STATE_LABELS : ACTION_STATE_LABELS;
  return labels[a.state] ?? a.state;
}

// The exact target and requested change a stored group preview binds. The
// tab's title/address and the group's current title are untrusted browser
// text; this is only ever rendered with textContent.
function describeGroupBinding(b) {
  const change = [];
  if (b.title !== null) change.push(b.title === "" ? "remove the title" : `title "${b.title}"`);
  if (b.color !== null) change.push(`color ${b.color}`);
  if (b.operation === "create") {
    const what = change.length > 0 ? ` with ${change.join(" and ")}` : "";
    return `Create a new group${what} around tab ${b.tabId} in window ${b.windowId} (ungrouped when previewed) — "${b.tabTitle ?? ""}" ${b.tabUrl ?? ""}`;
  }
  return `Change group ${b.groupId} in window ${b.windowId} (currently titled "${b.expectedTitle}", color ${b.expectedColor}): ${change.join(" and ")}`;
}

function setActionsRefreshDisabled(disabled) {
  qs("refresh-actions-button").disabled = disabled;
}

// A stored action's address and observed tab text are untrusted (the address
// came from whoever typed it; the observed title/URL came from the browser):
// every one of them is rendered with textContent only, and the address is
// never turned into a link or navigated to by this page.
function renderActionItem(a) {
  const urlId = `action-${a.id}-url`;
  const isGroup = a.kind === "configure_group";
  const li = el("li", { attrs: { id: `action-${a.id}`, tabindex: "-1" } });
  li.appendChild(el("p", { text: `Action #${a.id} — ${isGroup ? "tab group" : "open in a new tab"} — ${actionStateLabel(a)}` }));
  if (isGroup) li.appendChild(el("p", { text: describeGroupBinding(a.binding), attrs: { id: urlId } }));
  else li.appendChild(el("p", { text: `Address: ${a.url}`, attrs: { id: urlId } }));

  const dl = el("dl");
  dlEntry(dl, "Previewed at", formatTimestamp(a.previewedAt));
  dlEntry(dl, "Browser session ID", a.browserSessionId);
  if (a.decidedAt !== null) dlEntry(dl, "Decided at", formatTimestamp(a.decidedAt));
  if (a.completedAt !== null) dlEntry(dl, "Completed at", formatTimestamp(a.completedAt));
  if (a.result) {
    const r = a.result;
    dlEntry(dl, "Browser changed", (isGroup ? GROUP_MUTATION_LABELS : ACTION_MUTATION_LABELS)[r.mutation] ?? r.mutation);
    if (r.code) dlEntry(dl, "Outcome code", r.code);
    if (r.detail) dlEntry(dl, "Detail", r.detail);
    if (isGroup) {
      if (r.groupId !== null) dlEntry(dl, "Group / window", `group ${r.groupId} in window ${r.windowId ?? "—"}`);
      if (r.tabId !== null) dlEntry(dl, "Tab", `tab ${r.tabId}`);
      if (r.observed) {
        dlEntry(dl, "Observed title (untrusted browser text)", r.observed.title ?? "—");
        dlEntry(dl, "Observed color", r.observed.color ?? "—");
        dlEntry(dl, "Observed collapsed", formatBoolean(r.observed.collapsed));
      }
    } else if (r.tabId !== null) {
      dlEntry(dl, "Tab / window", `tab ${r.tabId} in window ${r.windowId ?? "—"}`);
    }
    if (!isGroup && r.observed) {
      dlEntry(dl, "Observed status", r.observed.status);
      dlEntry(dl, "Observed title (untrusted browser text)", r.observed.title ?? "—");
      dlEntry(dl, "Observed address (untrusted browser text)", r.observed.url ?? "—");
      dlEntry(dl, "Observed pending address", r.observed.pendingUrl ?? "—");
    }
  }
  li.appendChild(dl);

  if (a.state === "previewed") {
    const openButton = el("button", { attrs: { type: "button", "aria-describedby": urlId } }, [document.createTextNode(isGroup ? "Apply" : "Open")]);
    const rejectButton = el("button", { attrs: { type: "button", "aria-describedby": urlId } }, [document.createTextNode("Reject")]);
    li.appendChild(el("div", { className: "decision-buttons" }, [openButton, rejectButton]));
    // A row rebuilt while its own decision is still in flight (any refresh
    // can do this) must come back disabled, never offering a second submit.
    if (actionDecisions.isSubmitting(a.id)) {
      openButton.disabled = true;
      rejectButton.disabled = true;
    }
    openButton.addEventListener("click", () => decideAction(a.id, "approve", [openButton, rejectButton], a.kind));
    rejectButton.addEventListener("click", () => decideAction(a.id, "reject", [openButton, rejectButton], a.kind));
  }
  return li;
}

// One decision per click, by id alone (the request carries no address and no
// body). Whatever happens — success, a refusal, or a network error whose
// outcome is unknown — the page then rereads the list from the service
// instead of guessing, so what is shown is always the recorded state.
async function decideAction(id, operation, buttons, kind) {
  if (!actionDecisions.begin(id)) return; // already submitting
  const gen = state.generation.snapshot();
  for (const button of buttons) button.disabled = true;
  actionDecisionsInFlight += 1;
  setActionsRefreshDisabled(true);
  const verb = operation === "approve" ? (kind === "configure_group" ? "Apply" : "Open") : "Reject";
  setStatus(qs("action-decision-status"), `${verb} for action #${id}: submitting…`);
  try {
    const { result } = await (kind === "configure_group"
      ? apiRequest(`/api/action.configure_group.${operation}?id=${id}`, { method: "POST" })
      : apiRequest(`/api/action.open_tab.${operation}?id=${id}`, { method: "POST" }));
    if (!state.generation.isStale(gen)) {
      setStatus(qs("action-decision-status"), `Action #${id}: ${actionStateLabel(result)}.`, result.state === "failed");
    }
  } catch (error) {
    if (!state.generation.isStale(gen)) {
      setStatus(qs("action-decision-status"), `${verb} for action #${id} did not complete: ${describeError(error)}. Reloading the list to show what was recorded.`, true);
    }
  }
  // The list below is the authority; the tracker is released first so the
  // rebuilt row offers buttons again only if the service still says previewed.
  actionDecisions.reset(id);
  try {
    if (!state.generation.isStale(gen)) await refreshActions();
  } catch {
    // refreshActions has already put the failure in its own status element.
  } finally {
    actionDecisionsInFlight = Math.max(0, actionDecisionsInFlight - 1);
    if (actionDecisionsInFlight === 0 && !state.generation.isStale(gen)) setActionsRefreshDisabled(false);
  }
}

// Throws on failure (after updating the status text), like refreshProposals,
// so decideAction's own reread can tell a failed reread from a successful one.
async function refreshActions() {
  const button = qs("refresh-actions-button");
  const gen = state.generation.snapshot();
  const token = actionsListGuard.start();
  button.disabled = true;
  setStatus(qs("actions-status"), "Loading…");
  try {
    const { result } = await apiRequest(`/api/store.actions.list?limit=${ACTIONS_LIMIT}`);
    if (state.generation.isStale(gen) || !actionsListGuard.apply(token)) return;
    const list = qs("actions-list");
    clearChildren(list);
    for (const action of result.items) list.appendChild(renderActionItem(action));
    setStatus(qs("actions-status"), `Showing ${result.items.length} of ${result.total} action(s), newest first.`);
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("actions-status"), describeError(error), true);
    throw error;
  } finally {
    if (!state.generation.isStale(gen) && actionDecisionsInFlight === 0) button.disabled = false;
  }
}
qs("refresh-actions-button").addEventListener("click", () => {
  refreshActions().catch(() => {}); // status element already shows the error
});

qs("action-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = qs("action-url-input");
  const url = input.value.trim();
  if (!url) return;
  const button = qs("preview-button");
  const gen = state.generation.snapshot();
  button.disabled = true;
  setStatus(qs("action-form-status"), "Creating preview…");
  try {
    const { result } = await apiRequest("/api/action.open_tab.preview", { method: "POST", body: { url } });
    if (state.generation.isStale(gen)) return;
    input.value = "";
    setStatus(
      qs("action-form-status"),
      `Preview #${result.id} created. Nothing has been opened yet: review it below, then choose Open or Reject.`,
    );
    await refreshActions();
    if (state.generation.isStale(gen)) return;
    // Focus lands on the new preview's row (not on its Open button), so a
    // keyboard or screen-reader user arrives at the preview to read it and a
    // stray keypress cannot open anything.
    qs(`action-${result.id}`)?.focus();
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("action-form-status"), `Could not create a preview: ${describeError(error)}`, true);
  } finally {
    if (!state.generation.isStale(gen)) button.disabled = false;
  }
});

function renderAuditEntry(e) {
  return el("li", {
    text: `#${e.id} — ${formatTimestamp(e.occurredAt)} — action #${e.actionId} — ${e.event} — ${JSON.stringify(e.detail)}`,
  });
}

async function refreshAudit() {
  const button = qs("refresh-audit-button");
  const gen = state.generation.snapshot();
  const token = auditListGuard.start();
  button.disabled = true;
  setStatus(qs("audit-status"), "Loading…");
  try {
    const { result } = await apiRequest(`/api/store.actions.audit.list?limit=${AUDIT_LIMIT}`);
    if (state.generation.isStale(gen) || !auditListGuard.apply(token)) return;
    const list = qs("audit-list");
    clearChildren(list);
    for (const entry of result.items) list.appendChild(renderAuditEntry(entry));
    setStatus(qs("audit-status"), `Showing ${result.items.length} of ${result.total} event(s), newest first.`);
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("audit-status"), describeError(error), true);
  } finally {
    if (!state.generation.isStale(gen)) button.disabled = false;
  }
}
qs("refresh-audit-button").addEventListener("click", refreshAudit);

// ---- tab groups: create around one tab, or rename/recolor (Phase 2 Action 2) ----

// Choosing a tab or group from the lists above only fills in this form; the
// request that stores a preview sends the operation, that one handle, and the
// requested title/color — no browser session and no window (the service
// learns those from the browser itself). Nothing changes in the browser until
// the preview's own Apply, decided by its id alone like any other action.
function clearGroupTarget() {
  groupTarget = null;
  qs("group-target").textContent = "No tab or group chosen yet.";
  qs("group-clear-title").checked = false;
}

function chooseGroupTarget(target, description) {
  groupTarget = target;
  qs("group-target").textContent = `${target.operation === "create" ? "New group around" : "Editing"}: ${description}`;
  const clearTitle = qs("group-clear-title");
  clearTitle.checked = false;
  clearTitle.disabled = target.operation === "create";
  qs("group-title-input").focus();
}

qs("group-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = qs("group-form-status");
  if (!groupTarget) {
    setStatus(status, 'Choose a tab ("Group this tab…") or a group ("Edit this group…") above first.', true);
    return;
  }
  const title = qs("group-title-input").value;
  const clearTitle = qs("group-clear-title").checked;
  const color = qs("group-color-select").value;
  if (title !== "" && clearTitle) {
    setStatus(status, "Enter a title or choose to remove it, not both.", true);
    return;
  }
  const body = { ...groupTarget };
  if (title !== "") body.title = title;
  else if (clearTitle) body.title = "";
  if (color !== "") body.color = color;

  const button = qs("group-preview-button");
  const gen = state.generation.snapshot();
  button.disabled = true;
  setStatus(status, "Creating preview…");
  try {
    const { result } = await apiRequest("/api/action.configure_group.preview", { method: "POST", body });
    if (state.generation.isStale(gen)) return;
    setStatus(status, `Preview #${result.id} created. Nothing has been changed yet: review it below, then choose Apply or Reject.`);
    await refreshActions();
    if (state.generation.isStale(gen)) return;
    qs(`action-${result.id}`)?.focus();
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(status, `Could not create a preview: ${describeError(error)}`, true);
  } finally {
    if (!state.generation.isStale(gen)) button.disabled = false;
  }
});

// ---- tags ----

function renderTagItem(t) {
  const li = el("li", { text: `Tag #${t.id} "${t.name}" — creator: ${t.creatorType}${t.creatorName ? ` (${t.creatorName})` : ""}` });

  // Stage 5 remediation: bounded, on-demand tag-assignment provenance,
  // mirroring the collections "Load items" pattern below.
  const assignmentsList = el("ul", { className: "plain-list" });
  const assignmentsStatus = statusElement();
  const loadAssignmentsButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Load assignments")]);
  loadAssignmentsButton.addEventListener("click", async () => {
    const gen = state.generation.snapshot();
    loadAssignmentsButton.disabled = true;
    setStatus(assignmentsStatus, "Loading…");
    try {
      const { result } = await apiRequest(`/api/store.tags.assignments.list?tagId=${t.id}&limit=${LIST_LIMIT}`);
      if (state.generation.isStale(gen)) return;
      clearChildren(assignmentsList);
      for (const assignment of result.items) {
        assignmentsList.appendChild(
          el("li", {
            text:
              `${assignment.recordType} #${assignment.recordId} — assigned by ${assignment.creatorType}` +
              `${assignment.creatorName ? ` (${assignment.creatorName})` : ""} at ${formatTimestamp(assignment.createdAt)}`,
          }),
        );
      }
      setStatus(assignmentsStatus, `Showing ${result.items.length} of ${result.total} assignment(s).`);
    } catch (error) {
      if (state.generation.isStale(gen)) return;
      setStatus(assignmentsStatus, describeError(error), true);
    } finally {
      if (!state.generation.isStale(gen)) loadAssignmentsButton.disabled = false;
    }
  });
  li.appendChild(loadAssignmentsButton);
  li.appendChild(assignmentsStatus);
  li.appendChild(assignmentsList);

  const deleteButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Delete")]);
  deleteButton.addEventListener("click", () => performDelete(`/api/store.tags.delete?id=${t.id}`, `Delete tag #${t.id}?`, () => li.remove()));
  li.appendChild(deleteButton);
  return li;
}

async function refreshTags() {
  const button = qs("refresh-tags-button");
  const gen = state.generation.snapshot();
  button.disabled = true;
  setStatus(qs("tags-status"), "Loading…");
  try {
    const { result } = await apiRequest(`/api/store.tags.list?limit=${LIST_LIMIT}`);
    if (state.generation.isStale(gen)) return;
    const list = qs("tags-list");
    clearChildren(list);
    for (const tag of result.items) list.appendChild(renderTagItem(tag));
    setStatus(qs("tags-status"), `Showing ${result.items.length} of ${result.total} tag(s).`);
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("tags-status"), describeError(error), true);
  } finally {
    if (!state.generation.isStale(gen)) button.disabled = false;
  }
}
qs("refresh-tags-button").addEventListener("click", refreshTags);

// ---- collections ----

function renderCollectionItem(c) {
  const details = el("details");
  details.appendChild(el("summary", { text: `Collection #${c.id} "${c.name}"` }));
  const dl = el("dl");
  dlEntry(dl, "Description", c.description ?? "—");
  dlEntry(dl, "Creator", `${c.creatorType}${c.creatorName ? ` (${c.creatorName})` : ""}`);
  dlEntry(dl, "Created at", formatTimestamp(c.createdAt));
  details.appendChild(dl);

  const itemsList = el("ul", { className: "plain-list" });
  const itemsStatus = statusElement();
  const loadItemsButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Load items")]);
  loadItemsButton.addEventListener("click", async () => {
    const gen = state.generation.snapshot();
    loadItemsButton.disabled = true;
    setStatus(itemsStatus, "Loading…");
    try {
      const { result } = await apiRequest(`/api/store.collections.items.list?collectionId=${c.id}&limit=${LIST_LIMIT}`);
      if (state.generation.isStale(gen)) return;
      clearChildren(itemsList);
      for (const item of result.items) {
        itemsList.appendChild(el("li", { text: `${item.recordType} #${item.recordId} (position ${item.position})` }));
      }
      setStatus(itemsStatus, `Showing ${result.items.length} of ${result.total} item(s).`);
    } catch (error) {
      if (state.generation.isStale(gen)) return;
      setStatus(itemsStatus, describeError(error), true);
    } finally {
      if (!state.generation.isStale(gen)) loadItemsButton.disabled = false;
    }
  });
  details.appendChild(loadItemsButton);
  details.appendChild(itemsStatus);
  details.appendChild(itemsList);

  const deleteButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Delete")]);
  const li = el("li", {}, [details, deleteButton]);
  deleteButton.addEventListener("click", () => performDelete(`/api/store.collections.delete?id=${c.id}`, `Delete collection #${c.id}?`, () => li.remove()));
  return li;
}

async function refreshCollections() {
  const button = qs("refresh-collections-button");
  const gen = state.generation.snapshot();
  button.disabled = true;
  setStatus(qs("collections-status"), "Loading…");
  try {
    const { result } = await apiRequest(`/api/store.collections.list?limit=${LIST_LIMIT}`);
    if (state.generation.isStale(gen)) return;
    const list = qs("collections-list");
    clearChildren(list);
    for (const collection of result.items) list.appendChild(renderCollectionItem(collection));
    setStatus(qs("collections-status"), `Showing ${result.items.length} of ${result.total} collection(s).`);
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("collections-status"), describeError(error), true);
  } finally {
    if (!state.generation.isStale(gen)) button.disabled = false;
  }
}
qs("refresh-collections-button").addEventListener("click", refreshCollections);

// ---- queue ----

function renderQueueItem(q) {
  const li = el("li", { text: `${q.recordType} #${q.recordId} — state: ${q.state} — creator: ${q.creatorType}${q.creatorName ? ` (${q.creatorName})` : ""}` });
  const deleteButton = el("button", { attrs: { type: "button" } }, [document.createTextNode("Delete")]);
  deleteButton.addEventListener("click", () => performDelete(`/api/store.queue.delete?id=${q.id}`, `Delete queue item #${q.id}?`, () => li.remove()));
  li.appendChild(deleteButton);
  return li;
}

async function refreshQueue() {
  const button = qs("refresh-queue-button");
  const gen = state.generation.snapshot();
  button.disabled = true;
  setStatus(qs("queue-status"), "Loading…");
  try {
    const { result } = await apiRequest(`/api/store.queue.list?limit=${LIST_LIMIT}`);
    if (state.generation.isStale(gen)) return;
    const list = qs("queue-list");
    clearChildren(list);
    for (const item of result.items) list.appendChild(renderQueueItem(item));
    setStatus(qs("queue-status"), `Showing ${result.items.length} of ${result.total} item(s).`);
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("queue-status"), describeError(error), true);
  } finally {
    if (!state.generation.isStale(gen)) button.disabled = false;
  }
}
qs("refresh-queue-button").addEventListener("click", refreshQueue);

// ---- danger zone ----

qs("clear-all-button").addEventListener("click", async () => {
  if (!window.confirm("This permanently deletes every capture and derived record from this service. Continue?")) return;
  const button = qs("clear-all-button");
  const gen = state.generation.snapshot();
  button.disabled = true;
  setStatus(qs("danger-status"), "Clearing…");
  try {
    const { result } = await apiRequest("/api/store.clear", { method: "POST" });
    if (state.generation.isStale(gen)) return;
    setStatus(qs("danger-status"), `Cleared. Removed ${result.removedBackupCount} backup file(s).`);
    await Promise.all([
      refreshCaptures(),
      refreshSummaries(),
      refreshProposals().catch(() => {}),
      refreshActions().catch(() => {}),
      refreshTags(),
      refreshCollections(),
      refreshQueue(),
    ]);
    if (state.generation.isStale(gen)) return;
    qs("detail-section").hidden = true;
    state.detailSession = null;
  } catch (error) {
    if (state.generation.isStale(gen)) return;
    setStatus(qs("danger-status"), describeError(error), true);
  } finally {
    if (!state.generation.isStale(gen)) button.disabled = false;
  }
});

// ---- startup ----

setAuthenticatedControlsEnabled(false);
pollHealth();
setInterval(pollHealth, 5000);
