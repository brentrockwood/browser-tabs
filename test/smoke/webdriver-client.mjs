// Stage 6: a minimal W3C WebDriver (classic) HTTP client plus geckodriver
// process management, used only by the Firefox smoke test
// (firefox-smoke.mjs). Firefox has no CDP equivalent to the Chrome-family
// harness's chrome-harness.mjs, so this project's one Firefox-specific
// automation path goes through geckodriver — Mozilla's own WebDriver
// server for Firefox — speaking plain JSON-over-HTTP, not a new npm
// dependency.
//
// Deliberately narrow: only the handful of WebDriver commands the smoke
// test actually needs (new/delete session, navigate, execute async script,
// and geckodriver's own `moz/addon/install` extension command for loading a
// temporary, unsigned add-on — the same mechanism "Load Temporary Add-on"
// in about:debugging uses).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

import { DiagnosticError, safeLabel } from "../../scripts/safe-diagnostics.mjs";

// Firefox, unlike Chrome, has no single well-known install path across
// Linux distributions; only macOS gets a confident default. Everywhere
// else, set FIREFOX_PATH explicitly.
export function findFirefoxExecutable() {
  if (process.env.FIREFOX_PATH) return process.env.FIREFOX_PATH;
  const candidates =
    {
      darwin: ["/Applications/Firefox.app/Contents/MacOS/firefox"],
      linux: ["/usr/bin/firefox", "/usr/lib/firefox/firefox"],
      win32: [],
    }[process.platform] ?? [];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function findGeckodriverExecutable() {
  return process.env.GECKODRIVER_PATH || "geckodriver";
}

// Spawns geckodriver with `--port 0` (an OS-assigned free port) and parses
// its own stdout line announcing the port it actually bound
// ("Listening on 127.0.0.1:NNNNN"), the same "trust the process's own
// announcement, not a guess" approach test/smoke/chrome-harness.mjs uses
// for Chrome's DevToolsActivePort file.
export function spawnGeckodriver() {
  const geckodriverPath = findGeckodriverExecutable();
  const child = spawn(geckodriverPath, ["--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const spawnError = new Promise((resolve) => child.once("error", (error) => resolve(error)));
  return { child, exited, spawnError, getStdout: () => stdout, getStderr: () => stderr };
}

export async function waitForGeckodriverPort(launched, timeoutMs = 15_000) {
  const portPromise = (async () => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = /Listening on 127\.0\.0\.1:(\d+)/.exec(launched.getStdout() + launched.getStderr());
      if (match) return { port: Number(match[1]) };
      await delay(50);
    }
    throw new DiagnosticError(`timed out waiting for geckodriver's "Listening on" line within ${timeoutMs}ms`);
  })();
  return Promise.race([
    portPromise,
    launched.exited.then((result) => ({ exitCode: result.code })),
    launched.spawnError.then((error) => ({ spawnError: error })),
  ]);
}

export async function terminateProcess(child, exitPromise, { gracefulTimeoutMs = 5000, forceTimeoutMs = 2000 } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const exitedGracefully = await Promise.race([exitPromise.then(() => true), delay(gracefulTimeoutMs).then(() => false)]);
  if (exitedGracefully) return;
  child.kill("SIGKILL");
  await Promise.race([exitPromise, delay(forceTimeoutMs)]);
}

function webdriverRequest(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        timeout: 20_000,
        headers: payload
          ? { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          // Error text is deliberately limited to the HTTP status and
          // WebDriver's own short error code (e.g. "invalid argument"):
          // never the response body, whose `message`/`stacktrace` can quote
          // the URL being navigated to (which carries the owner pairing
          // token in the Firefox smoke test) or script/page content.
          let parsed;
          try {
            parsed = data ? JSON.parse(data) : {};
          } catch {
            reject(new DiagnosticError(`WebDriver ${method} command returned a non-JSON response (status ${res.statusCode})`));
            return;
          }
          if (res.statusCode >= 400) {
            const code = safeLabel(String(parsed?.value?.error ?? "").replace(/\s+/g, "_"));
            reject(new DiagnosticError(`WebDriver ${method} command failed (status ${res.statusCode}, error ${code})`));
            return;
          }
          resolve(parsed.value);
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new DiagnosticError(`WebDriver ${method} command timed out`)));
    if (payload) req.write(payload);
    req.end();
  });
}

export async function newSession(port, { firefoxPath, headless }) {
  const args = headless ? ["-headless"] : [];
  const value = await webdriverRequest(port, "POST", "/session", {
    capabilities: {
      alwaysMatch: {
        browserName: "firefox",
        "moz:firefoxOptions": { binary: firefoxPath, args },
      },
    },
  });
  return value.sessionId;
}

export async function deleteSession(port, sessionId) {
  await webdriverRequest(port, "DELETE", `/session/${sessionId}`);
}

// geckodriver's Firefox-specific WebDriver extension command for loading a
// temporary add-on — the automated equivalent of about:debugging's "Load
// Temporary Add-on" button. `path` must be an absolute path to the
// extension's unpacked directory (or a zip); temporary installs bypass
// signature verification entirely, same as the manual UI flow. Returns the
// installed add-on's WebExtension id.
export async function installTemporaryAddon(port, sessionId, path) {
  return webdriverRequest(port, "POST", `/session/${sessionId}/moz/addon/install`, { path, temporary: true });
}

export async function navigateTo(port, sessionId, url) {
  await webdriverRequest(port, "POST", `/session/${sessionId}/url`, { url });
}

// W3C WebDriver "Execute Async Script": `script` is a function *body*
// (not a full `function (...) {}` declaration) whose last implicit
// parameter, `arguments[arguments.length - 1]`, is a completion callback —
// the standard way to return a value computed asynchronously, since the
// plain (sync) execute-script command does not wait for a returned Promise
// under the W3C spec. Whatever the test passes to that callback becomes
// this call's resolved value.
export async function executeAsyncScript(port, sessionId, script, args = []) {
  return webdriverRequest(port, "POST", `/session/${sessionId}/execute/async`, { script, args });
}
