#!/usr/bin/env node
// Development service CLI: `start` (foreground), `status`, `stop`,
// `show-token` (re-display the owner pairing credential), and
// `show-agent-token` (re-display the separate, scoped Stage 4
// external-agent credential — see service/credential.mjs).
//
// `status` and `stop` identify a running service by actually probing the
// port recorded at `start` (GET /health), and `stop` tears it down through
// the authenticated POST /control/stop endpoint — never by signaling a
// recorded PID, which could have been reused by an unrelated process since
// the service that wrote it exited. `start`/`status` are stale-state-safe:
// a port file left over from a crashed/killed previous run is detected by
// the probe failing, not trusted at face value, and is cleaned up.
//
// Usage: node service/cli.mjs <start|status|stop|show-token|show-agent-token>

import http from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createService } from "./server.mjs";
import { getDataDir, loadOrCreateAgentCredential, loadOrCreateCredential } from "./credential.mjs";
import { openStore } from "./store.mjs";
import { DEFAULT_SERVICE_PORT, PROTOCOL_VERSION } from "../extension/protocol.js";

// Shared with the extension's fixed WebSocket target (see
// extension/service-client.js) so the two can never drift apart.
const DEFAULT_PORT = DEFAULT_SERVICE_PORT;
const dataDir = getDataDir();
const pidPath = join(dataDir, "service.pid"); // diagnostic only; never trusted for identity/liveness
const portPath = join(dataDir, "service.port");

async function readNumberFile(path) {
  try {
    const value = Number((await readFile(path, "utf8")).trim());
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function httpGetJson(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: "127.0.0.1", port, path, timeout: 2000, headers: { "x-protocol-version": String(PROTOCOL_VERSION) } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timed out waiting for the service")));
  });
}

// Confirms a /health body is actually *this project's* service, not merely
// some JSON-returning process that happens to occupy the recorded port:
// requires the matching protocol version, `ok === true`, and the specific
// shape handleHealth() in service/server.mjs actually returns. start/
// status/stop all route through this rather than trusting "valid JSON" or
// "HTTP 200" alone.
export function isOurServiceHealth(body) {
  // Wrapped in Boolean(...) so this always returns a strict boolean (never
  // `undefined`) regardless of how a malformed/unrelated shape short-
  // circuits the chain below — the validation itself is unchanged.
  return Boolean(
    body !== null &&
      typeof body === "object" &&
      body.protocolVersion === PROTOCOL_VERSION &&
      body.ok === true &&
      body.service !== null &&
      typeof body.service === "object" &&
      typeof body.service.startedAt === "number" &&
      body.extension !== null &&
      typeof body.extension === "object" &&
      typeof body.extension.connected === "boolean",
  );
}

