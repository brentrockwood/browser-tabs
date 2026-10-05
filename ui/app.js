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
import { createDecisionTracker, createGenerationCounter, createListVersionGuard } from "./lib.mjs";

// Must match extension/protocol.js's PROTOCOL_VERSION. Duplicated here
// (not imported) because this is a standalone static page with no build
// step and no access to that module's path.
const PROTOCOL_VERSION = 2;

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

  return el("li", {}, [infoLine, titleLine, urlLine, captureButton, el("span", { text: " " }), captureStatus]);
}

function renderGroupRow(g) {
  return el("li", {
    text: `Group ${g.groupId} — title: ${g.title ?? "(none)"}, color: ${g.color ?? "(none)"}, collapsed: ${g.collapsed}`,
  });
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
    await Promise.all([refreshCaptures(), refreshSummaries(), refreshProposals().catch(() => {}), refreshTags(), refreshCollections(), refreshQueue()]);
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
