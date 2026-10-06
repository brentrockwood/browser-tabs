// Regression tests for the Host-header defense
// against DNS rebinding and similar Host-header-confusion attacks
// (service/server.mjs's checkHost). This service binds only to loopback,
// but loopback alone does not stop a page served from an
// attacker-controlled DNS name that *resolves* to 127.0.0.1 from causing
// a victim's own browser to issue a request here with an arbitrary Host
// header — the browser sets Host from the navigated-to hostname, not the
// resolved IP. These tests drive raw sockets directly (bypassing Node's
// own `http` client, which would normalize/derive a correct Host header
// itself) so the exact bytes a real rebinding attack could send are what
// is actually exercised.
import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import WebSocket from "ws";

import { ERROR_CODES, PROTOCOL_VERSION } from "../extension/protocol.js";
import { createService } from "../service/server.mjs";

const TOKEN = "host-defense-token-0123456789";
const EXTENSION_ORIGIN = "chrome-extension://host-defense-test-extension";

async function withService(options, run) {
  const service = createService({ credentialToken: TOKEN, port: 0, host: "127.0.0.1", ...options });
  const address = await service.listen();
  try {
    await run(address.port);
  } finally {
    await service.close().catch(() => {});
  }
}

// Sends a hand-written raw HTTP/1.1 request, with full control over every
// header (including Host) and no normalization by any HTTP client
// library — the only way to actually send a Host header a real client
// would never construct on its own, and to prove the *server* (not some
// client-side guard) is what rejects it.
function sendRawRequest(port, requestLine, headers, body = "") {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => {
      const headerLines = Object.entries(headers)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n");
      socket.write(`${requestLine}\r\n${headerLines}\r\n\r\n${body}`);
    });
    let data = "";
    socket.on("data", (chunk) => (data += chunk.toString()));
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("timed out waiting for a response"));
    });
  });
}

function parseRawResponse(raw) {
  const [head, body = ""] = raw.split("\r\n\r\n");
  const statusLine = head.split("\r\n")[0];
  const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(statusLine)?.[1]);
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    // leave json null
  }
  return { statusLine, status, body, json };
}

const EVIL_HOSTS = [
  "evil.example:80", // an attacker-controlled DNS name resolving to 127.0.0.1 — the canonical DNS-rebinding shape
  "evil.example", // same, with no port at all
  "localhost:__PORT__", // a *different* loopback hostname, even naming the real port
  "127.0.0.1:1", // right hostname, wrong (arbitrary) port
  "127.0.0.1", // right hostname, missing port entirely
  "127.0.0.1:__PORT__evil", // malformed trailing garbage after a correct-looking prefix
];

function substitutePort(host, port) {
  return host.replaceAll("__PORT__", String(port));
}

test("DNS-rebinding/evil-Host regression: a mutation route is rejected with 421 before its body is read or anything is forwarded", async () => {
  await withService({}, async (port) => {
    const body = JSON.stringify({ browserSessionId: "s", tabIds: [1], groupId: null });
    for (const hostTemplate of EVIL_HOSTS) {
      const host = substitutePort(hostTemplate, port);
      const raw = await sendRawRequest(port, "POST /api/browser.move_tabs HTTP/1.1", {
        Host: host,
        Authorization: `Bearer ${TOKEN}`,
        "X-Protocol-Version": String(PROTOCOL_VERSION),
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        Connection: "close",
      }, body);
      const { status, json } = parseRawResponse(raw);
      assert.equal(status, 421, `Host "${host}" was not rejected with 421: ${raw.slice(0, 300)}`);
      assert.equal(json?.error?.code, ERROR_CODES.INVALID_HOST);
    }
  });
});