async function httpGetOurHealth(port) {
  const body = await httpGetJson(port, "/health");
  if (!isOurServiceHealth(body)) {
    throw new Error(
      `port ${port} answered with JSON that is not this project's service health shape: ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return body;
}

function httpControlStop(port, token) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/control/stop",
        method: "POST",
        timeout: 2000,
        headers: { authorization: `Bearer ${token}`, "x-protocol-version": String(PROTOCOL_VERSION) },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`service responded with status ${res.statusCode}`));
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timed out waiting for the service")));
    req.end();
  });
}

async function cleanupStateFiles() {
  await rm(pidPath, { force: true });
  await rm(portPath, { force: true });
}

async function cmdStart() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });

  const port = Number(process.env.BROWSER_TABS_PORT) || DEFAULT_PORT;

  const existingPort = await readNumberFile(portPath);
  if (existingPort) {
    try {
      await httpGetOurHealth(existingPort);
      console.log(`Service already running on port ${existingPort}. Use "status" or "stop".`);
      return;
    } catch {
      console.log(
        `Found a stale port file for ${existingPort} (nothing responded there, or it is not this project's ` +
          "service); starting fresh.",
      );
      await cleanupStateFiles();
    }
  }

  const { token, created } = await loadOrCreateCredential(dataDir);
  // Stage 4: a distinct, separately-stored credential for external-agent
  // callers (see service/credential.mjs). Loaded/created unconditionally,
  // exactly like the owner credential above, so it is always available for
  // an operator who wants to hand a scoped token to an agent — but it is a
  // different value in a different file, and authorizes only the
  // server-side allowlists in service/server.mjs, never full access.
  const { token: agentToken, created: agentCreated } = await loadOrCreateAgentCredential(dataDir);
  const agentCreatorName = process.env.BROWSER_TABS_AGENT_NAME || "reference-agent";

  // Stage 3: created on first start, migrated forward on every start (see
  // service/store.mjs). Logging here deliberately never includes
  // credentials or browser content — only operational messages (db path,
  // migration version numbers) — project.md Stage 3's logging requirement.
  // Opening the store is best-effort at this layer: a Node.js runtime
  // without `node:sqlite` (see store.mjs's own error message) must not take
  // down the Stage 1/2 bridge, which has no dependency on it — the service
  // still starts, and every store.* route explicitly reports
  // `store_unavailable` (service/server.mjs) rather than the whole process
  // failing to start.
  let store = null;
  try {
    store = await openStore({ dataDir, log: (message) => console.log(`[store] ${message}`) });
  } catch (error) {
    console.log(`[store] unavailable, continuing without the derived store: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Deliberately a separate try/catch from the one above: opening the
  // store succeeding or failing is a different fact from retention
  // cleanup succeeding or failing once it is open. Folding both into one
  // catch would misreport a cleanup failure as "store unavailable" (the
  // store did open — `store` is non-null, store.* routes remain
  // available) and could equally hide a real store-open failure behind a
  // "retention cleanup failed" message that never applies when there is no
  // store to clean up. Cleanup failing never prevents the service from
  // starting with an otherwise-working store.
  if (store) {
    try {
      const cleanupResult = store.runRetentionCleanup();
      if (cleanupResult.enabled) {
        console.log(
          `[store] retention cleanup removed ${cleanupResult.deletedCaptures} capture(s), ` +
            `${cleanupResult.deletedSummaries} summary(ies), and ${cleanupResult.deletedProposals} proposal(s).`,
        );
      }
    } catch (error) {
      console.log(
        `[store] retention cleanup failed (the store itself remains open and available): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Shutting down...");
    await service.close();
    store?.close();
    await cleanupStateFiles();
    process.exit(0);
  };

  const service = createService({
    credentialToken: token,
    agentCredentialToken: agentToken,
    agentCreatorName,
    port,
    host: "127.0.0.1",
    store,
    onControlStop: shutdown,
  });
  const address = await service.listen();

  await writeFile(portPath, String(address.port), "utf8");
  await writeFile(pidPath, String(process.pid), "utf8");

  console.log(`Browser Tabs service listening on http://127.0.0.1:${address.port} (loopback only).`);
  if (created) {
    console.log("First run: generated a new pairing credential.");
    console.log(`Pairing token (paste into the extension's options page): ${token}`);
    console.log('Not printed again by default; re-display it with "show-token" if needed.');
  } else {
    console.log("Using the existing pairing credential; the extension does not need to re-pair.");
  }
  if (agentCreated) {
    console.log("First run: generated a new, separate external-agent credential.");
    console.log(`External-agent token (scoped; set as BROWSER_TABS_AGENT_TOKEN for an agent caller): ${agentToken}`);
    console.log('Not printed again by default; re-display it with "show-agent-token" if needed.');
  } else {
    console.log("Using the existing external-agent credential.");
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function cmdStatus() {
  const port = await readNumberFile(portPath);
  if (!port) {
    console.log("Service: not running");
    return;
  }
  try {
    const body = await httpGetOurHealth(port);
    console.log(`Service: running (port ${port})`);
    console.log(`Extension connected: ${body.extension.connected}`);
  } catch (error) {
    console.log(`Service: not running (stale state for port ${port} cleaned up: ${error.message})`);
    await cleanupStateFiles();
  }
}

async function cmdStop() {
  const port = await readNumberFile(portPath);
  if (!port) {
    console.log("Service: not running");
    await cleanupStateFiles();
    return;
  }

  // Confirm it is actually this project's service before doing anything
  // else: an arbitrary JSON-returning process sitting on the recorded port
  // is treated the same as nothing being there at all, not as "our
  // service responded 200 so the stop worked."
  try {
    await httpGetOurHealth(port);
  } catch (error) {
    console.log(`Service: not running (port ${port} is not this project's service: ${error.message})`);
    await cleanupStateFiles();
    return;
  }

  const { token } = await loadOrCreateCredential(dataDir);
  try {
    await httpControlStop(port, token);
    console.log(`Stop requested on port ${port}; the service is shutting itself down.`);
    await cleanupStateFiles();
  } catch (error) {
    // The service was just confirmed to be ours and running; a failed stop
    // request here is transient (auth hiccup, timeout, etc.), not evidence
    // it is gone. Leave the recorded port/pid in place so a retry (or
    // `status`) still has something accurate to work with, rather than
    // discarding state that may still be the only record of a service
    // that is, in fact, still running.
    console.log(
      `Found the service on port ${port} but could not complete an authenticated stop request (${error.message}); ` +
        "it is probably still running. Not clearing recorded state; try again, or end it manually.",
    );
  }
}

async function cmdShowToken() {
  const { token } = await loadOrCreateCredential(dataDir);
  console.log(token);
}

// Stage 4: re-displays the separate external-agent credential, the same
// way "show-token" re-displays the owner one — a distinct command because
// it is a distinct file/token, never printed automatically after first run.
async function cmdShowAgentToken() {
  const { token } = await loadOrCreateAgentCredential(dataDir);
  console.log(token);
}

const [, , command] = process.argv;
switch (command) {
  case "start":
    await cmdStart();
    break;
  case "status":
    await cmdStatus();
    break;
  case "stop":
    await cmdStop();
    break;
  case "show-token":
    await cmdShowToken();
    break;
  case "show-agent-token":
    await cmdShowAgentToken();
    break;
  default:
    console.error("Usage: node service/cli.mjs <start|status|stop|show-token|show-agent-token>");
    process.exitCode = 1;
}
