#!/usr/bin/env node
// Verifies the service runs on its own — start, status via /health,
// authenticated access with the one pairing token, a real process restart with
// the same persisted token, and an authenticated stop — using only Node.js and
// the real service/cli.mjs child process, so it is exactly as meaningful on
// Linux as on macOS. No browser or extension is involved. It also checks that
// the service creates no database, and that files left by earlier versions
// (a SQLite database, the old agent token, the old service lock) are left
// byte-for-byte untouched. See .github/workflows/ci.yml, which runs this on
// both platforms.
//
// Usage: node scripts/service-lifecycle-check.mjs
// Exit code: 0 on success, 1 otherwise, with the failing step printed.

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "../extension/protocol.js";
import { DiagnosticError, describeError, safeLabel } from "./safe-diagnostics.mjs";

// Failure output policy: the service's stdout is where its real pairing
// credential is printed, and this script's CI logs outlive the run. Every
// message below is therefore fixed text, an HTTP status, a short code, or an
// id the service itself allocated — never the service's stdout/stderr, a raw
// response body, or a raw error message (a JSON SyntaxError quotes the start
// of the text it failed to parse). test/smoke-diagnostics.test.mjs enforces
// this at the source level.

const SERVICE_CLI_PATH = fileURLToPath(new URL("../service/cli.mjs", import.meta.url));
const PORT = 18743; // Deliberately not the product's fixed default port, so this never collides with a real service.

function spawnService(dataDir) {
  const child = spawn(process.execPath, [SERVICE_CLI_PATH, "start"], {
    env: { ...process.env, BROWSER_TABS_DATA_DIR: dataDir, BROWSER_TABS_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited, getStdout: () => stdout };
}

async function stopChild(service) {
  if (!service || service.child.exitCode !== null || service.child.signalCode !== null) return;
  service.child.kill("SIGTERM");
  await Promise.race([service.exited, delay(5000)]);
  if (service.child.exitCode === null && service.child.signalCode === null) service.child.kill("SIGKILL");
}

function request(path, { method = "GET", token, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "x-protocol-version": String(PROTOCOL_VERSION), ...(token ? { authorization: `Bearer ${token}` } : {}) };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers, timeout: 3000 }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, json: JSON.parse(data) });
        } catch {
          reject(new DiagnosticError(`service returned a non-JSON response (HTTP status ${res.statusCode})`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new DiagnosticError("request timed out")));
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function waitForToken(service, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const match = /Pairing token \(paste into the extension's options page\): ([0-9a-f]{64})/.exec(service.getStdout());
    if (match) return match[1];
    await delay(100);
  }
  // Deliberately no stdout in this message (see the policy at the top).
  throw new DiagnosticError(`service did not print a pairing token within ${timeoutMs}ms (its output is intentionally not shown)`);
}

async function waitForHealth(timeoutMs = 8000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return await request("/health");
    } catch (error) {
      lastError = error;
      await delay(150);
    }
  }
  throw new DiagnosticError(`service never answered /health within ${timeoutMs}ms (last error: ${describeError(lastError)})`);
}

async function waitUntilDown(timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await request("/health");
    } catch {
      return;
    }
    await delay(150);
  }
  throw new DiagnosticError(`service was still answering /health ${timeoutMs}ms after being asked to stop`);
}

function runCli(dataDir, command) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVICE_CLI_PATH, command], {
      env: { ...process.env, BROWSER_TABS_DATA_DIR: dataDir, BROWSER_TABS_PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout }));
  });
}

// Stand-ins for files an earlier version of the service may have left in a
// data directory. The service must neither read, change, nor delete them.
const OBSOLETE_FILES = {
  "browser-tabs.db": "not a real database: lifecycle-check placeholder\n",
  "agent-token": "0".repeat(64),
  "service.lock": "999999",
};

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-lifecycle-check-"));
  let service;
  try {
    console.log(`[1/6] starting the service (platform: ${process.platform}, node: ${process.version})...`);
    service = spawnService(dataDir);
    const token = await waitForToken(service);
    const health = await waitForHealth();
    if (health.json?.ok !== true) throw new DiagnosticError(`/health did not report ok: true (HTTP status ${health.status})`);
    console.log("[1/6] ok: service started and answered /health.");

    console.log("[2/6] checking that the one pairing token authenticates the API...");
    const unauthenticated = await request("/api/browser.list_windows");
    if (unauthenticated.status !== 401) {
      throw new DiagnosticError(`an unauthenticated request was not refused (HTTP status ${unauthenticated.status})`);
    }
    // With no extension connected, an authenticated read gets past
    // authentication and fails explicitly as disconnected.
    const authenticated = await request("/api/browser.list_windows", { token });
    if (authenticated.status !== 503 || authenticated.json?.error?.code !== "disconnected") {
      throw new DiagnosticError(
        `an authenticated read did not reach the extension bridge (HTTP status ${authenticated.status}, ` +
          `error code ${safeLabel(authenticated.json?.error?.code)})`,
      );
    }
    const mutation = await request("/api/browser.move_tabs", { method: "POST", token, body: { browserSessionId: "s", tabIds: [1], groupId: null } });
    if (mutation.status !== 503 || mutation.json?.error?.changed !== false) {
      throw new DiagnosticError(`an authenticated mutation without an extension did not report changed: false (HTTP status ${mutation.status})`);
    }
    const files = (await readdir(dataDir)).sort();
    if (files.some((name) => /\.db($|-)/.test(name) || name === "agent-token")) {
      throw new DiagnosticError(`the service created a database or second token file (files: ${files.map(safeLabel).join(", ")})`);
    }
    console.log("[2/6] ok: one token authenticates; no database or second token was created.");

    console.log("[3/6] stopping the service...");
    await stopChild(service);
    await waitUntilDown();
    console.log("[3/6] ok: service is down.");

    console.log("[4/6] starting the service again with files an earlier version left behind...");
    for (const [name, contents] of Object.entries(OBSOLETE_FILES)) await writeFile(join(dataDir, name), contents);
    service = spawnService(dataDir);
    // The CLI prints the token only on first creation, so the restart reuses
    // the token captured from the first start (it is persisted, not regenerated).
    await waitForHealth();
    const persisted = (await readFile(join(dataDir, "credential"), "utf8")).trim();
    if (persisted !== token) throw new DiagnosticError("the persisted credential file does not match the first-start token");
    const afterRestart = await request("/api/browser.list_windows", { token });
    if (afterRestart.status !== 503) throw new DiagnosticError(`the persisted token did not authenticate after restart (HTTP status ${afterRestart.status})`);
    console.log("[4/6] ok: service restarted with the same persisted credential.");

    console.log("[5/6] stopping the service through the authenticated CLI stop command...");
    const stopped = await runCli(dataDir, "stop");
    if (stopped.code !== 0) throw new DiagnosticError(`the stop command exited with code ${stopped.code}`);
    await Promise.race([service.exited, delay(8000)]);
    await waitUntilDown();
    console.log("[5/6] ok: service stopped cleanly.");

    console.log("[6/6] confirming files from an earlier version were left untouched...");
    for (const [name, contents] of Object.entries(OBSOLETE_FILES)) {
      const now = await readFile(join(dataDir, name), "utf8").catch(() => null);
      if (now !== contents) throw new DiagnosticError(`${safeLabel(name)} was changed or removed by the service`);
    }
    console.log("[6/6] ok: the old database, agent token, and lock file are unchanged.");

    console.log("LIFECYCLE_CHECK_PASS");
  } catch (error) {
    console.error(`LIFECYCLE_CHECK_FAIL: ${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    await stopChild(service);
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main();