test("DNS-rebinding/evil-Host regression: an authenticated /api/ route is rejected with 421 before authentication is even considered", async () => {
  await withService({}, async (port) => {
    for (const hostTemplate of EVIL_HOSTS) {
      const host = substitutePort(hostTemplate, port);
      const raw = await sendRawRequest(port, "GET /api/browser.list_windows HTTP/1.1", {
        Host: host,
        Authorization: `Bearer ${TOKEN}`,
        "X-Protocol-Version": String(PROTOCOL_VERSION),
        Connection: "close",
      });
      const { status, json } = parseRawResponse(raw);
      assert.equal(status, 421, `Host "${host}" was not rejected with 421 even with a valid credential: ${raw.slice(0, 300)}`);
      assert.equal(json?.error?.code, ERROR_CODES.INVALID_HOST);
    }
  });
});

test("DNS-rebinding/evil-Host regression: /control/stop is rejected with 421, never reaching authentication", async () => {
  await withService({}, async (port) => {
    const raw = await sendRawRequest(port, "POST /control/stop HTTP/1.1", {
      Host: "evil.example",
      Authorization: `Bearer ${TOKEN}`,
      "X-Protocol-Version": String(PROTOCOL_VERSION),
      "Content-Length": "0",
      Connection: "close",
    });
    const { status, json } = parseRawResponse(raw);
    assert.equal(status, 421);
    assert.equal(json?.error?.code, ERROR_CODES.INVALID_HOST);

    // The service must still be up afterward — this must not have shut it
    // down, and it must still answer an ordinary, correctly-Hosted request.
    const health = await sendRawRequest(port, "GET /health HTTP/1.1", {
      Host: `127.0.0.1:${port}`,
      "X-Protocol-Version": String(PROTOCOL_VERSION),
      Connection: "close",
    });
    assert.equal(parseRawResponse(health).status, 200);
  });
});

test("DNS-rebinding/evil-Host regression: /health itself is rejected with 421 for a non-canonical Host", async () => {
  await withService({}, async (port) => {
    const raw = await sendRawRequest(port, "GET /health HTTP/1.1", { Host: "evil.example", Connection: "close" });
    const { status, json } = parseRawResponse(raw);
    assert.equal(status, 421);
    assert.equal(json?.error?.code, ERROR_CODES.INVALID_HOST);
  });
});

test("a request with no Host header at all is rejected", async () => {
  await withService({}, async (port) => {
    const raw = await sendRawRequest(port, "GET /health HTTP/1.1", { Host: undefined, Connection: "close" });
    const { status, body } = parseRawResponse(raw);
    // Node's HTTP/1.1 parser rejects a missing mandatory Host header with
    // 400 before the application request handler can return its own 421.
    assert.equal(status, 400, `a request with no Host header was not rejected: ${raw.slice(0, 300)}`);
    assert.doesNotMatch(body, /<html|<!DOCTYPE/i);
  });
});

test("a canonical 127.0.0.1:<port> Host is accepted normally (no regression)", async () => {
  await withService({}, async (port) => {
    const raw = await sendRawRequest(port, "GET /health HTTP/1.1", {
      Host: `127.0.0.1:${port}`,
      "X-Protocol-Version": String(PROTOCOL_VERSION),
      Connection: "close",
    });
    const { status, json } = parseRawResponse(raw);
    assert.equal(status, 200);
    assert.equal(json?.ok, true);
  });
});

test("DNS-rebinding/evil-Host regression: the extension WebSocket upgrade is rejected before the Origin check", async () => {
  await withService({}, async (port) => {
    // A hand-built upgrade request with a trusted chrome-extension://
    // Origin but an evil Host — proving Host is checked independently of,
    // and before, the existing Origin check (which alone a real
    // DNS-rebinding page could never satisfy anyway, but defense-in-depth
    // means Host must still be checked on this path too).
    const raw = await sendRawRequest(port, "GET /extension HTTP/1.1", {
      Host: "evil.example",
      Origin: EXTENSION_ORIGIN,
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version": "13",
    });
    const { statusLine } = parseRawResponse(raw);
    assert.match(statusLine, /^HTTP\/1\.1 421/, `expected a 421 rejection, got: ${statusLine}`);

    // A real extension connection (correct Host, implicit via the `ws`
    // client's own URL-derived Host header) must still work afterward.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { origin: EXTENSION_ORIGIN });
    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    ws.close();
  });
});
