// Shared Chrome-for-Testing/Chromium CDP harness helpers, factored out of
// the original Stage 0 chromium-smoke.mjs so Stage 1's real-browser smoke
// test (stage1-bridge-smoke.mjs) can reuse the exact same, already-proven
// launch/locate/evaluate/teardown logic instead of duplicating it. Behavior
// is unchanged from Stage 0; this is a pure extraction.
//
// Requires Node.js >= 22 for the built-in `WebSocket` client (see
// cdp-socket.mjs). Smoke-test-only requirement, not project-wide.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { connectCdp } from "./cdp-socket.mjs";

export { connectCdp };

// Only auto-detects open-source Chromium. A locally installed consumer Google
// Chrome ignored the unpacked-extension flags in this project's environment,
// so branded browsers are never auto-detected; whether any other browser
// honors --load-extension depends on the exact build, and nothing here
// brand-infers (see README). Chrome for Testing reliably supports it but has
// no fixed install path, so point CHROME_PATH at one instead of guessing.
//
// Stage 6: CHROME_PATH takes priority when both are set (so CI's default
// job, which only ever sets CHROME_PATH, is unaffected), but CHROMIUM_PATH
// is checked next, before auto-detection — every one of this project's
// smoke scripts therefore already supports running the *exact same* smoke
// test against a second, distinct open-source Chromium-family build without
// any new script or flag: set CHROMIUM_PATH instead of CHROME_PATH. See
// README's "A second Chromium-family browser" section for why that second
// binary must actually be a different build (not the same CHROME_PATH
// binary under a second name) to mean anything.
export function findChromeExecutable() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const candidates =
    {
      darwin: ["/Applications/Chromium.app/Contents/MacOS/Chromium"],
      linux: ["/usr/bin/chromium", "/usr/bin/chromium-browser"],
      win32: [],
    }[process.platform] ?? [];

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function startFixtureServer(body = "<html><body>Browser Tabs smoke test fixture content.</body></html>") {
  return new Promise((resolve) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Awaited (not fire-and-forget) so the fixture server's listening socket is
// confirmed closed before moving on; closeAllConnections forces any idle
// keep-alive sockets shut immediately so they cannot otherwise keep the
// close() callback (and so the process) pending indefinitely.
export async function closeFixtureServer(server) {
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export function fetchJson(path, port) {
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

export async function waitForDevToolsPort(userDataDir, timeoutMs = 15_000) {
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

export async function stageExtension(extensionSourcePath, stagingRoot) {
  const stagingDir = join(stagingRoot, "extension");
  await cp(extensionSourcePath, stagingDir, { recursive: true });
  return stagingDir;
}

export async function evaluate(cdp, expression) {
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

// Identifies this extension by its manifest name rather than assuming the
// first chrome-extension:// service worker found is ours — Chrome may also
// expose component/built-in extension service workers over CDP.
export async function findExtensionServiceWorker(port, expectedName, timeoutMs = 15_000) {
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

export async function findPageTarget(port, url, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await fetchJson("/json/list", port);
    const target = targets.find((candidate) => candidate.type === "page" && candidate.url === url);
    if (target) return target;
    await delay(150);
  }
  throw new Error(`Timed out locating the page target for ${url}`);
}

// Creates one tab and waits (polling with a deadline, not a fixed sleep)
// for it to finish loading, as a single bounded CDP command. Kept as its
// own command — rather than one command awaiting multiple tabs sequentially
// — so no single Runtime.evaluate call can run longer than the CDP
// client's per-command timeout (10s default; see cdp-socket.mjs): this
// wait's own deadline (8s) stays safely under that.
export async function createAndWaitForTab(cdp, url) {
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

export function launchChrome(chromePath, { userDataDir, stagingDir, headless }) {
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
  let stderr = "";
  chrome.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitedEarly = new Promise((resolve) => chrome.once("exit", (code) => resolve(code)));
  // Without this listener, an invalid chromePath (spawn ENOENT) would throw
  // an uncaught "error" event and crash the whole script.
  const spawnError = new Promise((resolve) => chrome.once("error", (error) => resolve(error)));

  return { chrome, exitedEarly, spawnError, getStderr: () => stderr };
}

// Races a successful DevTools port discovery against the browser exiting or
// failing to spawn at all, so callers get a single clean three-way outcome
// instead of hanging on a browser that never starts.
export async function waitForChromeReady(launched, userDataDir) {
  const outcome = await Promise.race([
    waitForDevToolsPort(userDataDir).then((port) => ({ port })),
    launched.exitedEarly.then((code) => ({ exitCode: code })),
    launched.spawnError.then((error) => ({ spawnError: error })),
  ]);
  return outcome;
}

// Ensures the browser has actually exited (not just been asked to) before
// returning, with bounded deadlines throughout, so a test runner cannot
// hang waiting on a lingering process after a result has already been
// printed.
export async function terminateChrome(child, exitPromise, { gracefulTimeoutMs = 5000, forceTimeoutMs = 2000 } = {}) {
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
