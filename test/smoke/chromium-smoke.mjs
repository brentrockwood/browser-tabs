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

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeFixtureServer,
  connectCdp,
  createAndWaitForTab,
  evaluate,
  findExtensionServiceWorker,
  findPageTarget,
  findChromeExecutable,
  launchChrome,
  startFixtureServer,
  stageExtension,
  terminateChrome,
  waitForChromeReady,
} from "./chrome-harness.mjs";

const EXTENSION_SOURCE_PATH = fileURLToPath(new URL("../../extension/", import.meta.url));
const HARNESS_FIXTURE_PATH = fileURLToPath(new URL("./fixtures/smoke-harness.html", import.meta.url));
const PROTECTED_URL = "chrome://version/";

async function stageExtensionWithHarness(stagingRoot) {
  const stagingDir = await stageExtension(EXTENSION_SOURCE_PATH, stagingRoot);
  const harnessHtml = await readFile(HARNESS_FIXTURE_PATH, "utf8");
  await writeFile(join(stagingDir, "smoke-harness.html"), harnessHtml, "utf8");
  return stagingDir;
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
  const stagingDir = await stageExtensionWithHarness(workDir);
  const manifest = JSON.parse(await readFile(join(stagingDir, "manifest.json"), "utf8"));
  const expectedExtensionName = manifest.name;

  const fixtureServer = await startFixtureServer();
  const fixturePort = fixtureServer.address().port;
  const fixtureUrl = `http://127.0.0.1:${fixturePort}/`;

  const headless = process.env.SMOKE_HEADLESS !== "false";
  const launched = launchChrome(chromePath, { userDataDir, stagingDir, headless });
  const { chrome, exitedEarly: chromeExitedEarly } = launched;

  let swCdp;
  let pageCdp;
  try {
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
    pageCdp = await connectCdpForPage(pageTarget.webSocketDebuggerUrl);

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

// Thin wrapper kept local (rather than exported from chrome-harness.mjs)
// since it also enables Runtime so callers get evaluate() working
// immediately — the one bit of per-call-site setup every page connection
// in this file needs.
async function connectCdpForPage(webSocketDebuggerUrl) {
  const cdp = await connectCdp(webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  return cdp;
}

main();
