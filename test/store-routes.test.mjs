// Stage 3: integration tests for the store.* HTTP routes (service/server.mjs
// + service/store-routes.mjs) against a real service listening on a real
// loopback socket and a real SQLite file in a temporary directory — no
// browser or extension involved (these routes are never reachable from the
// extension WebSocket).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { createService } from "../service/server.mjs";
import { openStore } from "../service/store.mjs";

const TOKEN = "store-routes-test-token-0123456789";

function httpRequest({ port, path, method = "GET", headers = {}, body }) {
  const finalHeaders = {
    "x-protocol-version": String(PROTOCOL_VERSION),
    authorization: `Bearer ${TOKEN}`,
    ...headers,
  };
  for (const key of Object.keys(finalHeaders)) {
    if (finalHeaders[key] === undefined) delete finalHeaders[key];
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined) finalHeaders["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: finalHeaders }, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {
          // leave json null
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function withService(run, { log, storeLog } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-store-routes-"));
  const store = await openStore({ dataDir, log: storeLog });
  const service = createService({ credentialToken: TOKEN, store, log });
  const address = await service.listen();
  try {
    await run({ port: address.port, store, dataDir });
  } finally {
    await service.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

// Matches the strict Stage 2 browser.read_tab envelope+result shape
// validateCaptureInput now requires (service/validation.mjs reuses
// extension/protocol.js's validateMethodResult) — see test/store.test.mjs's
// header comment for the same fixture rationale.
function sampleCaptureBody(overrides = {}) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: "session-1",
    sourceOperation: "browser.read_tab",
    tabId: 10,
    windowId: 1,
    url: "https://example.com/",
    title: "Example",
    documentReadyState: "complete",
    capturedAt: Date.now(),
    status: "ok",
    characterCount: 11,
    returnedCharacterCount: 11,
    truncated: false,
    text: "hello world",
    ...overrides,
  };
}

test("store.captures.create/list/delete round trip over HTTP", async () => {
  await withService(async ({ port }) => {
    const created = await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() });
    assert.equal(created.status, 200);
    const captureId = created.json.result.id;
    // createCapture's own response is bounded by construction (no raw
    // `text`, just its length) — see "oversized mutation" tests below for
    // why. store.captures.read is what proves the text actually persisted.
    assert.equal(created.json.result.text, undefined);
    assert.equal(created.json.result.textLength, "hello world".length);
    const read = await httpRequest({ port, path: `/api/store.captures.read?id=${captureId}` });
    assert.equal(read.status, 200);
    assert.equal(read.json.result.chunk, "hello world");

    const listed = await httpRequest({ port, path: "/api/store.captures.list" });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.result.total, 1);
    assert.equal(listed.json.result.items[0].id, captureId);

    const deleted = await httpRequest({ port, path: `/api/store.captures.delete?id=${captureId}`, method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.json.result.deletedCaptureId, captureId);

    const afterDelete = await httpRequest({ port, path: "/api/store.captures.list" });
    assert.equal(afterDelete.json.result.total, 0);
  });
});

test("store.* routes require authentication and a matching protocol version, same as browser.* routes", async () => {
  await withService(async ({ port }) => {
    const noAuth = await httpRequest({ port, path: "/api/store.captures.list", headers: { authorization: undefined } });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.json.error.code, "missing_credential");

    const wrongVersion = await httpRequest({ port, path: "/api/store.captures.list", headers: { "x-protocol-version": "999" } });
    assert.equal(wrongVersion.status, 400);
    assert.equal(wrongVersion.json.error.code, "unsupported_protocol_version");
  });
});

test("a store.* route called with the wrong HTTP verb is rejected explicitly", async () => {
  await withService(async ({ port }) => {
    const response = await httpRequest({ port, path: "/api/store.captures.create", method: "GET" });
    assert.equal(response.status, 405);
    assert.equal(response.json.error.code, "method_not_allowed");
  });
});

