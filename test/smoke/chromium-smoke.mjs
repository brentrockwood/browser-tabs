#!/usr/bin/env node
// Repeatable Chromium smoke test for Stage 0.
//
// Stages a temporary copy of the extension (plus a test-only harness page),
// loads it unpacked in a real Chromium-family browser, and exercises the
// extension's actual runtime.onMessage entry point via
// chrome.runtime.sendMessage from that harness page — not by importing and
// calling service-worker.js's exported functions. Covers window listing,
// tab listing, reading an ordinary page, reading a protected chrome:// page,
// and an unknown method.
//
// Usage: npm run test:smoke
//
// Requires Node.js >= 22 for the built-in `WebSocket` client. This is a
// smoke-test-only requirement, not a project-wide one — `npm test` (the
// unit tests) has no such requirement.
//
// Env:
//   CHROME_PATH     path to a Chrome for Testing or Chromium executable.
//                    Only open-source Chromium is auto-detected; a locally
//                    installed branded Chrome/Edge/Brave is known to
//                    silently ignore --load-extension and is not supported.
//   SMOKE_HEADLESS  "false" to run headed (default: headless)
//
// Exit codes:
//   0  pass
//   1  a product assertion failed (the extension behaved incorrectly)
//   2  an infrastructure/environment blocker prevented the test from
//      running at all (missing browser, timeouts, CDP errors, wrong Node
//      version) — this is not a claim that the extension failed

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { connectCdp } from "./cdp-socket.mjs";

const EXTENSION_SOURCE_PATH = fileURLToPath(new URL("../../extension/", import.meta.url));
const HARNESS_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/smoke-harness.html", import.meta.url));
const PROTECTED_URL = "chrome://version/";

// Only auto-detects open-source Chromium: a locally installed, branded
// Google Chrome (and, by the same restriction, branded Edge/Brave) is known
// to silently ignore --load-extension and is not supported by this
// automated path (see README). Chrome for Testing reliably supports it but
// has no fixed install path, so point CHROME_PATH at one instead of guessing.
function findChromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  const candidates =
    {
      darwin: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
      linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser"],
      win32: [],
    }[process.platform] ?? [];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end("<html><body>Browser Tabs smoke test fixture content.</body></html>");
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function fetchJson(path, port) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path }, (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject);
  });
}

async function waitForDevToolsPort(userDataDir, timeoutMs = 15_000) {
  const portFile = join(userDataDir, "DevToolsActivePort");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const content = await readFile(portFile, "utf8");
      const port = Number(content.split("\n")[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // File not written yet.
    }
    await delay(150);
  }
  throw new Error("Timed out waiting for Chrome's DevToolsActivePort file");
}

async function stageExtension(stagingRoot) {
  const stagingDir = join(stagingRoot, "extension");
  await cp(EXTENSION_SOURCE_PATH, stagingDir, { recursive: true });
  const harnessHtml = await readFile(HARNESS_FIXTURE_PATH, "utf8");
  await writeFile(join(stagingDir, "smoke-harness.html"), harnessHtml, "utf8");
  return stagingDir;
}

// Identifies this extension by its manifest name rather than assuming the
// first chrome-extension:// service worker found is ours — Chrome may also
// expose component/built-in extension service workers over CDP.
async function findExtensionServiceWorker(port, expectedName, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await fetchJson("/json/list", port);
    const candidates = targets.filter(
      (target) => target.type === "service_worker" && target.url.startsWith("chrome-extension://"),
    );
    for (const candidate of candidates) {
      let candidateCdp;
      try {
        candidateCdp = await connectCdp(candidate.webSocketDebuggerUrl);
        await candidateCdp.send("Runtime.enable");
        const manifestName = await evaluate(candidateCdp, "chrome.runtime.getManifest().name");
        if (manifestName === expectedName) {
          return { target: candidate, cdp: candidateCdp };
        }
      } catch {
        // Not a match, or not ready yet; try the next candidate.
      }
      if (candidateCdp) candidateCdp.close();
    }
    await delay(150);
  }
  throw new Error(
    `Timed out locating a service worker whose manifest name is "${expectedName}" ` +
      "(never found a matching chrome-extension:// service worker target).",
  );
}

async function findPageTarget(port, url, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await fetchJson("/json/list", port);
    const target = targets.find((candidate) => candidate.type === "page" && candidate.url === url);
    if (target) return target;
    await delay(150);
  }
  throw new Error(`Timed out locating the page target for ${url}`);
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails);
    throw new Error(`Runtime.evaluate threw: ${text}`);
  }
  return result.result.value;
}

// Creates one tab and waits (polling with a deadline, not a fixed sleep)
// for it to finish loading, as a single bounded CDP command. Kept as its
// own command — rather than one command awaiting three tabs sequentially —
// so no single Runtime.evaluate call can run longer than the CDP client's
// per-command timeout (10s default; see cdp-socket.mjs): this wait's own
// deadline (8s) stays safely under that.
async function createAndWaitForTab(cdp, url) {
  return evaluate(
    cdp,
    `
    (async () => {
      const tab = await chrome.tabs.create({ url: ${JSON.stringify(url)}, active: false });
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        const current = await chrome.tabs.get(tab.id);
        if (current.status === "complete") return current;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error("tab " + tab.id + " did not reach complete status before the deadline");
    })()
    `,
  );
}

