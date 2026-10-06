#!/usr/bin/env node
// Real Chrome-for-Testing smoke test for the Stage 1 local bridge.
//
// Unlike test/bridge.test.mjs (a real `ws` client standing in for the
// extension over real loopback sockets), this drives the *actual* unpacked
// extension in a real Chromium-family browser via CDP, and the *actual*
// service as a separate child process — reusing the Stage 0 CDP harness
// (test/smoke/chrome-harness.mjs) for browser launch/locate/evaluate.
//
// Proves, in order:
//   1. Pairing via chrome.storage.local (as the options page would do).
//   2. A real HTTP request -> service -> actual extension ->
//      browser.list_windows round trip.
//   2.5. The read-API routes (list_tabs, list_tab_groups with a real
//        harness-created tab group, read_tab for an ordinary/protected/
//        closed-stale/deliberately-slow-loading/best-effort-discarded tab,
//        and two-entry paginated query_history), plus a stale-session
//        rejection proof, exercised once over this connection, inline in
//        main() below.
//   2.6. The direct tab-group mutations through the real HTTP API, checked
//        against the browser's own tabs and groups: create a group around
//        two tabs with a title and color; rename/recolor it and remove its
//        title; move one tab, then tabs from another group and from no group
//        together, into it (the emptied source group disappears); ungroup
//        every tab with `groupId: null` (the group disappears); and refusals
//        that change nothing — no-op update and move, a pinned tab, tabs and
//        a group in different windows, a stale session, and a closed tab.
//   3. The connection survives past the Manifest V3 service-worker idle
//      window (default ~35s wait) thanks to the chosen Stage 1 checkpoint
//      resolution: an authenticated ping/pong heartbeat no more than 20s
//      apart (see project.md and extension/protocol.js
//      HEARTBEAT_INTERVAL_MS) — then a second request still succeeds. The
//      service worker's own CDP connection is explicitly detached and
//      closed *before* this wait begins (a live DevTools session is known
//      to keep Chrome from treating a target as idle, which would make
//      this an artifact of instrumentation rather than a real proof), and
//      is not reattached until Step 5 genuinely needs one again; the
//      persistent harness page may remain connected to read
//      chrome.alarms.getAll() (a different target, with no bearing on the
//      worker's idle timer), but never messages or wakes the worker.
//   3.5. Proof step, via that same persistent harness page: chrome.
//        alarms.getAll() must show the durable reconnect alarm registered
//        with the expected periodic schedule *before* the service goes
//        down. If it's missing, that's a product lifecycle defect; this
//        step fails explicitly rather than proceeding as if recovery
//        could work.
//   4. Stopping the service and deliberately leaving it down for at least
//      SERVICE_DOWNTIME_MS (>= the worker idle window) before restarting
//      it — long enough that the fast setTimeout retry path cannot simply
//      find the service already back up, so recovery actually exercises
//      the chrome.alarms backstop proven armed above, waking a worker
//      Chrome has in all likelihood fully terminated by then. The
//      recovery wait is sized to Chrome's documented alarm-frequency floor
//      (RECONNECT_ALARM_DELAY_MINUTES in extension/protocol.js) plus
//      margin, but that floor is not a worst-case guarantee — Chrome may
//      delay alarm delivery further — so this is a generous *test*
//      timeout, not a claimed product bound. Still no CDP connection to
//      the worker is held or reattached anywhere in this step; recovery
//      is judged solely through /health and a real HTTP request. If
//      recovery still fails, the error re-checks chrome.alarms.getAll()
//      to tell apart "alarm missing" (product bug) from "alarm registered
//      but not delivered" (a transport question Chrome's alarm-wake
//      mechanism itself didn't honor) — never reported as a pass either
//      way.
//   5. A full *browser* restart (not chrome.runtime.reload()): on Chrome
//      for Testing, reload() removes the command-line-loaded unpacked
//      extension and leaves chrome-error pages behind — an environment
//      artifact of how --load-extension interacts with reload(), not a
//      meaningful recovery test. What the project actually documents is
//      recovery across a browser restart, so Chrome is terminated cleanly
//      and relaunched with the *same* --user-data-dir (so
//      chrome.storage.local, and so the pairing token, persists) and the
//      same staged extension path while the service keeps running. The
//      extension must reconnect using the persisted token — no
//      re-pairing — proven via an authenticated browser.list_windows
//      request, not merely CDP visibility. browserSessionId must also
//      rotate (chrome.storage.session is cleared by the browser restart);
//      the pre-restart session id must then be rejected as stale_session
//      against an otherwise-valid post-restart handle — by a read and by a
//      mutation, which changes nothing — and the new session id must still
//      work.
//   6. A real (non-extension) browser page's WebSocket attempt to the
//      service's /extension endpoint is rejected — the real browser sets
//      the Origin header here, not a spoofed one.
//
// Usage: npm run test:smoke:bridge
//
// Env (same CHROME_PATH/SMOKE_HEADLESS as test:smoke, plus):
//   STAGE1_IDLE_WAIT_MS  override the MV3-idle-window wait (default 35000).
//                        Shorter values speed up local iteration but weaken
//                        the idle-survival proof; do not lower it for the
//                        check that actually gates the project.md checkpoint.
//
// Exit codes: 0 pass, 1 product assertion failed, 2 infrastructure blocker
// (same convention as test:smoke; see that file's header for rationale).
//
// Total runtime is roughly 2-3 minutes (not seconds), dominated by the idle
// wait plus the service-restart recovery wait below; this is a deliberate
// trade-off to prove real recovery bounds rather than assume a faster one.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SERVICE_PORT,
  ERROR_CODES,
  PROTOCOL_VERSION,
  RECONNECT_ALARM_DELAY_MINUTES,
  RECONNECT_ALARM_NAME,
} from "../../extension/protocol.js";
import {
  closeFixtureServer,
  connectCdp,
  createAndWaitForTab,
  evaluate,
  findChromeExecutable,
  findExtensionServiceWorker,
  findPageTarget,
  launchChrome,
  startFixtureServer,
  stageExtension,
  terminateChrome,
  waitForChromeReady,
} from "./chrome-harness.mjs";

const EXTENSION_SOURCE_PATH = fileURLToPath(new URL("../../extension/", import.meta.url));
const HARNESS_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/smoke-harness.html", import.meta.url));
const SERVICE_CLI_PATH = fileURLToPath(new URL("../../service/cli.mjs", import.meta.url));
const IDLE_WAIT_MS = Number(process.env.STAGE1_IDLE_WAIT_MS) || 35_000;
const RECONNECT_WAIT_MS = 20_000;
// How long the service is deliberately left down before Step 4 restarts
// it — long enough to exceed both the MV3 worker idle window and the fast
// setTimeout retry schedule's useful lifetime, so recovery actually
// exercises the chrome.alarms backstop rather than the fast path finding
// the service already back up. Floored at 35s per the documented worker
// idle window; does not scale with RECONNECT_ALARM_DELAY_MINUTES, since
// its purpose is the *downtime*, not the alarm's own period.
const SERVICE_DOWNTIME_MS = Math.max(35_000, IDLE_WAIT_MS);
// Bounds (but does not guarantee — see RECONNECT_ALARM_DELAY_MINUTES in
// extension/protocol.js: Chrome's floor is not a worst-case promise, and
// alarms may be delayed further) recovery after the service comes back.
// This is a generous *test* timeout, not a documented product SLA.
const SERVICE_RESTART_RECOVERY_WAIT_MS = RECONNECT_ALARM_DELAY_MINUTES * 60_000 + 45_000;
const DIAGNOSTICS_LIMIT = 20;
const PROTECTED_URL = "chrome://version/";
// Stages the same test-only harness page Stage 0 uses, so this test also
// has a *persistent* extension page available — one that is not subject to
// the service worker's own suspend/terminate lifecycle — purely to observe
// chrome.alarms state from outside the worker. It must never be used to
// create the alarm itself or to nudge/reconnect the product client; see
// the read-only `chrome.alarms.getAll()` calls below.
async function stageExtensionWithHarness(stagingRoot) {
  const stagingDir = await stageExtension(EXTENSION_SOURCE_PATH, stagingRoot);
  const harnessHtml = await readFile(HARNESS_FIXTURE_PATH, "utf8");
  await writeFile(join(stagingDir, "smoke-harness.html"), harnessHtml, "utf8");
  return stagingDir;
}

