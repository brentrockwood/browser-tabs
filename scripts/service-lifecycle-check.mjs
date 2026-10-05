#!/usr/bin/env node
// Stage 6: "Verify that the service runs on Linux even if desktop packaging
// remains a later task" (project.md). No browser or extension is involved
// here at all — this proves the service itself (start, status via /health,
// an authenticated store write, a real process restart, and stop) using
// only Node.js and the real service/cli.mjs child process, so it is exactly
// as meaningful run on Linux as on macOS. See .github/workflows/ci.yml,
// which runs this on both.
//
// Usage: node scripts/service-lifecycle-check.mjs
// Exit code: 0 on success, 1 otherwise, with the failing step printed.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

    console.log("[2/6] creating a tag through the authenticated store API...");
    const createResponse = await request("/api/store.tags.create", {
      method: "POST",
      token,
      body: { name: "lifecycle-check", creatorType: "user" },
    });
    if (createResponse.status !== 200) {
      throw new DiagnosticError(
        `store.tags.create failed (HTTP status ${createResponse.status}, error code ${safeLabel(createResponse.json?.error?.code)})`,
      );
    }
    const tagId = createResponse.json.result.id;
    console.log(`[2/6] ok: created tag ${safeLabel(String(tagId))}.`);

    console.log("[3/6] stopping the service...");
    await stopChild(service);
    await waitUntilDown();
    console.log("[3/6] ok: service is down.");

    console.log("[4/6] starting the service again against the same data directory...");
    service = spawnService(dataDir);
    // The CLI prints tokens only on first creation, so the restart reuses the
    // token captured from the first start (it is persisted, not regenerated).
    await waitForHealth();
    const persisted = (await readFile(join(dataDir, "credential"), "utf8")).trim();
    if (persisted !== token) throw new DiagnosticError("the persisted credential file does not match the first-start token");
    console.log("[4/6] ok: service restarted with the same persisted credential.");

    console.log("[5/6] confirming the tag survived the restart (local store persistence)...");
    const listResponse = await request(`/api/store.tags.list?id=${tagId}`, { token });
    const found = listResponse.json?.result?.items?.some((item) => item.id === tagId && item.name === "lifecycle-check");
    if (!found) throw new DiagnosticError(`tag ${safeLabel(String(tagId))} did not survive the restart (HTTP status ${listResponse.status})`);
    console.log("[5/6] ok: the tag persisted across a real process restart.");

    console.log("[6/6] stopping the service...");
    await stopChild(service);
    await waitUntilDown();
    console.log("[6/6] ok: service stopped cleanly.");

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