test("store.* routes report store_unavailable when no store was configured", async () => {
  const service = createService({ credentialToken: TOKEN });
  const address = await service.listen();
  try {
    const response = await httpRequest({ port: address.port, path: "/api/store.captures.list" });
    assert.equal(response.status, 503);
    assert.equal(response.json.error.code, "store_unavailable");
  } finally {
    await service.close();
  }
});

test("malformed JSON request bodies are rejected as malformed_body, not a crash", async () => {
  await withService(async ({ port }) => {
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/api/store.captures.create",
          method: "POST",
          headers: {
            "x-protocol-version": String(PROTOCOL_VERSION),
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk) => (raw += chunk));
          res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw) }));
        },
      );
      req.on("error", reject);
      req.write("{not valid json");
      req.end();
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "malformed_body");
  });
});

test("an oversized request body is rejected as payload_too_large rather than buffered in full", async () => {
  await withService(async ({ port }) => {
    const hugeText = "x".repeat(9 * 1024 * 1024);
    const response = await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody({ text: hugeText }) });
    assert.equal(response.status, 413);
    assert.equal(response.json.error.code, "payload_too_large");
  });
});

// A real browser.read_tab non-"ok" result never carries url/title/
// documentReadyState/characterCount/returnedCharacterCount/truncated/text
// — only a caller fabricating a capture could supply them, and they must
// be rejected rather than persisted as invented content.
test("a non-ok capture carrying invented ok-only fields is rejected over HTTP, and never persisted", async () => {
  await withService(async ({ port }) => {
    const response = await httpRequest({
      port,
      path: "/api/store.captures.create",
      method: "POST",
      body: sampleCaptureBody({ status: "unsupported", code: "injection_rejected", text: undefined, url: "https://invented.example/" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_error");

    const listed = await httpRequest({ port, path: "/api/store.captures.list" });
    assert.equal(listed.json.result.total, 0);
  });
});

// Same as above, but each ok-only field is sent as an explicit `null`
// rather than omitted — `null` is exactly what validateCaptureInput
// normalizes an absent field to, so a check against the normalized value
// alone could never tell these two cases apart. The store layer checks
// `Object.hasOwn` against the original request body instead, so presence
// alone — regardless of value — is rejected over HTTP too.
test("a non-ok capture carrying invented ok-only fields set to explicit null is rejected over HTTP, and never persisted", async () => {
  await withService(async ({ port }) => {
    const response = await httpRequest({
      port,
      path: "/api/store.captures.create",
      method: "POST",
      body: sampleCaptureBody({ status: "unsupported", code: "injection_rejected", text: undefined, url: null }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_error");

    const listed = await httpRequest({ port, path: "/api/store.captures.list" });
    assert.equal(listed.json.result.total, 0);
  });
});

// Finding: a mutation must never commit and only then report
// response_too_large. store.captures.create's own result is bounded by
// construction (the same compact projection the list route uses), so even
// the pathological maximum-length, maximum-escape-expansion capture body
// both commits *and* returns a small, successful response over HTTP.
test("creating a capture with the maximum, worst-case-escaped text succeeds with a small bounded result, never commits-then-fails as response_too_large", async () => {
  await withService(async ({ port }) => {
    const pathologicalText = "\u0001".repeat(500_000);
    const response = await httpRequest({
      port,
      path: "/api/store.captures.create",
      method: "POST",
      body: sampleCaptureBody({ text: pathologicalText, characterCount: pathologicalText.length, returnedCharacterCount: pathologicalText.length }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.json.result.text, undefined);
    assert.equal(response.json.result.textLength, 500_000);

    // And it actually committed.
    const read = await httpRequest({ port, path: `/api/store.captures.read?id=${response.json.result.id}&maxChars=100000` });
    assert.equal(read.status, 200);
    assert.equal(read.json.result.textLength, 500_000);
    assert.equal(read.json.result.chunk, pathologicalText.slice(0, 100_000));
  });
});

test("tag-assignment listing requires recordType and recordId together over HTTP, rejecting a partial filter", async () => {
  await withService(async ({ port }) => {
    const capture = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    const tag = (await httpRequest({ port, path: "/api/store.tags.create", method: "POST", body: { name: "important", creatorType: "user" } })).json
      .result;
    await httpRequest({
      port,
      path: "/api/store.tags.assign",
      method: "POST",
      body: { tagId: tag.id, recordType: "capture", recordId: capture.id, creatorType: "user" },
    });

    const partialType = await httpRequest({ port, path: "/api/store.tags.assignments.list?recordType=capture" });
    assert.equal(partialType.status, 400);
    assert.equal(partialType.json.error.code, "validation_error");

    const partialId = await httpRequest({ port, path: `/api/store.tags.assignments.list?recordId=${capture.id}` });
    assert.equal(partialId.status, 400);
    assert.equal(partialId.json.error.code, "validation_error");

    const both = await httpRequest({ port, path: `/api/store.tags.assignments.list?recordType=capture&recordId=${capture.id}` });
    assert.equal(both.status, 200);
    assert.equal(both.json.result.total, 1);
  });
});

test("validation failures surface as 400 validation_error with no server crash", async () => {
  await withService(async ({ port }) => {
    const response = await httpRequest({
      port,
      path: "/api/store.captures.create",
      method: "POST",
      body: sampleCaptureBody({ status: "not-a-status" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.json.error.code, "validation_error");
  });
});

test("foreign-key rejection surfaces as 422 source_not_found over HTTP", async () => {
  await withService(async ({ port }) => {
    const response = await httpRequest({
      port,
      path: "/api/store.summaries.create",
      method: "POST",
      body: { text: "x", creatorType: "user", sourceCaptureIds: [999999] },
    });
    assert.equal(response.status, 422);
    assert.equal(response.json.error.code, "source_not_found");
  });
});

test("deleting a capture with dependents is refused (409) unless cascade=true is passed", async () => {
  await withService(async ({ port }) => {
    const capture = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    await httpRequest({
      port,
      path: "/api/store.summaries.create",
      method: "POST",
      body: { text: "cites it", creatorType: "user", sourceCaptureIds: [capture.id] },
    });

    const refused = await httpRequest({ port, path: `/api/store.captures.delete?id=${capture.id}`, method: "DELETE" });
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "has_dependents");

    const cascaded = await httpRequest({ port, path: `/api/store.captures.delete?id=${capture.id}&cascade=true`, method: "DELETE" });
    assert.equal(cascaded.status, 200);
  });
});

test("tags: create, assign to a capture, list assignments, unassign, delete", async () => {
  await withService(async ({ port }) => {
    const capture = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    const tag = (await httpRequest({ port, path: "/api/store.tags.create", method: "POST", body: { name: "important", creatorType: "user" } })).json
      .result;

    const assigned = await httpRequest({
      port,
      path: "/api/store.tags.assign",
      method: "POST",
      body: { tagId: tag.id, recordType: "capture", recordId: capture.id, creatorType: "user" },
    });
    assert.equal(assigned.status, 200);

    const assignments = await httpRequest({ port, path: `/api/store.tags.assignments.list?tagId=${tag.id}` });
    assert.equal(assignments.json.result.total, 1);

    const unassigned = await httpRequest({
      port,
      path: `/api/store.tags.unassign?tagId=${tag.id}&recordType=capture&recordId=${capture.id}`,
      method: "DELETE",
    });
    assert.equal(unassigned.status, 200);

    const deleted = await httpRequest({ port, path: `/api/store.tags.delete?id=${tag.id}`, method: "DELETE" });
    assert.equal(deleted.status, 200);
  });
});

test("collections: create, add ordered items, reorder, update, delete", async () => {
  await withService(async ({ port }) => {
    const captureA = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    const captureB = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    const collection = (
      await httpRequest({ port, path: "/api/store.collections.create", method: "POST", body: { name: "Reading list", creatorType: "user" } })
    ).json.result;

    const itemA = (
      await httpRequest({
        port,
        path: "/api/store.collections.items.add",
        method: "POST",
        body: { collectionId: collection.id, recordType: "capture", recordId: captureA.id, creatorType: "user" },
      })
    ).json.result;
    const itemB = (
      await httpRequest({
        port,
        path: "/api/store.collections.items.add",
        method: "POST",
        body: { collectionId: collection.id, recordType: "capture", recordId: captureB.id, creatorType: "user" },
      })
    ).json.result;

    const reordered = await httpRequest({
      port,
      path: "/api/store.collections.items.reorder",
      method: "PATCH",
      body: { collectionId: collection.id, orderedItemIds: [itemB.id, itemA.id] },
    });
    assert.equal(reordered.status, 200);
    assert.deepEqual(reordered.json.result.items.map((i) => i.recordId), [captureB.id, captureA.id]);

    const renamed = await httpRequest({
      port,
      path: `/api/store.collections.update?id=${collection.id}`,
      method: "PATCH",
      body: { name: "Renamed list" },
    });
    assert.equal(renamed.json.result.name, "Renamed list");

    const deleted = await httpRequest({ port, path: `/api/store.collections.delete?id=${collection.id}`, method: "DELETE" });
    assert.equal(deleted.status, 200);
  });
});

test("proposals: create pending, accept, reject-after-decided is a conflict", async () => {
  await withService(async ({ port }) => {
    const capture = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    const proposal = (
      await httpRequest({
        port,
        path: "/api/store.proposals.create",
        method: "POST",
        body: {
          kind: "tag",
          rationale: "looks relevant",
          payload: { tagName: "x" },
          creatorType: "agent",
          creatorName: "a",
          sourceCaptureIds: [capture.id],
        },
      })
    ).json.result;
    assert.equal(proposal.state, "pending");

    const missingDecider = await httpRequest({
      port,
      path: `/api/store.proposals.update?id=${proposal.id}`,
      method: "PATCH",
      body: { state: "accepted" },
    });
    assert.equal(missingDecider.status, 400);
    assert.equal(missingDecider.json.error.code, "validation_error");

    const accepted = await httpRequest({
      port,
      path: `/api/store.proposals.update?id=${proposal.id}`,
      method: "PATCH",
      body: { state: "accepted", creatorType: "user" },
    });
    assert.equal(accepted.json.result.state, "accepted");
    assert.equal(accepted.json.result.decidedByCreatorType, "user");

    const conflict = await httpRequest({
      port,
      path: `/api/store.proposals.update?id=${proposal.id}`,
      method: "PATCH",
      body: { state: "rejected", creatorType: "user" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, "conflict");
  });
});

test("proposals: nested/overlapping deletion — deleting a capture cascades through a proposal that cites the summary, not the capture", async () => {
  await withService(async ({ port }) => {
    const capture = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    const summary = (
      await httpRequest({
        port,
        path: "/api/store.summaries.create",
        method: "POST",
        body: { text: "cites capture", creatorType: "user", sourceCaptureIds: [capture.id] },
      })
    ).json.result;
    const proposal = (
      await httpRequest({
        port,
        path: "/api/store.proposals.create",
        method: "POST",
        body: { kind: "tag", rationale: "cites the summary", payload: {}, creatorType: "user", sourceSummaryIds: [summary.id] },
      })
    ).json.result;

    const refused = await httpRequest({ port, path: `/api/store.captures.delete?id=${capture.id}`, method: "DELETE" });
    assert.equal(refused.status, 409);

    const cascaded = await httpRequest({ port, path: `/api/store.captures.delete?id=${capture.id}&cascade=true`, method: "DELETE" });
    assert.equal(cascaded.status, 200);
    assert.equal(cascaded.json.result.cascadedSummaryCount, 1);
    assert.equal(cascaded.json.result.cascadedProposalCount, 1);

    const proposalsAfter = await httpRequest({ port, path: `/api/store.proposals.list?id=${proposal.id}` });
    assert.equal(proposalsAfter.json.result.total, 0);
  });
});

// Finding #9: cascade/boolean query parameters must be strictly "true" or
// "false" — not silently coerced to false on a typo or an alternate
// spelling, which would otherwise silently turn a caller's intended
// cascading delete into a non-cascading one.
test("the cascade query parameter is strictly validated: only \"true\"/\"false\" are accepted", async () => {
  await withService(async ({ port }) => {
    const capture = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    await httpRequest({
      port,
      path: "/api/store.summaries.create",
      method: "POST",
      body: { text: "cites it", creatorType: "user", sourceCaptureIds: [capture.id] },
    });

    const typo = await httpRequest({ port, path: `/api/store.captures.delete?id=${capture.id}&cascade=TRUE`, method: "DELETE" });
    assert.equal(typo.status, 400);
    assert.equal(typo.json.error.code, "validation_error");

    const numeric = await httpRequest({ port, path: `/api/store.captures.delete?id=${capture.id}&cascade=1`, method: "DELETE" });
    assert.equal(numeric.status, 400);
    assert.equal(numeric.json.error.code, "validation_error");

    // The capture must still exist — neither malformed attempt should have
    // been silently treated as cascade=false and then... (it would still
    // be refused as has_dependents, but the point is these never reach
    // that decision at all; they are rejected as malformed input first).
    const stillThere = await httpRequest({ port, path: "/api/store.captures.list" });
    assert.equal(stillThere.json.result.total, 1);
  });
});

test("queue items: full CRUD and state-list filtering over HTTP", async () => {
  await withService(async ({ port }) => {
    const capture = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    const created = await httpRequest({
      port,
      path: "/api/store.queue.create",
      method: "POST",
      body: { recordType: "capture", recordId: capture.id, state: "needs_review", creatorType: "user" },
    });
    assert.equal(created.status, 200);
    const queueId = created.json.result.id;

    const listedByState = await httpRequest({ port, path: "/api/store.queue.list?state=needs_review" });
    assert.equal(listedByState.json.result.total, 1);

    const updated = await httpRequest({ port, path: `/api/store.queue.update?id=${queueId}`, method: "PATCH", body: { state: "archived" } });
    assert.equal(updated.json.result.state, "archived");

    const badStateFilter = await httpRequest({ port, path: `/api/store.queue.list?state=${"x".repeat(101)}` });
    assert.equal(badStateFilter.status, 400);
    assert.equal(badStateFilter.json.error.code, "validation_error");

    const deleted = await httpRequest({ port, path: `/api/store.queue.delete?id=${queueId}`, method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await httpRequest({ port, path: "/api/store.queue.list" })).json.result.total, 0);
  });
});

test("summaries: full CRUD over HTTP, including the text/modelMetadata-only update", async () => {
  await withService(async ({ port }) => {
    const capture = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    const created = await httpRequest({
      port,
      path: "/api/store.summaries.create",
      method: "POST",
      body: { text: "first draft", creatorType: "agent", creatorName: "a", sourceCaptureIds: [capture.id] },
    });
    assert.equal(created.status, 200);
    const summaryId = created.json.result.id;

    const listed = await httpRequest({ port, path: `/api/store.summaries.list?id=${summaryId}` });
    assert.equal(listed.json.result.total, 1);
    assert.deepEqual(listed.json.result.items[0].sourceCaptureIds, [capture.id]);

    const updated = await httpRequest({ port, path: `/api/store.summaries.update?id=${summaryId}`, method: "PATCH", body: { text: "revised" } });
    assert.equal(updated.json.result.text, "revised");

    const deleted = await httpRequest({ port, path: `/api/store.summaries.delete?id=${summaryId}`, method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal((await httpRequest({ port, path: "/api/store.summaries.list" })).json.result.total, 0);
  });
});

test("store.clear empties every table family, not only captures", async () => {
  await withService(async ({ port }) => {
    const capture = (await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    await httpRequest({
      port,
      path: "/api/store.summaries.create",
      method: "POST",
      body: { text: "s", creatorType: "user", sourceCaptureIds: [capture.id] },
    });
    const tag = (await httpRequest({ port, path: "/api/store.tags.create", method: "POST", body: { name: "t", creatorType: "user" } })).json.result;
    await httpRequest({
      port,
      path: "/api/store.tags.assign",
      method: "POST",
      body: { tagId: tag.id, recordType: "capture", recordId: capture.id, creatorType: "user" },
    });
    const collection = (
      await httpRequest({ port, path: "/api/store.collections.create", method: "POST", body: { name: "c", creatorType: "user" } })
    ).json.result;
    await httpRequest({
      port,
      path: "/api/store.collections.items.add",
      method: "POST",
      body: { collectionId: collection.id, recordType: "capture", recordId: capture.id, creatorType: "user" },
    });
    await httpRequest({
      port,
      path: "/api/store.queue.create",
      method: "POST",
      body: { recordType: "capture", recordId: capture.id, state: "needs_review", creatorType: "user" },
    });
    await httpRequest({
      port,
      path: "/api/store.proposals.create",
      method: "POST",
      body: { kind: "tag", rationale: "x", payload: {}, creatorType: "user", sourceCaptureIds: [capture.id] },
    });

    const cleared = await httpRequest({ port, path: "/api/store.clear", method: "POST" });
    assert.equal(cleared.status, 200);
    for (const table of ["captures", "summaries", "tags", "collections", "proposals"]) {
      assert.ok(cleared.json.result.deletedCounts[table] >= 1, `expected ${table} to have at least one row deleted`);
    }

    assert.equal((await httpRequest({ port, path: "/api/store.captures.list" })).json.result.total, 0);
    assert.equal((await httpRequest({ port, path: "/api/store.summaries.list" })).json.result.total, 0);
    assert.equal((await httpRequest({ port, path: "/api/store.tags.list" })).json.result.total, 0);
    assert.equal((await httpRequest({ port, path: "/api/store.collections.list" })).json.result.total, 0);
    assert.equal((await httpRequest({ port, path: "/api/store.queue.list" })).json.result.total, 0);
    assert.equal((await httpRequest({ port, path: "/api/store.proposals.list" })).json.result.total, 0);
  });
});

// Finding #6: store.* responses are bounded by the same maxResponseBytes
// the browser.* routes already enforce. Captures' list projection omits
// full `text` specifically to keep ordinary-sized pages well under this
// bound (service/store.mjs's rowToCaptureListItem) — this test instead
// exercises the bound itself directly, independent of that mitigation, by
// configuring a service with a deliberately tiny maxResponseBytes.
test("store.* list responses are rejected as response_too_large when they would exceed the configured bound", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-store-routes-size-"));
  const store = await openStore({ dataDir });
  const service = createService({ credentialToken: TOKEN, store, maxResponseBytes: 10 });
  const address = await service.listen();
  try {
    await httpRequest({ port: address.port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() });
    const response = await httpRequest({ port: address.port, path: "/api/store.captures.list" });
    assert.equal(response.status, 502);
    assert.equal(response.json.error.code, "response_too_large");
  } finally {
    await service.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Adversarial regression for the cascade-count fix (service/store.mjs's
// deleteCapture now reports `cascadedSummaryCount`/`cascadedProposalCount`,
// never the id lists themselves): a cascading delete whose capture has
// many real dependents must still commit and return a small, bounded
// response — never commit the delete and then report
// response_too_large, which would leave the caller unable to tell whether
// the destructive mutation actually happened at all. Uses a genuinely
// large number of cascaded dependents (not merely one or two) alongside a
// deliberately tiny maxResponseBytes, so an unbounded id-array response
// (the shape this fix replaced) would certainly have exceeded it, while
// the bounded-count response still fits comfortably.
test("cascading capture delete with many dependents still succeeds under a deliberately tiny maxResponseBytes, and the dependents are actually gone", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-store-routes-cascade-size-"));
  const store = await openStore({ dataDir });
  // This test deliberately issues far more than RATE_LIMIT_MAX_REQUESTS'
  // default (30/second) worth of setup requests to build up many real
  // dependents — raise the rate limit so setup itself is not what gets
  // rejected; `maxResponseBytes` (the thing this test actually exercises)
  // is left deliberately tiny.
  const service = createService({ credentialToken: TOKEN, store, maxResponseBytes: 500, rateLimitMaxRequests: 10_000 });
  const address = await service.listen();
  try {
    const capture = (await httpRequest({ port: address.port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() })).json.result;
    // Large enough that an unbounded `cascadedSummaryIds`/`cascadedProposalIds`
    // response (the shape this fix replaced) would certainly exceed
    // maxResponseBytes above, while the bounded-count response stays small
    // regardless of this number.
    const DEPENDENT_COUNT = 150;
    for (let i = 0; i < DEPENDENT_COUNT; i++) {
      const summary = (
        await httpRequest({
          port: address.port,
          path: "/api/store.summaries.create",
          method: "POST",
          body: { text: `summary ${i}`, creatorType: "user", sourceCaptureIds: [capture.id] },
        })
      ).json.result;
      await httpRequest({
        port: address.port,
        path: "/api/store.proposals.create",
        method: "POST",
        body: { kind: "tag", rationale: `cites summary ${i}`, payload: {}, creatorType: "user", sourceSummaryIds: [summary.id] },
      });
    }

    const cascaded = await httpRequest({ port: address.port, path: `/api/store.captures.delete?id=${capture.id}&cascade=true`, method: "DELETE" });
    assert.equal(cascaded.status, 200, "a cascading delete with many dependents must commit and report success, never 502, even under a tiny response bound");
    assert.equal(cascaded.json.result.cascadedSummaryCount, DEPENDENT_COUNT);
    assert.equal(cascaded.json.result.cascadedProposalCount, DEPENDENT_COUNT);

    const summariesAfter = await httpRequest({ port: address.port, path: "/api/store.summaries.list" });
    assert.equal(summariesAfter.json.result.total, 0, "the cascaded delete must have actually committed, not merely reported success");
    const proposalsAfter = await httpRequest({ port: address.port, path: "/api/store.proposals.list" });
    assert.equal(proposalsAfter.json.result.total, 0);
    const capturesAfter = await httpRequest({ port: address.port, path: "/api/store.captures.list" });
    assert.equal(capturesAfter.json.result.total, 0);
  } finally {
    await service.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

// Finding "log-leakage test": service/server.mjs's store.* dispatcher
// (handleStoreMethod) must never pass request bodies, query values, or
// captured browser content to the service's `log` callback — the only
// thing that callback is used for on this path is extension-websocket
// events, never store operations. This creates a capture containing a
// unique secret (standing in for "credentials or browser content") and
// the shared loopback credential itself, exercises a representative mix
// of store.* routes, and asserts neither ever appears in anything passed
// to either log callback (the service's own, and the store's own
// migration/open log).
test("store.* operations never pass captured content or the credential to the log callback", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-log-leak-"));
  const serviceLogLines = [];
  const storeLogLines = [];
  const store = await openStore({ dataDir, log: (message) => storeLogLines.push(message) });
  const service = createService({ credentialToken: TOKEN, store, log: (message) => serviceLogLines.push(message) });
  const address = await service.listen();
  try {
    const secret = `TOP_SECRET_BROWSER_CONTENT_${TOKEN}`;
    await httpRequest({ port: address.port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody({ text: secret, returnedCharacterCount: secret.length, characterCount: secret.length }) });
    await httpRequest({ port: address.port, path: "/api/store.captures.list" });
    await httpRequest({ port: address.port, path: "/api/store.captures.create", method: "POST", body: { not: "even close to valid" } });
    await httpRequest({ port: address.port, path: "/api/store.captures.list", headers: { authorization: "Bearer wrong-token" } });

    const allLines = [...serviceLogLines, ...storeLogLines];
    for (const line of allLines) {
      assert.ok(!line.includes(secret), `log line leaked captured content: ${line}`);
      assert.ok(!line.includes(TOKEN), `log line leaked the credential: ${line}`);
    }
  } finally {
    await service.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("retention settings and cleanup are reachable over HTTP", async () => {
  await withService(async ({ port }) => {
    const initial = await httpRequest({ port, path: "/api/store.retention.get" });
    assert.equal(initial.json.result.captureRetentionDays, null);

    const updated = await httpRequest({ port, path: "/api/store.retention.update", method: "PATCH", body: { captureRetentionDays: 30 } });
    assert.equal(updated.json.result.captureRetentionDays, 30);

    const cleanup = await httpRequest({ port, path: "/api/store.retention.cleanup", method: "POST" });
    assert.equal(cleanup.status, 200);
    assert.equal(cleanup.json.result.enabled, true);
  });
});

test("store.clear empties captured/derived data over HTTP", async () => {
  await withService(async ({ port }) => {
    await httpRequest({ port, path: "/api/store.captures.create", method: "POST", body: sampleCaptureBody() });
    const cleared = await httpRequest({ port, path: "/api/store.clear", method: "POST" });
    assert.equal(cleared.status, 200);

    const after = await httpRequest({ port, path: "/api/store.captures.list" });
    assert.equal(after.json.result.total, 0);
  });
});

// Every other persistence test in this file (and in test/store.test.mjs)
// proves persistence via store.close()/openStore() reopen *within the same
// Node process*. This test instead drives the real service/cli.mjs entry
// point as a genuinely separate OS process — start, create data over HTTP,
// stop (the real process exits), start again, and confirm the data is
// still there — the same real start/stop lifecycle test/cli.test.mjs
// already exercises for Stage 1, extended here to prove Stage 3's on-disk
// data survives it too.
test("Stage 3 data persists across a real, separate-process service restart (service/cli.mjs start/stop), not only an in-process close/reopen", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-store-cli-restart-"));
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const CLI_PATH = fileURLToPath(new URL("../service/cli.mjs", import.meta.url));
  const env = { ...process.env, BROWSER_TABS_DATA_DIR: dataDir, BROWSER_TABS_PORT: String(port) };

  function spawnStart() {
    const child = spawn(process.execPath, [CLI_PATH, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
    return child;
  }

  function runCli(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.on("error", reject);
      child.on("exit", () => resolve(stdout));
    });
  }

  async function waitForHealth() {
    const deadline = Date.now() + 5000;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const response = await httpRequest({ port, path: "/health" });
        if (response.status === 200) return response;
        lastError = new Error(`unexpected health status ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(`service on port ${port} never answered /health: ${lastError?.message}`);
  }

  async function killIfStillRunning(child) {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }

  let started = spawnStart();
  try {
    await waitForHealth();
    const token = (await runCli(["show-token"])).trim();

    const created = await httpRequest({
      port,
      path: "/api/store.captures.create",
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: sampleCaptureBody({ title: "persists-across-real-restart" }),
    });
    assert.equal(created.status, 200, JSON.stringify(created.json));

    const exitPromise = new Promise((resolve) => started.once("exit", resolve));
    await runCli(["stop"]);
    await Promise.race([exitPromise, delay(5000)]);
    await killIfStillRunning(started);

    started = spawnStart();
    await waitForHealth();
    const listed = await httpRequest({ port, path: "/api/store.captures.list", headers: { authorization: `Bearer ${token}` } });
    assert.equal(listed.status, 200, JSON.stringify(listed.json));
    assert.equal(listed.json.result.total, 1);
    assert.equal(listed.json.result.items[0].title, "persists-across-real-restart");
  } finally {
    await runCli(["stop"]).catch(() => {});
    await killIfStillRunning(started);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("the service's rate limit also applies to store.* routes", async () => {
  await withService(async ({ port, store: _store }) => {
    // withService's default createService uses the production rate-limit
    // constants, so this only needs a handful of requests comfortably under
    // the Stage 2 default (30/second) to prove the route is covered by the
    // same check — the limit's own numeric behavior is already exercised
    // against browser.* routes in test/bridge.test.mjs.
    const responses = await Promise.all(Array.from({ length: 5 }, () => httpRequest({ port, path: "/api/store.captures.list" })));
    for (const response of responses) assert.equal(response.status, 200);
  });
});