// A fixture server that deliberately holds its response open for
// `delayMs`, so a tab pointed at it is still genuinely "loading" (not
// merely assumed to be) at the moment read_tab is called against it —
// test scaffolding only, not a product mutation.
function startSlowFixtureServer(delayMs = 4000) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.write("<html><body>loading...");
      setTimeout(() => {
        res.end("<p>done</p></body></html>");
      }, delayMs);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function fail(message) {
  console.error(`SMOKE_FAIL: ${message}`);
  process.exitCode = 1;
}

function blocked(message) {
  console.error(`SMOKE_BLOCKED: ${message}`);
  process.exitCode = 2;
}

// The extension's WebSocket target is a fixed source-level constant (see
// extension/service-client.js) — it cannot be pointed at an arbitrary port
// at runtime. This test must therefore run the real service on that exact
// port, not an arbitrary/ephemeral one, or the real extension will never
// even attempt to reach it (connection refused, indistinguishable from
// "never connected" without the diagnostics added below).
function isPortFree(port, host = "127.0.0.1", timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const finish = (free) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(free);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(false)); // something is already listening
    socket.once("timeout", () => finish(true));
    socket.once("error", (error) => finish(error.code === "ECONNREFUSED"));
  });
}

// Bounded (capped, ring-buffer-like) capture of a service worker's console
// output and uncaught exceptions over CDP, so a connection-wait failure can
// be classified (e.g. "never paired", "auth rejected", "threw on startup")
// instead of only showing a final timeout. Requires Runtime.enable, which
// findExtensionServiceWorker already does on the connections this is used
// with.
function attachDiagnostics(cdp, store) {
  function record(entry) {
    store.push({ ...entry, timestamp: Date.now() });
    if (store.length > 200) store.shift();
  }
  const offConsole = cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args || []).map((arg) => arg.value ?? arg.description ?? String(arg)).join(" ");
    record({ kind: `console.${params.type}`, text });
  });
  const offException = cdp.on("Runtime.exceptionThrown", (params) => {
    const detail = params.exceptionDetails;
    const text = detail?.exception?.description || detail?.text || JSON.stringify(detail);
    record({ kind: "exception", text });
  });
  return () => {
    offConsole();
    offException();
  };
}

function formatDiagnostics(store) {
  if (store.length === 0) return "  (no service worker console output or exceptions were captured)";
  return store
    .slice(-DIAGNOSTICS_LIMIT)
    .map((entry) => `  [${new Date(entry.timestamp).toISOString()}] [${entry.kind}] ${entry.text}`)
    .join("\n");
}

async function readClientState(cdp) {
  if (!cdp) return "(no service worker CDP connection available)";
  try {
    return await evaluate(
      cdp,
      "(typeof globalThis.__browserTabsServiceClientState === 'function') ? globalThis.__browserTabsServiceClientState() : 'unavailable (diagnostic hook missing)'",
    );
  } catch (error) {
    return `(failed to read client state: ${error instanceof Error ? error.message : String(error)})`;
  }
}

// Diagnostic-only hook (extension/service-worker.js's
// `globalThis.__browserTabsSessionId`), used here to learn the real
// browserSessionId a client would otherwise have to obtain via a prior
// list_windows call — and, after a browser restart, to
// prove it actually rotated (project.md Stage 2 remediation).
async function readSessionId(swCdp) {
  const value = await evaluate(
    swCdp,
    "(typeof globalThis.__browserTabsSessionId === 'function') ? globalThis.__browserTabsSessionId() : null",
  );
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`could not read a valid browserSessionId via the diagnostic hook; got: ${JSON.stringify(value)}`);
  }
  return value;
}

// Wraps waitUntilExtensionConnected so a failure's error message includes
// the extension's own reported connection state and recent service worker
// console/exception output, not just "it never reported connected".
async function waitUntilExtensionConnectedOrDiagnose(port, timeoutMs, getCdp, diagnosticsStore) {
  try {
    return await waitUntilExtensionConnected(port, timeoutMs);
  } catch (error) {
    const clientState = await readClientState(getCdp());
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `extension service-client state: ${clientState}\n` +
        `recent service worker console/exceptions (last ${DIAGNOSTICS_LIMIT}):\n${formatDiagnostics(diagnosticsStore)}`,
    );
  }
}

// Read-only: queries chrome.alarms.getAll() from the persistent harness
// page (not the service worker, and not by creating/touching an alarm
// itself) so the alarm registry — which Chrome keeps for the extension,
// independent of any single worker incarnation — can be inspected even
// when the worker's own CDP target is unavailable.
async function readAlarmsViaHarness(harnessPageCdp) {
  return evaluate(harnessPageCdp, "chrome.alarms.getAll()");
}

function findReconnectAlarm(alarms) {
  return Array.isArray(alarms) ? alarms.find((alarm) => alarm.name === RECONNECT_ALARM_NAME) : undefined;
}

