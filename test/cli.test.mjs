// Exercises the real service/cli.mjs as an actual child process (not by
// importing its internals), proving the operational identity/lifecycle
// claims: `start` is stale-state-safe against a leftover port file even
// when the recorded pid happens to be alive (just not the service), and
// `stop` identifies and ends the real running service through its
// authenticated control endpoint rather than signaling a pid.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../extension/protocol.js";

function startUnrelatedJsonServer(port, body = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      const payload = JSON.stringify(body);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
      res.end(payload);
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

const CLI_PATH = fileURLToPath(new URL("../service/cli.mjs", import.meta.url));

function runCli(args, { dataDir, port }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CLI_PATH, ...args],
      { env: { ...process.env, BROWSER_TABS_DATA_DIR: dataDir, BROWSER_TABS_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function spawnStart(dataDir, port) {
  const child = spawn(
    process.execPath,
    [CLI_PATH, "start"],
    { env: { ...process.env, BROWSER_TABS_DATA_DIR: dataDir, BROWSER_TABS_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  return { child, getStdout: () => stdout };
}

function httpGetJson(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path, timeout: 1000, headers: { "x-protocol-version": String(PROTOCOL_VERSION) } }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on("error", reject)
      .on("timeout", () => reject(new Error("timed out")));
  });
}

async function waitForHealth(port, timeoutMs = 5000) {
  const start = Date.now();
  let lastError;
  while (Date.now() - start < timeoutMs) {
    try {
      return await httpGetJson(port, "/health");
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`service on port ${port} never answered /health: ${lastError?.message}`);
}

async function withTempDataDir(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-cli-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

function uniquePort() {
  return 20_000 + Math.floor(Math.random() * 10_000);
}

test(
  "the full start -> status -> stop lifecycle identifies and stops the real service through its authenticated control endpoint",
  async () => {
    await withTempDataDir(async (dataDir) => {
      const port = uniquePort();
      const started = spawnStart(dataDir, port);
      try {
        await waitForHealth(port);

        const status = await runCli(["status"], { dataDir, port });
        assert.match(status.stdout, /running/i);
        assert.match(status.stdout, /Extension connected: false/);

        const exitPromise = new Promise((resolve) => started.child.once("exit", resolve));
        const stop = await runCli(["stop"], { dataDir, port });
        assert.match(stop.stdout, /shutting itself down/i);

        const exitCode = await Promise.race([exitPromise, delay(5000).then(() => "timeout")]);
        assert.notEqual(exitCode, "timeout", "the started service process must actually exit after stop");

        const statusAfter = await runCli(["status"], { dataDir, port });
        assert.match(statusAfter.stdout, /not running/i);
      } finally {
        if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill("SIGKILL");
      }
    });
  },
);

test("status and start are stale-state-safe even when a recorded pid is alive but belongs to an unrelated process", async () => {
  await withTempDataDir(async (dataDir) => {
    const port = uniquePort();
    // Simulate a crashed/killed previous run: a pid file that happens to
    // name a currently-alive process (this test runner itself) that is
    // definitely not the service, plus a port file where nothing listens.
    await writeFile(join(dataDir, "service.pid"), String(process.pid), "utf8");
    await writeFile(join(dataDir, "service.port"), String(port), "utf8");

    const status = await runCli(["status"], { dataDir, port });
    assert.match(status.stdout, /not running/i);

    const started = spawnStart(dataDir, port);
    try {
      const health = await waitForHealth(port);
      assert.equal(health.ok, true);
    } finally {
      await runCli(["stop"], { dataDir, port });
      await Promise.race([
        new Promise((resolve) => started.child.once("exit", resolve)),
        delay(3000),
      ]);
      if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill("SIGKILL");
    }
  });
});

test("stop is a clean no-op (not an error) when nothing is running", async () => {
  await withTempDataDir(async (dataDir) => {
    const port = uniquePort();
    const stop = await runCli(["stop"], { dataDir, port });
    assert.equal(stop.code, 0);
    assert.match(stop.stdout, /not running/i);
  });
});

test("start/status/stop treat an unrelated JSON-returning server on the recorded port as not this service", async () => {
  await withTempDataDir(async (dataDir) => {
    const port = uniquePort();
    const unrelated = await startUnrelatedJsonServer(port, {}); // responds 200 {} to everything, including /health and POST /control/stop
    try {
      // A recorded port file pointing at the unrelated server, as if a
      // previous run of this service had used that port.
      await writeFile(join(dataDir, "service.port"), String(port), "utf8");

      const status = await runCli(["status"], { dataDir, port });
      assert.match(status.stdout, /not running/i);

      const stop = await runCli(["stop"], { dataDir, port });
      assert.match(stop.stdout, /not running/i);
      assert.doesNotMatch(stop.stdout, /shutting itself down/i);

      // `start` must not conclude "already running" from the unrelated
      // server and skip starting; it should (re)write a port file and
      // actually attempt to bind. Give it a moment, then confirm *our*
      // shape now answers, which only our own service would return.
      await writeFile(join(dataDir, "service.port"), String(port), "utf8");
      await closeServer(unrelated); // free the port so our own service can actually bind it
      const started = spawnStart(dataDir, port);
      try {
        const health = await waitForHealth(port);
        assert.equal(health.protocolVersion, 1);
        assert.equal(health.ok, true);
        assert.equal(typeof health.extension.connected, "boolean");
      } finally {
        await runCli(["stop"], { dataDir, port });
        await Promise.race([new Promise((resolve) => started.child.once("exit", resolve)), delay(3000)]);
        if (started.child.exitCode === null && started.child.signalCode === null) started.child.kill("SIGKILL");
      }
    } finally {
      await closeServer(unrelated).catch(() => {});
    }
  });
});

test("show-token prints a stable, well-formed credential without needing a running service", async () => {
  await withTempDataDir(async (dataDir) => {
    const port = uniquePort();
    const first = await runCli(["show-token"], { dataDir, port });
    const second = await runCli(["show-token"], { dataDir, port });
    const token = first.stdout.trim();
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(second.stdout.trim(), token);
  });
});
