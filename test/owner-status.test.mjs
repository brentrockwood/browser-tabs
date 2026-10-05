// Stage 5 remediation: `GET /api/owner.status` — an extension-independent,
// authenticated, protocol-versioned probe the UI uses to validate the
// owner token on Connect (service/server.mjs's handleOwnerStatus). Unlike
// `browser.get_capabilities`, this route never touches the extension at
// all, so it must succeed for the owner scope even while the extension is
// disconnected, and it must explicitly reject agent scope (unlike
// `browser.get_capabilities`, which agent scope can also reach).
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { PROTOCOL_VERSION } from "../extension/protocol.js";
import { createService } from "../service/server.mjs";

const OWNER_TOKEN = "owner-status-owner-token-0123456789";
const AGENT_TOKEN = "owner-status-agent-token-0123456789";

function httpRequest({ port, path, method = "GET", headers = {} }) {
  const finalHeaders = { "x-protocol-version": String(PROTOCOL_VERSION), ...headers };
  for (const key of Object.keys(finalHeaders)) {
    if (finalHeaders[key] === undefined) delete finalHeaders[key];
  }
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: finalHeaders }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          // leave json null
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function withService(options, run) {
  const service = createService({ credentialToken: OWNER_TOKEN, port: 0, host: "127.0.0.1", ...options });
  const address = await service.listen();
  try {
    await run(address.port);
  } finally {
    await service.close().catch(() => {});
  }
}

test("owner.status succeeds for the owner credential with no extension connected at all", async () => {
  // No `store` and no extension connection configured — proves this route
  // never depends on either.
  await withService({}, async (port) => {
    const { status, json } = await httpRequest({ port, path: "/api/owner.status", headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    assert.equal(status, 200);
    assert.equal(json.protocolVersion, PROTOCOL_VERSION);
    assert.equal(json.result.scope, "owner");
  });
});

test("owner.status rejects the scoped external-agent credential with 403 forbidden_scope, never 200", async () => {
  await withService({ agentCredentialToken: AGENT_TOKEN }, async (port) => {
    const { status, json } = await httpRequest({ port, path: "/api/owner.status", headers: { authorization: `Bearer ${AGENT_TOKEN}` } });
    assert.equal(status, 403);
    assert.equal(json.error.code, "forbidden_scope");
  });
});

test("owner.status rejects a missing credential with 401 missing_credential", async () => {
  await withService({}, async (port) => {
    const { status, json } = await httpRequest({ port, path: "/api/owner.status" });
    assert.equal(status, 401);
    assert.equal(json.error.code, "missing_credential");
  });
});

test("owner.status rejects a wrong credential with 401 invalid_credential", async () => {
  await withService({}, async (port) => {
    const { status, json } = await httpRequest({ port, path: "/api/owner.status", headers: { authorization: "Bearer wrong-token" } });
    assert.equal(status, 401);
    assert.equal(json.error.code, "invalid_credential");
  });
});

test("owner.status rejects a non-GET method as an unknown route, same as any other method mismatch on this path", async () => {
  await withService({}, async (port) => {
    const { status } = await httpRequest({ port, path: "/api/owner.status", method: "POST", headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
    assert.equal(status, 404);
  });
});

test("owner.status still enforces the X-Protocol-Version requirement like every other /api/ route", async () => {
  await withService({}, async (port) => {
    const { status, json } = await httpRequest({
      port,
      path: "/api/owner.status",
      headers: { authorization: `Bearer ${OWNER_TOKEN}`, "x-protocol-version": undefined },
    });
    assert.equal(status, 400);
    assert.equal(json.error.code, "unsupported_protocol_version");
  });
});