// Same purpose as waitUntilExtensionConnectedOrDiagnose, but specific to
// the service-restart recovery wait: on failure it also captures
// chrome.alarms.getAll() via the harness page and explicitly classifies
// what that means, rather than reporting one undifferentiated timeout.
// - Alarm present: Chrome has the durable reconnect alarm registered, but
//   evidently did not deliver it (or deliver it in time) to wake/reconnect
//   the worker — this points at alarm-delivery/worker-wake *transport*,
//   not the extension's own alarm lifecycle. Never reported as a pass.
// - Alarm missing: the extension itself failed to (re-)arm or kept
//   clearing it — a product lifecycle bug in
//   extension/service-client.js's scheduleRetryAlarm/clearRetryAlarm.
async function waitForServiceRestartRecoveryOrDiagnose(port, timeoutMs, getCdp, diagnosticsStore, harnessPageCdp) {
  try {
    return await waitUntilExtensionConnected(port, timeoutMs);
  } catch (error) {
    const clientState = await readClientState(getCdp());
    let alarmsSnapshot;
    try {
      alarmsSnapshot = await readAlarmsViaHarness(harnessPageCdp);
    } catch (alarmsError) {
      alarmsSnapshot = `(failed to read chrome.alarms.getAll() via the harness page: ${
        alarmsError instanceof Error ? alarmsError.message : String(alarmsError)
      })`;
    }
    const reconnectAlarm = Array.isArray(alarmsSnapshot) ? findReconnectAlarm(alarmsSnapshot) : undefined;
    const classification = Array.isArray(alarmsSnapshot)
      ? reconnectAlarm
        ? "The durable reconnect alarm IS still registered with chrome.alarms; Chrome evidently did not deliver " +
          "it (or deliver it in time) to wake/reconnect the worker. This points at alarm-delivery/worker-wake " +
          "transport, not the extension's own alarm lifecycle — treat this as a real failure, not a pass, and use " +
          "it to decide on a transport change."
        : "The durable reconnect alarm is MISSING from chrome.alarms.getAll(); this points at the extension's own " +
          "alarm lifecycle (scheduleRetryAlarm/clearRetryAlarm in extension/service-client.js), not Chrome's " +
          "alarm-delivery transport."
      : "Could not determine whether the alarm was registered (see error above).";
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n` +
        `extension service-client state: ${clientState}\n` +
        `chrome.alarms.getAll() via the persistent harness page: ${JSON.stringify(alarmsSnapshot)}\n` +
        `classification: ${classification}\n` +
        `recent service worker console/exceptions (last ${DIAGNOSTICS_LIMIT}):\n${formatDiagnostics(diagnosticsStore)}`,
    );
  }
}

function spawnService(dataDir, port) {
  const child = spawn(process.execPath, [SERVICE_CLI_PATH, "start"], {
    env: { ...process.env, BROWSER_TABS_DATA_DIR: dataDir, BROWSER_TABS_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, getStdout: () => stdout, getStderr: () => stderr };
}

async function stopServiceChild(service) {
  if (!service || service.child.exitCode !== null || service.child.signalCode !== null) return;
  service.child.kill("SIGTERM");
  await Promise.race([service.exited, delay(5000)]);
  if (service.child.exitCode === null && service.child.signalCode === null) service.child.kill("SIGKILL");
}

async function waitForToken(service, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = /Pairing token \(paste into the extension's options page\): ([0-9a-f]{64})/.exec(service.getStdout());
    if (match) return match[1];
    const { exited } = await Promise.race([
      service.exited.then((result) => ({ exited: result })),
      delay(100).then(() => ({ exited: null })),
    ]);
    if (exited) {
      throw new Error(
        `service process exited (code ${exited.code}, signal ${exited.signal}) before printing a pairing token. ` +
          `stdout: ${service.getStdout()} stderr: ${service.getStderr()}`,
      );
    }
  }
  throw new Error(`did not see a pairing token printed within ${timeoutMs}ms. stdout so far: ${service.getStdout()}`);
}

// `body`, when given, is JSON-encoded and written before `end()` — used by
// the mutation proofs below (POST routes).
function serviceRequest(port, path, { method = "GET", token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "x-protocol-version": String(PROTOCOL_VERSION), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port, path, method, headers, timeout: 3000 }, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => (responseBody += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(responseBody) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timed out waiting for the service")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function waitForHealth(port, timeoutMs = 8000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return await serviceRequest(port, "/health");
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }
  throw new Error(`service on port ${port} never answered /health: ${lastError?.message}`);
}

async function waitUntilExtensionConnected(port, timeoutMs) {
  const start = Date.now();
  let lastBody;
  while (Date.now() - start < timeoutMs) {
    try {
      const { json } = await serviceRequest(port, "/health");
      lastBody = json;
      if (json?.extension?.connected) return json;
    } catch {
      // The service may be mid-restart; keep polling.
    }
    await delay(250);
  }
  throw new Error(`extension did not report connected within ${timeoutMs}ms (last /health: ${JSON.stringify(lastBody)})`);
}

async function expectListWindows(port, token, label) {
  const { status, json } = await serviceRequest(port, "/api/browser.list_windows", { token });
  if (status !== 200) {
    throw new Error(`[${label}] expected 200 from browser.list_windows, got ${status}: ${JSON.stringify(json)}`);
  }
  const result = json.result;
  if (result?.status !== "ok" || !Array.isArray(result.windows) || result.windows.length === 0) {
    throw new Error(`[${label}] browser.list_windows returned no windows: ${JSON.stringify(result)}`);
  }
  for (const key of ["windowId", "focused", "type", "state", "tabCount"]) {
    if (!(key in result.windows[0])) {
      throw new Error(`[${label}] window entry missing "${key}": ${JSON.stringify(result.windows[0])}`);
    }
  }
  for (const key of ["browserSessionId", "sourceOperation", "capturedAt"]) {
    if (!(key in result)) {
      throw new Error(`[${label}] browser.list_windows result missing capture-provenance field "${key}": ${JSON.stringify(result)}`);
    }
  }
  return result.windows;
}

// Read-API proofs, exercised once over a proven connection (see "Step 2.5"
// below) — deliberately kept separate from the idle/restart resilience
// steps, which exist to prove the *transport*, not these routes.
function assertProvenance(label, result) {
  for (const key of ["schemaVersion", "browserSessionId", "sourceOperation", "capturedAt", "status"]) {
    if (!(key in result)) throw new Error(`[${label}] result missing capture-provenance field "${key}": ${JSON.stringify(result)}`);
  }
  if (typeof result.browserSessionId !== "string" || result.browserSessionId.length === 0) {
    throw new Error(`[${label}] browserSessionId must be a non-empty string: ${JSON.stringify(result)}`);
  }
}

async function expectListTabsIncludes(port, token, sessionId, windowId, expectedTabId) {
  const { status, json } = await serviceRequest(port, `/api/browser.list_tabs?windowId=${windowId}&browserSessionId=${sessionId}`, { token });
  const result = json?.result;
  if (status !== 200 || result?.status !== "ok" || !Array.isArray(result.tabs)) {
    throw new Error(`browser.list_tabs did not return an ok result: ${status} ${JSON.stringify(json)}`);
  }
  assertProvenance("browser.list_tabs", result);
  if (!result.tabs.some((tab) => tab.tabId === expectedTabId)) {
    throw new Error(`browser.list_tabs did not include tab ${expectedTabId}: ${JSON.stringify(result.tabs)}`);
  }
}

async function expectListTabsStaleSession(port, token, staleSessionId, windowId) {
  const { status, json } = await serviceRequest(
    port,
    `/api/browser.list_tabs?windowId=${windowId}&browserSessionId=${staleSessionId}`,
    { token },
  );
  const result = json?.result;
  if (status !== 200 || result?.status !== "error" || result?.code !== ERROR_CODES.STALE_SESSION) {
    throw new Error(`browser.list_tabs with a stale session did not reject it explicitly: ${status} ${JSON.stringify(json)}`);
  }
}

async function expectListTabGroups(port, token, sessionId, windowId, { supported }) {
  const { status, json } = await serviceRequest(port, `/api/browser.list_tab_groups?windowId=${windowId}&browserSessionId=${sessionId}`, {
    token,
  });
  const result = json?.result;
  if (status !== 200) {
    throw new Error(`browser.list_tab_groups returned HTTP ${status}: ${JSON.stringify(json)}`);
  }
  assertProvenance("browser.list_tab_groups", result);
  if (supported) {
    if (result?.status !== "ok" || !Array.isArray(result.groups)) {
      throw new Error(`browser.list_tab_groups (capability reported as supported) did not return an ok result: ${JSON.stringify(result)}`);
    }
  } else if (result?.status !== "unsupported" || result?.code !== ERROR_CODES.UNSUPPORTED_FEATURE) {
    throw new Error(
      `browser.list_tab_groups (capability reported as unsupported) did not report the capability explicitly: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

async function expectReadTabOk(port, token, sessionId, tabId) {
  const { status, json } = await serviceRequest(port, `/api/browser.read_tab?tabId=${tabId}&browserSessionId=${sessionId}`, { token });
  const result = json?.result;
  if (status !== 200 || result?.status !== "ok" || typeof result.text !== "string") {
    throw new Error(`browser.read_tab (ordinary page) did not return an ok snapshot: ${status} ${JSON.stringify(json)}`);
  }
  assertProvenance("browser.read_tab", result);
  for (const key of ["url", "title", "documentReadyState", "characterCount", "returnedCharacterCount", "truncated", "windowId"]) {
    if (!(key in result)) throw new Error(`browser.read_tab result missing "${key}": ${JSON.stringify(result)}`);
  }
  return result;
}

async function expectReadTabProtected(port, token, sessionId, tabId) {
  const { status, json } = await serviceRequest(port, `/api/browser.read_tab?tabId=${tabId}&browserSessionId=${sessionId}`, { token });
  const result = json?.result;
  if (status !== 200 || result?.status !== "unsupported" || result?.code !== ERROR_CODES.INJECTION_REJECTED) {
    throw new Error(`browser.read_tab (protected page) did not report the expected unsupported outcome: ${status} ${JSON.stringify(json)}`);
  }
}

// Proves that a closed tab's handle is explicitly rejected rather than
// silently retargeted (project.md Stage 2: "Reject stale tab and window
// handles rather than silently targeting a replacement").
async function expectReadTabStale(port, token, sessionId, tabId) {
  const { status, json } = await serviceRequest(port, `/api/browser.read_tab?tabId=${tabId}&browserSessionId=${sessionId}`, { token });
  const result = json?.result;
  if (status !== 200 || result?.status !== "error" || result?.code !== ERROR_CODES.STALE_HANDLE) {
    throw new Error(`browser.read_tab (closed tab) did not reject the stale handle explicitly: ${status} ${JSON.stringify(json)}`);
  }
}

// A tab still mid-navigation is caught before injection is even attempted
// (tabs.get's own `status: "loading"`) and must report this exact,
// deterministic outcome — not any explicit-but-unspecified one — since
// readTab no longer calls scripting.executeScript (which could otherwise
// block for the remainder of the page load, past the service's own HTTP
// request timeout) against it at all.
async function expectReadTabLoading(port, token, sessionId, tabId) {
  const { status, json } = await serviceRequest(port, `/api/browser.read_tab?tabId=${tabId}&browserSessionId=${sessionId}`, { token });
  const result = json?.result;
  if (status !== 200 || result?.status !== "not_ready" || result?.code !== ERROR_CODES.TAB_LOADING) {
    throw new Error(`browser.read_tab (loading page) did not report the expected tab_loading outcome: ${status} ${JSON.stringify(json)}`);
  }
  assertProvenance("browser.read_tab (loading page)", result);
  return result;
}

// Returns the outcome (whatever it is) rather than asserting a single
// expected value, since the browser does not guarantee discarding a given
// tab on request. The caller must still get back an explicit, well-formed,
// recognized outcome — never an undefined/garbage shape — per project.md
// Stage 2's "supported/unsupported/not-ready, never merely informational"
// remediation.
async function expectReadTabExplicitOutcome(port, token, sessionId, tabId, label) {
  const { status, json } = await serviceRequest(port, `/api/browser.read_tab?tabId=${tabId}&browserSessionId=${sessionId}`, { token });
  const result = json?.result;
  if (status !== 200) throw new Error(`[${label}] browser.read_tab returned HTTP ${status}: ${JSON.stringify(json)}`);
  assertProvenance(label, result);
  if (!["ok", "unsupported", "not_ready", "error"].includes(result.status)) {
    throw new Error(`[${label}] browser.read_tab returned an unrecognized status: ${JSON.stringify(result)}`);
  }
  if (result.status !== "ok" && !(typeof result.code === "string" && result.code.length > 0)) {
    throw new Error(`[${label}] a non-ok browser.read_tab result must carry a non-empty code: ${JSON.stringify(result)}`);
  }
  return result;
}

async function expectHistoryPage(port, token, { startTime, endTime, maxResults, cursor }) {
  const cursorParam = cursor === undefined ? "" : `&cursor=${cursor}`;
  const { status, json } = await serviceRequest(
    port,
    `/api/browser.query_history?startTime=${startTime}&endTime=${endTime}&maxResults=${maxResults}${cursorParam}`,
    { token },
  );
  const result = json?.result;
  if (status !== 200 || result?.status !== "ok" || !Array.isArray(result.entries)) {
    throw new Error(`browser.query_history did not return an ok, bounded result: ${status} ${JSON.stringify(json)}`);
  }
  assertProvenance("browser.query_history", result);
  if (result.entries.length > maxResults) {
    throw new Error(`browser.query_history returned more than the requested maxResults: ${JSON.stringify(result)}`);
  }
  for (const key of ["returnedCount", "truncated", "nextCursor"]) {
    if (!(key in result)) throw new Error(`browser.query_history result missing "${key}": ${JSON.stringify(result)}`);
  }
  return result;
}

async function connectCdpForPage(webSocketDebuggerUrl) {
  const cdp = await connectCdp(webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  return cdp;
}

async function main() {
  if (typeof WebSocket !== "function") {
    blocked(
      "this script requires Node.js's native WebSocket client (stable since Node.js 22); " +
        `current runtime is Node.js ${process.version}.`,
    );
    return;
  }

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    blocked(
      "no Chromium executable auto-detected, and CHROME_PATH is not set. See README for supported browsers " +
        "(Chrome for Testing is the canonical target; open-source Chromium is also auto-detected).",
    );
    return;
  }

  // Fixed, not arbitrary: the real extension can only ever dial this exact
  // port (extension/service-client.js), so the test service must run on it.
  const port = DEFAULT_SERVICE_PORT;
  if (!(await isPortFree(port))) {
    blocked(
      `port ${port} (the fixed Stage 1 default) is already in use by something else, so this test cannot tell ` +
        'whether the real extension would reach it. Stop whatever is using it (e.g. "npm run service -- stop" ' +
        "if a service is already running) and re-run.",
    );
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), "browser-tabs-stage1-smoke-"));
  const userDataDir = join(workDir, "profile");
  const serviceDataDir = join(workDir, "service-data");
  const stagingDir = await stageExtensionWithHarness(workDir);
  const manifest = JSON.parse(await readFile(join(stagingDir, "manifest.json"), "utf8"));
  const expectedExtensionName = manifest.name;

  let service;
  let fixtureServer;
  let chrome;
  let chromeExitedEarly;
  let swCdp;
  let detachDiagnostics = () => {};
  const diagnostics = [];
  let fixturePageCdp;
  let fixtureTabId;
  let harnessPageCdp;
  let cdpPort;

  try {
    // Created once, up front, so it is available for Step 2.5's ordinary-
    // page read_tab proof as well as Step 6's Origin-rejection proof after
    // the browser restart; only the browser *tab* pointed at it needs to be
    // recreated after a restart, not the Node HTTP server itself.
    fixtureServer = await startFixtureServer();
    const fixturePort = fixtureServer.address().port;
    const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

    service = spawnService(serviceDataDir, port);
    const token = await waitForToken(service);
    await waitForHealth(port);

    const headless = process.env.SMOKE_HEADLESS !== "false";
    const launched = launchChrome(chromePath, { userDataDir, stagingDir, headless });
    chrome = launched.chrome;
    chromeExitedEarly = launched.exitedEarly;

    const portOrExitOrError = await waitForChromeReady(launched, userDataDir);
    if ("spawnError" in portOrExitOrError) {
      blocked(`Failed to launch "${chromePath}": ${portOrExitOrError.spawnError.message}`);
      return;
    }
    if ("exitCode" in portOrExitOrError) {
      blocked(
        `Chrome exited before opening a DevTools port (exit code ${portOrExitOrError.exitCode}). ` +
          `Stderr: ${launched.getStderr().trim().slice(0, 2000)}`,
      );
      return;
    }
    ({ port: cdpPort } = portOrExitOrError);

    let found;
    try {
      found = await findExtensionServiceWorker(cdpPort, expectedExtensionName);
    } catch (error) {
      fail(`could not locate the extension's service worker: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    swCdp = found.cdp;
    detachDiagnostics = attachDiagnostics(swCdp, diagnostics);

    // Open the persistent harness page used purely as a read-only vantage
    // point for chrome.alarms.getAll() (see waitForServiceRestartRecovery-
    // OrDiagnose and the pre-restart assertion below). It never creates an
    // alarm, calls into the service client, or touches storage itself.
    const extensionId = new URL(found.target.url).hostname;
    const harnessUrl = `chrome-extension://${extensionId}/smoke-harness.html`;
    await createAndWaitForTab(swCdp, harnessUrl);
    const harnessPageTarget = await findPageTarget(cdpPort, harnessUrl);
    harnessPageCdp = await connectCdpForPage(harnessPageTarget.webSocketDebuggerUrl);

    // Step 1: pair via chrome.storage.local, exactly as the options page
    // would (service-client.js reacts to storage.onChanged, not to a
    // manual nudge from this script).
    await evaluate(swCdp, `chrome.storage.local.set(${JSON.stringify({ serviceToken: token })})`);
    await waitUntilExtensionConnectedOrDiagnose(port, RECONNECT_WAIT_MS, () => swCdp, diagnostics);

    // Step 2: a real HTTP request -> service -> actual extension ->
    // browser.list_windows round trip.
    const windows = await expectListWindows(port, token, "initial request");
    const targetWindowId = windows[0].windowId;

    // Step 2.5: Stage 2 read-API routes, exercised once over this proven
    // connection — deliberately kept separate from the idle/restart
    // resilience steps below, which exist to prove Stage 1's transport
    // specifically, not these routes.
    console.log("exercising the read-API routes (tabs, groups, read_tab, history)...");
    const sessionId = await readSessionId(swCdp);
    const initialGroups = await serviceRequest(
      port,
      `/api/browser.list_tab_groups?windowId=${targetWindowId}&browserSessionId=${sessionId}`,
      { token },
    );
    const tabGroupsSupported = initialGroups.json?.result?.status === "ok";

    const stage2Tab = await createAndWaitForTab(swCdp, fixtureUrl);
    const protectedTab = await createAndWaitForTab(swCdp, PROTECTED_URL);

    await expectListTabsIncludes(port, token, sessionId, targetWindowId, stage2Tab.id);

    // Stale session: the same, still-open, still-valid windowId must be
    // rejected explicitly when paired with a session id that is not the
    // current one — before any numeric handle is even considered.
    await expectListTabsStaleSession(port, token, "not-the-real-session", targetWindowId);

    // Real tab-group scaffolding (harness mutation, not a product
    // operation): create an actual group so the listing has something
    // non-empty to find, when this browser supports tab groups at all.
    if (tabGroupsSupported) {
      const groupTab = await createAndWaitForTab(swCdp, fixtureUrl);
      const groupId = await evaluate(
        swCdp,
        `(async () => {
          const id = await chrome.tabs.group({ tabIds: [${JSON.stringify(groupTab.id)}] });
          await chrome.tabGroups.update(id, { title: "smoke-test-group" });
          return id;
        })()`,
      );
      const groupsResult = await expectListTabGroups(port, token, sessionId, targetWindowId, { supported: true });
      if (!groupsResult.groups.some((group) => group.groupId === groupId)) {
        fail(`browser.list_tab_groups did not include the harness-created group ${groupId}: ${JSON.stringify(groupsResult.groups)}`);
        return;
      }
      await evaluate(swCdp, `chrome.tabs.ungroup(${JSON.stringify(groupTab.id)})`).catch(() => {});
      await evaluate(swCdp, `chrome.tabs.remove(${JSON.stringify(groupTab.id)})`).catch(() => {});
    } else {
      await expectListTabGroups(port, token, sessionId, targetWindowId, { supported: false });
      console.log("this browser reports tab groups unsupported; skipping the real-group listing proof.");
    }

    await expectReadTabOk(port, token, sessionId, stage2Tab.id);
    await expectReadTabProtected(port, token, sessionId, protectedTab.id);

    // Stale handle: close the tab, then confirm the handle is explicitly
    // rejected rather than silently retargeted (project.md Stage 2).
    await evaluate(swCdp, `chrome.tabs.remove(${JSON.stringify(stage2Tab.id)})`);
    await expectReadTabStale(port, token, sessionId, stage2Tab.id);
    await evaluate(swCdp, `chrome.tabs.remove(${JSON.stringify(protectedTab.id)})`).catch(() => {});

    // Deliberately slow-loading page: a fixture server that holds the
    // response open past the point read_tab is called, so the tab is
    // genuinely still loading when queried, and the explicit result (not a
    // guess) is asserted.
    const slowServer = await startSlowFixtureServer();
    try {
      const slowPort = slowServer.address().port;
      const slowUrl = `http://127.0.0.1:${slowPort}/`;
      const slowTab = await evaluate(swCdp, `chrome.tabs.create(${JSON.stringify({ url: slowUrl, active: false })})`);
      const loadingResult = await expectReadTabLoading(port, token, sessionId, slowTab.id);
      console.log(`slow-loading page read_tab outcome: status=${loadingResult.status}, code=${loadingResult.code}`);
      await evaluate(swCdp, `chrome.tabs.remove(${JSON.stringify(slowTab.id)})`).catch(() => {});
    } finally {
      await closeFixtureServer(slowServer);
    }

    // Discarded tab: Chrome does not guarantee discarding a given tab on
    // request (e.g. it may refuse to discard a very recently created or
    // focused tab), so only the *request to discard* is treated as
    // best-effort and caught below. Once a discard is actually confirmed,
    // the resulting read_tab outcome is asserted unguarded (outside any
    // catch): a malformed or failed outcome at that point is a real product
    // failure, not an infrastructure hiccup, and must fail this smoke test
    // rather than being logged as "non-fatal" and silently passed over.
    let discardTab;
    let discardConfirmed = false;
    try {
      discardTab = await createAndWaitForTab(swCdp, fixtureUrl);
      const discarded = await evaluate(
        swCdp,
        `(async () => { try { return await chrome.tabs.discard(${JSON.stringify(discardTab.id)}); } catch (error) { return null; } })()`,
      );
      discardConfirmed = Boolean(discarded && discarded.discarded);
    } catch (error) {
      console.log(`unable to request/confirm discard (non-fatal): ${error instanceof Error ? error.message : String(error)}`);
    }

    if (discardConfirmed) {
      const discardedResult = await expectReadTabExplicitOutcome(port, token, sessionId, discardTab.id, "discarded tab");
      console.log(`discarded-tab read_tab outcome: status=${discardedResult.status}`);
    } else {
      console.log("the browser did not discard the tab on request (or the request/confirmation itself failed); skipping the discarded-tab read_tab assertion.");
    }
    if (discardTab) await evaluate(swCdp, `chrome.tabs.remove(${JSON.stringify(discardTab.id)})`).catch(() => {});

    {
      // Harness mutation (test setup only, not a product operation):
      // deterministically create at least two distinct history entries so
      // pagination has something real to page through, then page through
      // them one at a time via the offset cursor.
      const now = Date.now();
      const historyUrls = [`${fixtureUrl}?smoke-history=1`, `${fixtureUrl}?smoke-history=2`];
      for (const url of historyUrls) {
        await evaluate(swCdp, `chrome.history.addUrl({ url: ${JSON.stringify(url)} })`);
      }
      try {
        const firstPage = await expectHistoryPage(port, token, { startTime: 0, endTime: now + 60_000, maxResults: 1 });
        if (firstPage.entries.length !== 1 || firstPage.nextCursor === null) {
          fail(`expected a single-entry first history page with a further page available: ${JSON.stringify(firstPage)}`);
          return;
        }
        const secondPage = await expectHistoryPage(port, token, {
          startTime: 0,
          endTime: now + 60_000,
          maxResults: 1,
          cursor: firstPage.nextCursor,
        });
        if (secondPage.entries.length !== 1 || secondPage.entries[0].url === firstPage.entries[0].url) {
          fail(`expected the second history page to return a different entry than the first: ${JSON.stringify({ firstPage, secondPage })}`);
          return;
        }
      } finally {
        for (const url of historyUrls) {
          await evaluate(swCdp, `chrome.history.deleteUrl({ url: ${JSON.stringify(url)} })`).catch(() => {});
        }
      }
    }

    // Step 2.6: the direct tab-group mutations, through the real HTTP API
    // against the real browser. Every claim below is checked against the
    // browser's own state (chrome.tabs/chrome.tabGroups from the service
    // worker), never only against what the service says. A browser without
    // tab groups must instead answer unsupported with changed: false.
    console.log("exercising the direct tab-group mutations (create, update, move, ungroup, refusals)...");
    {
      const mutate = (method, body) => serviceRequest(port, `/api/${method}`, { method: "POST", token, body: { browserSessionId: sessionId, ...body } });
      const realTab = (tabId) =>
        evaluate(swCdp, `chrome.tabs.get(${JSON.stringify(tabId)}).then((t) => ({ groupId: t.groupId ?? -1, windowId: t.windowId, pinned: t.pinned }))`);
      const realGroup = (groupId) =>
        evaluate(swCdp, `chrome.tabGroups.get(${JSON.stringify(groupId)}).then((g) => ({ title: g.title, color: g.color, windowId: g.windowId }), () => null)`);
      const check = (condition, message) => {
        if (!condition) fail(`[mutations] ${message}`);
        return Boolean(condition);
      };
      const expectOk = async (label, method, body) => {
        const response = await mutate(method, body);
        const result = response.json?.result;
        const ok = response.status === 200 && result?.status === "ok" && result.changed === true;
        return check(ok, `${label}: expected an ok, changed result, got ${response.status} ${JSON.stringify(response.json)}`) ? result : null;
      };
      const expectRefused = async (label, method, body, code) => {
        const response = await mutate(method, body);
        const result = response.json?.result;
        return check(
          response.status === 200 && result?.status !== "ok" && result?.changed === false && result?.code === code,
          `${label}: expected a ${code} refusal with changed: false, got ${response.status} ${JSON.stringify(response.json)}`,
        );
      };
      const tabsToClose = [];
      let otherWindowId = null;
      try {
        if (!tabGroupsSupported) {
          const tab = await createAndWaitForTab(swCdp, `${fixtureUrl}?smoke-mutation=unsupported`);
          tabsToClose.push(tab.id);
          const response = await mutate("browser.create_tab_group", { tabIds: [tab.id] });
          if (!check(response.json?.result?.status === "unsupported" && response.json.result.changed === false, `create on a browser without tab groups: ${JSON.stringify(response.json)}`)) return;
          console.log("this browser reports no tab groups; the mutation answered unsupported and changed nothing.");
        } else {
          const tabs = [];
          for (const name of ["a", "b", "c", "d", "e"]) {
            const tab = await createAndWaitForTab(swCdp, `${fixtureUrl}?smoke-mutation=${name}`);
            tabs.push(tab);
            tabsToClose.push(tab.id);
          }
          const [a, b, c, d, e] = tabs;

          // Create: one request groups exactly the requested tabs, in their window, with the requested metadata.
          const created = await expectOk("create", "browser.create_tab_group", { tabIds: [a.id, b.id], title: "smoke-created", color: "orange" });
          if (!created) return;
          const groupId = created.group.groupId;
          const realCreated = await realGroup(groupId);
          if (!check(realCreated?.title === "smoke-created" && realCreated.color === "orange" && realCreated.windowId === a.windowId, `the created group differs from the browser's: ${JSON.stringify(realCreated)}`)) return;
          if (!check((await realTab(a.id)).groupId === groupId && (await realTab(b.id)).groupId === groupId, "the requested tabs are not in the new group")) return;
          if (!check((await realTab(c.id)).groupId === -1, "a tab that was not requested was grouped")) return;
          // A caller discovers a group's tabs from browser.list_tabs.
          const listed = await serviceRequest(port, `/api/browser.list_tabs?windowId=${a.windowId}&browserSessionId=${sessionId}`, { token });
          const listedInGroup = (listed.json?.result?.tabs ?? []).filter((tab) => tab.groupId === groupId).map((tab) => tab.tabId).sort((x, y) => x - y);
          const listedC = (listed.json?.result?.tabs ?? []).find((tab) => tab.tabId === c.id);
          if (!check(JSON.stringify(listedInGroup) === JSON.stringify([a.id, b.id].sort((x, y) => x - y)) && listedC?.groupId === -1, `browser.list_tabs did not report group membership: ${JSON.stringify(listed.json)}`)) return;

          // Update: rename and recolor, then remove the title; a no-op is refused.
          const updated = await expectOk("update", "browser.update_tab_group", { groupId, title: "smoke-renamed", color: "cyan" });
          if (!updated) return;
          const realUpdated = await realGroup(groupId);
          if (!check(realUpdated?.title === "smoke-renamed" && realUpdated.color === "cyan" && updated.group.title === "smoke-renamed", `the update differs from the browser's group: ${JSON.stringify(realUpdated)}`)) return;
          if (!(await expectOk("remove title", "browser.update_tab_group", { groupId, title: "" }))) return;
          if (!check((await realGroup(groupId))?.title === "", "an empty title did not remove the group's title")) return;
          if (!(await expectRefused("no-op update", "browser.update_tab_group", { groupId, color: "cyan" }, "no_change"))) return;

          // Move one tab into the group.
          if (!(await expectOk("move one tab", "browser.move_tabs", { tabIds: [c.id], groupId }))) return;
          if (!check((await realTab(c.id)).groupId === groupId, "the moved tab is not in the group")) return;

          // Move a tab from a second group and an ungrouped tab together; the
          // emptied source group disappears. (The source group is harness setup.)
          const sourceGroupId = await evaluate(swCdp, `chrome.tabs.group({ tabIds: [${JSON.stringify(d.id)}] })`);
          const movedMany = await expectOk("move several tabs", "browser.move_tabs", { tabIds: [d.id, e.id], groupId });
          if (!movedMany) return;
          if (!check((await realTab(d.id)).groupId === groupId && (await realTab(e.id)).groupId === groupId, "the moved tabs are not in the group")) return;
          if (!check((await realGroup(sourceGroupId)) === null, "the emptied source group still exists")) return;
          if (!(await expectRefused("no-op move", "browser.move_tabs", { tabIds: [d.id, e.id], groupId }, "no_change"))) return;

          // Refusals change nothing: a pinned tab, another window, a stale session, a closed tab.
          const pinned = await createAndWaitForTab(swCdp, `${fixtureUrl}?smoke-mutation=pinned`);
          tabsToClose.push(pinned.id);
          await evaluate(swCdp, `chrome.tabs.update(${JSON.stringify(pinned.id)}, { pinned: true })`);
          if (!(await expectRefused("pinned tab", "browser.move_tabs", { tabIds: [pinned.id], groupId }, "pinned_tab"))) return;
          const realPinned = await realTab(pinned.id);
          if (!check(realPinned.groupId === -1 && realPinned.pinned === true, "a refused pinned tab was changed")) return;

          const other = await evaluate(
            swCdp,
            `chrome.windows.create({ url: ${JSON.stringify(`${fixtureUrl}?smoke-mutation=other-window`)}, focused: false }).then((w) => ({ windowId: w.id, tabId: w.tabs[0].id }))`,
          );
          otherWindowId = other.windowId;
          if (!(await expectRefused("cross-window create", "browser.create_tab_group", { tabIds: [a.id, other.tabId] }, "window_mismatch"))) return;
          if (!(await expectRefused("cross-window move", "browser.move_tabs", { tabIds: [other.tabId], groupId }, "window_mismatch"))) return;
          const realOther = await realTab(other.tabId);
          if (!check(realOther.groupId === -1 && realOther.windowId === other.windowId, "a refused tab in another window was changed")) return;

          if (!(await expectRefused("stale session", "browser.move_tabs", { browserSessionId: "not-the-real-session", tabIds: [a.id], groupId: null }, "stale_session"))) return;
          const closed = await createAndWaitForTab(swCdp, `${fixtureUrl}?smoke-mutation=closed`);
          await evaluate(swCdp, `chrome.tabs.remove(${JSON.stringify(closed.id)})`);
          if (!(await expectRefused("closed tab", "browser.move_tabs", { tabIds: [closed.id], groupId }, "stale_handle"))) return;
          if (!check((await realTab(a.id)).groupId === groupId, "a refused request changed a grouped tab")) return;

          // Ungroup: groupId null removes every tab, and the browser removes the emptied group.
          const ungrouped = await expectOk("ungroup", "browser.move_tabs", { tabIds: tabs.map((tab) => tab.id), groupId: null });
          if (!ungrouped) return;
          if (!check(ungrouped.group === null && ungrouped.tabs.every((tab) => tab.groupId === -1), `the ungroup result is not what was asked: ${JSON.stringify(ungrouped)}`)) return;
          for (const tab of tabs) {
            if (!check((await realTab(tab.id)).groupId === -1, `tab ${tab.id} is still grouped after the ungroup`)) return;
          }
          if (!check((await realGroup(groupId)) === null, "the emptied group still exists after the ungroup")) return;
          console.log(
            "direct mutation proof passed: create, rename/recolor, title removal, single and multi-group moves, ungroup, and every refusal matched the browser's own state.",
          );
        }
      } finally {
        for (const tabId of tabsToClose) await evaluate(swCdp, `chrome.tabs.remove(${JSON.stringify(tabId)})`).catch(() => {});
        if (otherWindowId !== null) await evaluate(swCdp, `chrome.windows.remove(${JSON.stringify(otherWindowId)})`).catch(() => {});
      }
    }
    if (process.exitCode === 1) return;

    // Detach from the service worker's own CDP target *before* the idle
    // wait, and do not reattach until a later step genuinely needs it
    // (Step 5's browser restart). A live DevTools Protocol session to a
    // target is known to keep Chrome from treating it as idle/throttled —
    // leaving `swCdp` attached (even passively, just for console/exception
    // diagnostics) through the idle wait and the service-down window below
    // would make the MV3 idle timer itself an artifact of being
    // instrumented, not a real test of the heartbeat. The persistent
    // harness page is a *different* target (an ordinary page, not the
    // worker) and reading its own chrome.alarms state has no bearing on
    // the worker's idle timer, so it may stay connected — it just must
    // never message/wake the worker, and does not below.
    detachDiagnostics();
    swCdp.close();
    swCdp = undefined;

    // Step 3: survive past the MV3 idle window via the heartbeat, then
    // prove the connection (and a second request) still works, with no
    // CDP connection to the worker at all for the whole window — see
    // above. Chrome may legitimately recycle the worker during this wait;
    // that is only a problem if the *product* bridge (checked here via
    // /health and a real request) does not recover, which is what this
    // step actually asserts.
    console.log(`waiting ${IDLE_WAIT_MS}ms past the Manifest V3 service-worker idle window, uninstrumented...`);
    await delay(IDLE_WAIT_MS);
    const healthAfterIdle = await waitForHealth(port);
    if (!healthAfterIdle.json.extension.connected) {
      fail(
        `extension was no longer connected after waiting ${IDLE_WAIT_MS}ms (heartbeat did not keep the product ` +
          `bridge alive). /health: ${JSON.stringify(healthAfterIdle.json)}`,
      );
      return;
    }
    try {
      await expectListWindows(port, token, "request after idle wait");
    } catch (error) {
      const healthNow = await waitForHealth(port).catch((healthError) => ({ json: { error: healthError.message } }));
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
          `/health at failure time: ${JSON.stringify(healthNow.json)}`,
      );
    }

    // Proof step: before the service goes down, the durable reconnect
    // alarm must already be registered with Chrome (not just believed to
    // be, from the extension's own state) with the expected periodic
    // schedule. Read via the persistent harness page, not the service
    // worker, precisely so this does not depend on the worker's own CDP
    // target staying attached.
    const alarmsBeforeRestart = await readAlarmsViaHarness(harnessPageCdp);
    const reconnectAlarmBeforeRestart = findReconnectAlarm(alarmsBeforeRestart);
    if (!reconnectAlarmBeforeRestart) {
      fail(
        `the durable reconnect alarm ("${RECONNECT_ALARM_NAME}") was not found via chrome.alarms.getAll() before ` +
          "the service restart, even though the extension reports being connected and paired. This is a product " +
          "lifecycle defect (extension/service-client.js's scheduleRetryAlarm), not a transport question. " +
          `chrome.alarms.getAll(): ${JSON.stringify(alarmsBeforeRestart)}`,
      );
      return;
    }
    if (reconnectAlarmBeforeRestart.periodInMinutes !== RECONNECT_ALARM_DELAY_MINUTES) {
      fail(
        `the durable reconnect alarm has an unexpected schedule: expected periodInMinutes ` +
          `${RECONNECT_ALARM_DELAY_MINUTES}, got ${JSON.stringify(reconnectAlarmBeforeRestart)}`,
      );
      return;
    }

    // Step 4: stop the service and deliberately leave it down for at least
    // SERVICE_DOWNTIME_MS — long enough to exceed both the MV3 worker idle
    // window and the fast setTimeout retry's own useful lifetime — before
    // restarting it. Without this, an immediate restart mostly exercises
    // the *fast* setTimeout reconnect path (still up and retrying when the
    // service comes back in well under a second), not the alarm-driven
    // path this step exists to prove. No CDP connection to the worker is
    // held or reattached for any of this (see the Step 3 comment above);
    // recovery is judged solely through /health and a real HTTP request.
    await stopServiceChild(service);
    console.log(`service stopped; leaving it down for ${SERVICE_DOWNTIME_MS}ms before restarting...`);
    await delay(SERVICE_DOWNTIME_MS);
    service = spawnService(serviceDataDir, port);
    await waitForHealth(port);
    await waitForServiceRestartRecoveryOrDiagnose(
      port,
      SERVICE_RESTART_RECOVERY_WAIT_MS,
      () => swCdp,
      diagnostics,
      harnessPageCdp,
    );
    await expectListWindows(port, token, "request after service restart");

    // Step 5: a full *browser* restart. Terminate Chrome cleanly and
    // relaunch it with the same --user-data-dir (so chrome.storage.local,
    // and so the pairing token, persists) and the same staged extension
    // path, while the service keeps running throughout. The old CDP
    // connections (harness page, service worker) are gone the instant
    // Chrome exits — there is nothing to gracefully close them with — so
    // they are just discarded, not explicitly closed.
    detachDiagnostics();
    swCdp = undefined;
    harnessPageCdp = undefined;

    await terminateChrome(chrome, chromeExitedEarly);

    // terminateChrome only returns once the old process has actually
    // exited, so it is safe now to remove the profile's stale
    // DevToolsActivePort file: without this, waitForDevToolsPort can read
    // that file before the relaunched Chrome has overwritten it, handing
    // back the *old* (now-dead) port and failing with ECONNREFUSED instead
    // of waiting for the new one.
    await rm(join(userDataDir, "DevToolsActivePort"), { force: true });

    const relaunched = launchChrome(chromePath, { userDataDir, stagingDir, headless });
    chrome = relaunched.chrome;
    chromeExitedEarly = relaunched.exitedEarly;

    // Chrome process/DevTools issues here are infrastructure, exactly like
    // the very first launch above — not yet a claim about the extension.
    const relaunchOutcome = await waitForChromeReady(relaunched, userDataDir);
    if ("spawnError" in relaunchOutcome) {
      blocked(`[browser restart] failed to relaunch "${chromePath}": ${relaunchOutcome.spawnError.message}`);
      return;
    }
    if ("exitCode" in relaunchOutcome) {
      blocked(
        `[browser restart] Chrome exited before opening a new DevTools port (exit code ${relaunchOutcome.exitCode}). ` +
          `Stderr: ${relaunched.getStderr().trim().slice(0, 2000)}`,
      );
      return;
    }
    cdpPort = relaunchOutcome.port;

    // Once DevTools is reachable again, not finding our own extension's
    // service worker is a product/startup regression (same convention as
    // the first launch above), not infrastructure.
    let relaunchedWorker;
    try {
      relaunchedWorker = await findExtensionServiceWorker(cdpPort, expectedExtensionName);
    } catch (error) {
      fail(
        `[browser restart] could not locate the extension's service worker after relaunch: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    swCdp = relaunchedWorker.cdp;
    detachDiagnostics = attachDiagnostics(swCdp, diagnostics);

    // The actual proof: reconnect using the *persisted* token (nothing
    // here re-pairs), and a real authenticated request succeeds. Failure
    // here is the product failure this step exists to catch.
    let windowsAfterRestart;
    try {
      await waitUntilExtensionConnectedOrDiagnose(port, RECONNECT_WAIT_MS, () => swCdp, diagnostics);
      windowsAfterRestart = await expectListWindows(port, token, "request after browser restart");
    } catch (error) {
      fail(`[browser restart] ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    // Session rotation across a full browser restart (project.md Stage 2
    // remediation): browserSessionId is backed by chrome.storage.session,
    // which the browser itself clears on restart, so a fresh worker
    // incarnation here must mint a new one — never reuse the pre-restart id.
    const sessionIdAfterRestart = await readSessionId(swCdp);
    if (sessionIdAfterRestart === sessionId) {
      fail(
        `[browser restart] browserSessionId did not rotate across a full browser restart (still "${sessionId}"); ` +
          "chrome.storage.session should have been cleared, forcing a fresh id.",
      );
      return;
    }

    const windowIdAfterRestart = windowsAfterRestart[0].windowId;

    // The pre-restart session id, paired with a handle that is still
    // otherwise perfectly valid in the new session, must be rejected
    // explicitly rather than silently honored against the new session's
    // state.
    await expectListTabsStaleSession(port, token, sessionId, windowIdAfterRestart);

    // The new session id, used correctly, must still work normally: a
    // refetch succeeds with an "ok" result.
    const refetched = await serviceRequest(
      port,
      `/api/browser.list_tabs?windowId=${windowIdAfterRestart}&browserSessionId=${sessionIdAfterRestart}`,
      { token },
    );
    if (refetched.status !== 200 || refetched.json?.result?.status !== "ok") {
      fail(
        `[browser restart] browser.list_tabs with the new (post-restart) session id did not succeed: ` +
          `${refetched.status} ${JSON.stringify(refetched.json)}`,
      );
      return;
    }

    // A mutation carrying the pre-restart session is refused before anything
    // is read or changed, exactly like a read.
    const restartTab = await createAndWaitForTab(swCdp, `${fixtureUrl}?smoke-mutation=after-restart`);
    try {
      const staleMutation = await serviceRequest(port, "/api/browser.create_tab_group", {
        method: "POST",
        token,
        body: { browserSessionId: sessionId, tabIds: [restartTab.id], title: "smoke-stale" },
      });
      const staleResult = staleMutation.json?.result;
      if (staleMutation.status !== 200 || staleResult?.code !== ERROR_CODES.STALE_SESSION || staleResult?.changed !== false) {
        fail(`[browser restart] a mutation with the pre-restart session was not refused as stale: ${staleMutation.status} ${JSON.stringify(staleMutation.json)}`);
        return;
      }
      const restartTabGroup = await evaluate(swCdp, `chrome.tabs.get(${JSON.stringify(restartTab.id)}).then((t) => t.groupId ?? -1)`);
      if (restartTabGroup !== -1) {
        fail(`[browser restart] a stale mutation grouped the tab (groupId ${restartTabGroup})`);
        return;
      }
    } finally {
      await evaluate(swCdp, `chrome.tabs.remove(${JSON.stringify(restartTab.id)})`).catch(() => {});
    }

    // Step 6: confirm real Origin behavior from an actual (non-extension)
    // browser page — the browser sets this Origin header; nothing in this
    // script constructs or spoofs it. Only the browser *tab* is recreated
    // here (via the now-current swCdp); the fixture HTTP server itself was
    // created once up front and survived the browser restart untouched.
    const fixtureTab = await createAndWaitForTab(swCdp, fixtureUrl);
    fixtureTabId = fixtureTab.id;
    const fixturePageTarget = await findPageTarget(cdpPort, fixtureUrl);
    fixturePageCdp = await connectCdpForPage(fixturePageTarget.webSocketDebuggerUrl);

    const originOutcome = await evaluate(
      fixturePageCdp,
      `
      new Promise((resolve) => {
        let settled = false;
        const finish = (outcome) => { if (!settled) { settled = true; resolve(outcome); } };
        let socket;
        try {
          socket = new WebSocket(${JSON.stringify(`ws://127.0.0.1:${port}/extension`)});
        } catch (error) {
          finish({ outcome: "threw", message: String(error) });
          return;
        }
        socket.addEventListener("open", () => finish({ outcome: "open" }));
        socket.addEventListener("error", () => finish({ outcome: "error" }));
        socket.addEventListener("close", (event) => finish({ outcome: "closed", code: event.code, wasClean: event.wasClean }));
        setTimeout(() => finish({ outcome: "timeout" }), 4000);
      })
      `,
    );
    // Require an actual, specific rejection signal — "error" or "closed"
    // — not merely "not open". A "timeout" (the socket settled neither way
    // within the deadline) or "threw" (the WebSocket constructor itself
    // failed, for reasons unrelated to the server's Origin check) are both
    // ambiguous: neither one is evidence the service actually rejected the
    // untrusted Origin, so neither may be silently treated as a pass.
    if (originOutcome.outcome !== "error" && originOutcome.outcome !== "closed") {
      fail(
        `the WebSocket from an ordinary (non-extension) page did not produce a clear rejection (expected outcome ` +
          `"error" or "closed"); got an ambiguous or unexpected outcome instead: ${JSON.stringify(originOutcome)}`,
      );
      return;
    }

    if (process.exitCode !== 1) {
      console.log(
        "SMOKE_PASS: storage.local pairing, an authenticated HTTP->service->extension->browser.list_windows " +
          "round trip, the read-API routes (tabs, a real tab group, read_tab outcomes including " +
          "protected/stale/slow-loading/best-effort-discarded, two-entry paginated history, and stale-session " +
          "rejection), the direct tab-group mutations (create, rename/recolor, title removal, single and " +
          "multi-group moves, ungroup with the emptied groups disappearing, and no-op/pinned/cross-window/" +
          "stale-session/closed-tab refusals that changed nothing, all checked against the browser's own state), " +
          `survival past a ${IDLE_WAIT_MS}ms idle wait via the heartbeat, the durable reconnect alarm ` +
          "being registered with the expected schedule before a service restart, automatic reconnect after that " +
          "restart and after a full browser restart (neither requiring re-pairing), browserSessionId rotating " +
          "across that browser restart with the old session rejected by a read and a mutation and the new one " +
          "working, and a real browser page's Origin header being rejected, all behaved as expected.",
      );
    }
  } catch (error) {
    blocked(`${error instanceof Error ? error.message : String(error)}`);
  } finally {
    detachDiagnostics();
    if (fixtureTabId !== undefined && swCdp) {
      await evaluate(swCdp, `chrome.tabs.remove(${JSON.stringify(fixtureTabId)})`).catch(() => {});
    }
    fixturePageCdp?.close();
    harnessPageCdp?.close();
    swCdp?.close();
    if (chrome) await terminateChrome(chrome, chromeExitedEarly);
    if (fixtureServer) await closeFixtureServer(fixtureServer);
    await stopServiceChild(service);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