// Ensures the browser has actually exited (not just been asked to) before
// returning, with bounded deadlines throughout, so npm/CI cannot hang
// waiting on a lingering process after a result has already been printed.
async function terminateChrome(child, exitPromise, { gracefulTimeoutMs = 5000, forceTimeoutMs = 2000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;

  child.kill(); // SIGTERM: ask nicely first.
  const exitedGracefully = await Promise.race([
    exitPromise.then(() => true),
    delay(gracefulTimeoutMs).then(() => false),
  ]);
  if (exitedGracefully) return;

  child.kill("SIGKILL"); // Force kill if it didn't exit in time.
  await Promise.race([exitPromise, delay(forceTimeoutMs)]);
}

// Awaited (not fire-and-forget) so the fixture server's listening socket is
// confirmed closed before we move on; closeAllConnections forces any idle
// keep-alive sockets shut immediately so they cannot otherwise keep the
// close() callback (and so the process) pending indefinitely.
async function closeFixtureServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
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

async function main() {
  if (typeof WebSocket !== "function") {
    blocked(
      "this script requires Node.js's native WebSocket client (stable since Node.js 22); " +
        `current runtime is Node.js ${process.version}. Upgrade Node.js and re-run "npm run test:smoke".`,
    );
    return;
  }

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    blocked(
      "no Chromium executable auto-detected, and CHROME_PATH is not set. A locally installed branded " +
        "Chrome/Edge/Brave is known to silently ignore --load-extension and is not supported here; set " +
        "CHROME_PATH to a Chrome for Testing binary " +
        "(https://googlechromelabs.github.io/chrome-for-testing/) or an open-source Chromium build, then re-run.",
    );
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), "browser-tabs-smoke-"));
  const userDataDir = join(workDir, "profile");
  const stagingDir = await stageExtension(workDir);
  const manifest = JSON.parse(await readFile(join(stagingDir, "manifest.json"), "utf8"));
  const expectedExtensionName = manifest.name;

  const fixtureServer = await startFixtureServer();
  const fixturePort = fixtureServer.address().port;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

  const headless = process.env.SMOKE_HEADLESS !== "false";
  const args = [
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${stagingDir}`,
    `--disable-extensions-except=${stagingDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  if (headless) args.unshift("--headless=new", "--disable-gpu");

  const chrome = spawn(chromePath, args, { stdio: ["ignore", "ignore", "pipe"] });
  let chromeStderr = "";
  chrome.stderr?.on("data", (chunk) => {
    chromeStderr += chunk.toString();
  });
  const chromeExitedEarly = new Promise((resolve) => chrome.once("exit", (code) => resolve(code)));
  // Without this listener, an invalid CHROME_PATH (spawn ENOENT) would throw
  // an uncaught "error" event and crash the whole script instead of
  // producing a clean SMOKE_BLOCKED result.
  const chromeSpawnError = new Promise((resolve) => chrome.once("error", (error) => resolve(error)));

  let swCdp;
  let pageCdp;
  try {
    const portOrExitOrError = await Promise.race([
      waitForDevToolsPort(userDataDir).then((port) => ({ port })),
      chromeExitedEarly.then((code) => ({ exitCode: code })),
      chromeSpawnError.then((error) => ({ spawnError: error })),
    ]);
    if ("spawnError" in portOrExitOrError) {
      blocked(`Failed to launch "${chromePath}": ${portOrExitOrError.spawnError.message}`);
      return;
    }
    if ("exitCode" in portOrExitOrError) {
      blocked(
        `Chrome exited before opening a DevTools port (exit code ${portOrExitOrError.exitCode}). ` +
          `Stderr: ${chromeStderr.trim().slice(0, 2000)}`,
      );
      return;
    }
    const { port } = portOrExitOrError;

    // Once the browser has launched and CDP is reachable, failing to find
    // this extension's service worker is a product/startup regression, not
    // an infrastructure problem — including when CHROME_PATH points at an
    // unsupported, branded Chrome/Edge/Brave build that silently ignored
    // --load-extension (see README): from here on that is a real failure to
    // report, not a weaker "blocked" classification.
    let found;
    try {
      found = await findExtensionServiceWorker(port, expectedExtensionName);
    } catch (serviceWorkerError) {
      fail(
        "could not locate this extension's service worker via CDP after Chrome launched and exposed CDP: " +
          `${serviceWorkerError instanceof Error ? serviceWorkerError.message : String(serviceWorkerError)}. ` +
          "This may mean the extension failed to load/start, or CHROME_PATH points at a browser build " +
          "unsupported by this automated path (see README).",
      );
      return;
    }
    swCdp = found.cdp;
    const extensionId = new URL(found.target.url).hostname;
    const harnessUrl = `chrome-extension://${extensionId}/smoke-harness.html`;

    // Test scaffolding: create the fixture/protected/harness tabs and wait
    // (polling with a deadline, not a fixed sleep) for each to finish
    // loading. This is the harness setting up a scenario to read, distinct
    // from the three extension operations under test below, none of which
    // create, close, move, group, or navigate a tab. Each tab is its own
    // bounded command (see createAndWaitForTab) rather than one command
    // sequentially awaiting all three, so no single CDP command can run
    // longer than its own per-command timeout.
    const readableTab = await createAndWaitForTab(swCdp, fixtureUrl);
    const protectedTab = await createAndWaitForTab(swCdp, PROTECTED_URL);
    const harnessTab = await createAndWaitForTab(swCdp, harnessUrl);

    const pageTarget = await findPageTarget(port, harnessUrl);
    pageCdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
    await pageCdp.send("Runtime.enable");

    // The actual behavior under test: call chrome.runtime.sendMessage from
    // a genuine separate extension page, exercising the real
    // runtime.onMessage listener registered in service-worker.js. An
    // exception here means the extension/product failed to respond
    // correctly, not that the test's own infrastructure is broken — so it
    // is reported as SMOKE_FAIL, not SMOKE_BLOCKED (the catch block below,
    // which is reserved for setup/infrastructure problems).
    let outcome;
    try {
      outcome = await evaluate(
        pageCdp,
        `
        (async () => {
          const windows = await chrome.runtime.sendMessage({ method: "browser.list_windows" });
          const tabs = await chrome.runtime.sendMessage({
            method: "browser.list_tabs",
            windowId: ${JSON.stringify(readableTab.windowId)},
          });
          const readableSnapshot = await chrome.runtime.sendMessage({
            method: "browser.read_tab",
            tabId: ${JSON.stringify(readableTab.id)},
          });
          const protectedSnapshot = await chrome.runtime.sendMessage({
            method: "browser.read_tab",
            tabId: ${JSON.stringify(protectedTab.id)},
          });
          const unknownMethodResult = await chrome.runtime.sendMessage({ method: "browser.not_a_real_method" });
          return { windows, tabs, readableSnapshot, protectedSnapshot, unknownMethodResult };
        })()
        `,
      );
    } catch (productError) {
      fail(
        `the runtime.sendMessage product exercise threw: ` +
          `${productError instanceof Error ? productError.message : String(productError)}`,
      );
      return;
    }

    // Product assertions: a failure here means the extension behaved
    // incorrectly, as distinct from the infrastructure blockers handled in
    // the catch block below.
    if (!Array.isArray(outcome.windows) || outcome.windows.length === 0) {
      fail(`browser.list_windows returned no windows: ${JSON.stringify(outcome.windows)}`);
    }

    const readableTabEntry = Array.isArray(outcome.tabs)
      ? outcome.tabs.find((tab) => tab.tabId === readableTab.id)
      : undefined;
    if (!readableTabEntry) {
      fail(`browser.list_tabs did not include the fixture tab: ${JSON.stringify(outcome.tabs)}`);
    }

    if (outcome.readableSnapshot?.status !== "ok" || !outcome.readableSnapshot.text?.includes("smoke test fixture")) {
      fail(
        `browser.read_tab did not return expected content for the readable page: ${JSON.stringify(outcome.readableSnapshot)}`,
      );
    }

    if (outcome.protectedSnapshot?.status !== "unsupported" || outcome.protectedSnapshot?.code !== "injection_rejected") {
      fail(
        `browser.read_tab did not return the expected stable error code for the protected page: ${JSON.stringify(outcome.protectedSnapshot)}`,
      );
    } else if (typeof outcome.protectedSnapshot.detail !== "string" || outcome.protectedSnapshot.detail.length === 0) {
      fail(
        `browser.read_tab's protected-page result is missing diagnostic detail: ${JSON.stringify(outcome.protectedSnapshot)}`,
      );
    }

    if (outcome.unknownMethodResult?.status !== "error" || outcome.unknownMethodResult?.code !== "unknown_method") {
      fail(
        `an unknown method did not return a stable error via runtime.onMessage: ${JSON.stringify(outcome.unknownMethodResult)}`,
      );
    }

    try {
      await evaluate(
        swCdp,
        `
        (async () => {
          await chrome.tabs.remove(${JSON.stringify(readableTab.id)});
          await chrome.tabs.remove(${JSON.stringify(protectedTab.id)});
          await chrome.tabs.remove(${JSON.stringify(harnessTab.id)});
        })()
        `,
      );
    } catch (cleanupError) {
      console.warn(`smoke test: tab cleanup warning: ${cleanupError.message}`);
    }

    if (process.exitCode !== 1) {
      console.log(
        "SMOKE_PASS: window listing, tab listing, a readable page, a protected page, and an unknown method " +
          "all behaved as expected via the extension's actual runtime.onMessage listener.",
      );
    }
  } catch (error) {
    blocked(`${error instanceof Error ? error.message : String(error)}`);
  } finally {
    pageCdp?.close();
    swCdp?.close();
    await terminateChrome(chrome, chromeExitedEarly);
    await closeFixtureServer(fixtureServer);
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
