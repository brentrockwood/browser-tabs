// Stage 3: unit/integration tests for the derived store (service/store.mjs)
// directly against a real SQLite file in a temporary directory — no HTTP
// layer involved (see test/store-routes.test.mjs for that). Requires
// Node's built-in `node:sqlite`; see README.md's Stage 3 section if these
// tests fail to even start.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { STORE_ERROR_CODES } from "../service/store-errors.mjs";
import { DATABASE_FILE_NAME, MIGRATIONS, backupDatabase, openStore, runMigrations } from "../service/store.mjs";

async function withTempDataDir(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-store-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

// Matches exactly the envelope+result shape extension/protocol.js's
// `validateMethodResult("browser.read_tab", ...)` requires for an "ok"
// result — captures persist this shape verbatim (service/validation.mjs's
// validateCaptureInput reuses that same validator), never a caller-invented
// one.
function sampleCaptureInput(overrides = {}) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: "session-1",
    sourceOperation: "browser.read_tab",
    capturedAt: Date.now(),
    status: "ok",
    tabId: 10,
    windowId: 1,
    url: "https://example.com/",
    title: "Example",
    documentReadyState: "complete",
    text: "hello world",
    characterCount: 11,
    returnedCharacterCount: 11,
    truncated: false,
    ...overrides,
  };
}

function sampleErrorCaptureInput(overrides = {}) {
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    browserSessionId: "session-1",
    sourceOperation: "browser.read_tab",
    capturedAt: Date.now(),
    status: "unsupported",
    code: "injection_rejected",
    ...overrides,
  };
}

async function assertRejects(promiseOrFn, code) {
  await assert.rejects(
    async () => {
      const result = promiseOrFn();
      if (result && typeof result.then === "function") await result;
    },
    (error) => {
      assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
      return true;
    },
  );
}

test("creates a new database file on first start, with schema migrations recorded", async () => {
  await withTempDataDir(async (dataDir) => {
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    assert.equal(existsSync(dbPath), false);
    const store = await openStore({ dataDir });
    assert.equal(existsSync(dbPath), true);
    // A fresh capture round-trips, proving the schema is actually usable,
    // not merely that the file exists. createCapture's own response is
    // bounded (textLength, not the raw text — see store.mjs); readCapture
    // (store.captures.read) is what actually proves the text was persisted.
    const capture = store.createCapture(sampleCaptureInput());
    assert.equal(capture.textLength, "hello world".length);
    assert.equal(store.readCapture({ id: capture.id }).chunk, "hello world");
    store.close();
  });
});

test("persists captures and derived records across a service restart (store close + reopen)", async () => {
  await withTempDataDir(async (dataDir) => {
    let store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const summary = store.createSummary({
      text: "A short summary.",
      creatorType: "agent",
      creatorName: "test-agent",
      sourceCaptureIds: [capture.id],
    });
    store.close();

    store = await openStore({ dataDir });
    const { items: captures } = store.listCaptures({});
    const { items: summaries } = store.listSummaries({});
    assert.equal(captures.length, 1);
    assert.equal(captures[0].id, capture.id);
    // listCaptures is the bounded list projection: it omits full `text`
    // (see rowToCaptureListItem) in favor of `textLength`, so persistence
    // of the actual text is checked via the capture-creation response
    // above and the raw-bytes assertions further down this file, not here.
    assert.equal(captures[0].textLength, "hello world".length);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].id, summary.id);
    assert.deepEqual(summaries[0].sourceCaptureIds, [capture.id]);
    store.close();
  });
});

test("rejects a capture whose sourceOperation is not exactly browser.read_tab", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    await assertRejects(
      () => store.createCapture(sampleCaptureInput({ sourceOperation: "browser.list_tabs" })),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );
    await assertRejects(
      () => store.createCapture(sampleCaptureInput({ sourceOperation: "made-up-evidence" })),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );
    store.close();
  });
});

test("rejects a capture that does not validate as a real browser.read_tab result shape", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    // Wrong schemaVersion.
    await assertRejects(() => store.createCapture(sampleCaptureInput({ schemaVersion: 99 })), STORE_ERROR_CODES.VALIDATION_ERROR);
    // "ok" status missing required fields (documentReadyState).
    await assertRejects(
      () => store.createCapture(sampleCaptureInput({ documentReadyState: undefined })),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );
    // "ok" status with text/returnedCharacterCount inconsistent.
    await assertRejects(
      () => store.createCapture(sampleCaptureInput({ returnedCharacterCount: 999 })),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );
    // Non-"ok" status with no code at all.
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ code: undefined })), STORE_ERROR_CODES.VALIDATION_ERROR);
    store.close();
  });
});

test("accepts a valid non-ok (error/unsupported/not_ready) capture and persists its code/detail", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleErrorCaptureInput({ detail: "injection was rejected by the browser" }));
    assert.equal(capture.status, "unsupported");
    assert.equal(capture.code, "injection_rejected");
    assert.equal(capture.detail, "injection was rejected by the browser");
    assert.equal(capture.textLength, null);
    assert.equal(capture.documentReadyState, null);
    store.close();
  });
});

// A real browser.read_tab non-"ok" result never carries url/title/
// documentReadyState/characterCount/returnedCharacterCount/truncated/text
// (see extension/service-worker.js's readTab) — only a caller fabricating
// a capture could supply them. Each must be rejected outright, not
// silently persisted as if it were real captured content.
test("rejects a non-ok capture carrying invented ok-only fields, one at a time", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ url: "https://invented.example/" })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ title: "Invented title" })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(
      () => store.createCapture(sampleErrorCaptureInput({ documentReadyState: "complete" })),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ characterCount: 5 })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ returnedCharacterCount: 5 })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ truncated: false })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ text: "invented page content" })), STORE_ERROR_CODES.VALIDATION_ERROR);

    assert.equal(store.listCaptures({}).items.length, 0, "none of the rejected captures must have been persisted");
    store.close();
  });
});

// A caller could try to slip an "ok"-only field past a value-based check by
// setting it to `null` instead of a truthy value — `null` is exactly what
// an absent field already normalizes to, so a check against the normalized
// value alone cannot tell "the caller explicitly sent null" apart from
// "the caller never sent this field at all". validateCaptureInput checks
// `Object.hasOwn` against the *original* input instead, so presence alone
// — regardless of value — is rejected.
test("rejects a non-ok capture carrying invented ok-only fields set to explicit null, one at a time", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ url: null })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ title: null })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(
      () => store.createCapture(sampleErrorCaptureInput({ documentReadyState: null })),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ characterCount: null })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ returnedCharacterCount: null })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ truncated: null })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createCapture(sampleErrorCaptureInput({ text: null })), STORE_ERROR_CODES.VALIDATION_ERROR);

    assert.equal(store.listCaptures({}).items.length, 0, "none of the rejected captures must have been persisted");
    store.close();
  });
});

// store.captures.read (readCapture): a bounded, offset-addressable slice of
// a capture's full text, so a caller can inspect retained content after a
// restart without the create response being available any more, and
// without ever requesting more than one bounded chunk at a time.
test("store.captures.read returns a bounded, offset-addressable slice of a capture's text", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const fullText = "0123456789".repeat(10); // 100 characters
    const capture = store.createCapture(sampleCaptureInput({ text: fullText, characterCount: fullText.length, returnedCharacterCount: fullText.length }));

    const firstChunk = store.readCapture({ id: capture.id, offset: 0, maxChars: 10 });
    assert.equal(firstChunk.chunk, "0123456789");
    assert.equal(firstChunk.chunkLength, 10);
    assert.equal(firstChunk.textLength, 100);
    assert.equal(firstChunk.offset, 0);

    const secondChunk = store.readCapture({ id: capture.id, offset: 10, maxChars: 10 });
    assert.equal(secondChunk.chunk, "0123456789");

    const defaultChunk = store.readCapture({ id: capture.id });
    assert.equal(defaultChunk.offset, 0);
    assert.equal(defaultChunk.chunk, fullText);

    const pastEnd = store.readCapture({ id: capture.id, offset: 1000, maxChars: 10 });
    assert.equal(pastEnd.chunk, "");
    assert.equal(pastEnd.chunkLength, 0);

    await assertRejects(() => store.readCapture({ id: capture.id, offset: -1 }), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.readCapture({ id: capture.id, maxChars: 0 }), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.readCapture({ id: capture.id, maxChars: 100_001 }), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.readCapture({ id: 999999 }), STORE_ERROR_CODES.NOT_FOUND);
    store.close();
  });
});

// Finding: a mutation must never commit and only then report
// response_too_large — by the time such a check could run, the write has
// already happened. createCapture's own result is bounded by construction
// (the same compact projection listCaptures uses), so even the
// pathological maximum-length, maximum-escape-expansion capture body both
// commits *and* returns a small, successful response.
test("creating a capture at the maximum text length and worst-case JSON-escape expansion still commits and returns a small, bounded result", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    // Every character a 6-byte \\uXXXX JSON escape (the worst case noted in
    // extension/protocol.js's MAX_WS_MESSAGE_BYTES comment) — the
    // pathological input this must still handle without ever reporting
    // response_too_large after already committing.
    const pathologicalText = "\u0001".repeat(500_000);
    const result = store.createCapture(
      sampleCaptureInput({ text: pathologicalText, characterCount: pathologicalText.length, returnedCharacterCount: pathologicalText.length }),
    );

    // Bounded by construction: no raw `text` field at all, just its length.
    assert.equal(result.text, undefined);
    assert.equal(result.textLength, 500_000);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10_000, "createCapture's own result must stay small regardless of the submitted text size");

    // And it actually committed: the full text is retrievable afterward.
    const read = store.readCapture({ id: result.id, maxChars: 100_000 });
    assert.equal(read.textLength, 500_000);
    assert.equal(read.chunk, pathologicalText.slice(0, 100_000));
    store.close();
  });
});

test("rejects a summary referencing a nonexistent source capture (foreign key enforcement)", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    await assertRejects(
      () =>
        store.createSummary({
          text: "orphaned",
          creatorType: "user",
          sourceCaptureIds: [999999],
        }),
      STORE_ERROR_CODES.SOURCE_NOT_FOUND,
    );
    const { items } = store.listSummaries({});
    assert.equal(items.length, 0, "the rejected summary must not have been partially inserted");
    store.close();
  });
});

test("rejects a proposal referencing a nonexistent source summary", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    await assertRejects(
      () =>
        store.createProposal({
          kind: "tag",
          rationale: "because",
          payload: { tagName: "interesting" },
          creatorType: "agent",
          creatorName: "test-agent",
          sourceSummaryIds: [42],
        }),
      STORE_ERROR_CODES.SOURCE_NOT_FOUND,
    );
    store.close();
  });
});

test("rejects a tag assignment referencing a nonexistent capture", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const tag = store.createTag({ name: "important", creatorType: "user" });
    await assertRejects(
      () => store.assignTag({ tagId: tag.id, recordType: "capture", recordId: 12345, creatorType: "user" }),
      STORE_ERROR_CODES.SOURCE_NOT_FOUND,
    );
    store.close();
  });
});

test("a failed multi-statement write rolls back entirely, leaving no partial row", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    // sourceCaptureIds mixes one real capture with one that does not exist:
    // the summary insert itself succeeds, then the second summary_sources
    // insert fails on the foreign key — the whole transaction, including
    // the already-"succeeded" summary insert, must be rolled back.
    await assertRejects(
      () =>
        store.createSummary({
          text: "partially sourced",
          creatorType: "user",
          sourceCaptureIds: [capture.id, 999999],
        }),
      STORE_ERROR_CODES.SOURCE_NOT_FOUND,
    );
    const { items: summaries } = store.listSummaries({});
    assert.equal(summaries.length, 0, "no summary row should remain after the rolled-back transaction");
    store.close();
  });
});

test("deleting a capture that is cited by a summary is refused by default, with documented cascade behavior", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const summary = store.createSummary({ text: "cites capture", creatorType: "user", sourceCaptureIds: [capture.id] });

    await assertRejects(() => store.deleteCapture(capture.id), STORE_ERROR_CODES.HAS_DEPENDENTS);
    assert.equal(store.listCaptures({}).items.length, 1, "capture must still exist after the refused delete");

    const result = store.deleteCapture(capture.id, { cascade: true });
    assert.equal(result.cascadedSummaryCount, 1);
    assert.equal(result.cascadedProposalCount, 0);
    assert.equal(result.cascadedSummaryIds, undefined, "cascade result must report bounded counts, never the id list itself");
    assert.equal(store.listCaptures({}).items.length, 0);
    assert.equal(store.listSummaries({}).items.length, 0, "cascaded delete must also remove the dependent summary");
    store.close();
  });
});

test("deleting a summary that is cited by a proposal is refused by default, and cascades when asked", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const summary = store.createSummary({ text: "evidence", creatorType: "user", sourceCaptureIds: [capture.id] });
    const proposal = store.createProposal({
      kind: "tag",
      rationale: "seems relevant",
      payload: { tagName: "x" },
      creatorType: "agent",
      creatorName: "a",
      sourceSummaryIds: [summary.id],
    });

    await assertRejects(() => store.deleteSummary(summary.id), STORE_ERROR_CODES.HAS_DEPENDENTS);
    const cascaded = store.deleteSummary(summary.id, { cascade: true });
    assert.equal(cascaded.cascadedProposalCount, 1);
    assert.equal(cascaded.cascadedProposalIds, undefined, "cascade result must report a bounded count, never the id list itself");
    assert.equal(store.listProposals({}).items.length, 0);
    store.close();
  });
});

// Previously, cascade deletion of a capture deleted its citing summaries
// *before* its citing proposals, which fails as soon as any of those
// proposals cites one of those summaries (rather than the capture
// directly): the summary delete would hit the still-referencing
// proposal_sources row under ON DELETE RESTRICT. computeCaptureDependents
// now finds that transitive proposal too, and deleteCapture deletes
// proposals before summaries.
test("deleting a capture cascades correctly through a transitive capture -> summary -> proposal chain", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const summary = store.createSummary({ text: "cites capture", creatorType: "user", sourceCaptureIds: [capture.id] });
    // This proposal cites the *summary*, not the capture directly.
    const proposal = store.createProposal({
      kind: "tag",
      rationale: "cites the summary, not the capture",
      payload: {},
      creatorType: "agent",
      creatorName: "a",
      sourceSummaryIds: [summary.id],
    });

    await assert.rejects(async () => store.deleteCapture(capture.id), (error) => {
      assert.equal(error.code, STORE_ERROR_CODES.HAS_DEPENDENTS);
      return true;
    });

    const result = store.deleteCapture(capture.id, { cascade: true });
    assert.equal(result.cascadedSummaryCount, 1);
    assert.equal(result.cascadedProposalCount, 1);
    assert.equal(store.listProposals({}).items.length, 0);
    assert.equal(store.listSummaries({}).items.length, 0);
    assert.equal(store.listCaptures({}).items.length, 0);
    store.close();
  });
});

// computeCaptureDependents (service/store.mjs) chunks both the capture-id
// and the intermediate summary-id dimension so neither ever builds an
// unbounded SQL `IN (...)` placeholder list. A tiny `captureDependentChunkSize`
// (test-only override on openStore — never used by any real caller, which
// always gets the real 500) deliberately forces several real chunk
// boundaries with only a handful of rows, proving the accumulated-across-
// chunks result is correct rather than merely "correct within one chunk" —
// without needing thousands of real inserts to exercise the production
// chunk size.
test("retention cleanup's dependency computation is correct across a chunk boundary, not only within one chunk", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir, captureDependentChunkSize: 2 });
    const oldCapturedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;

    // 5 ids against a chunk size of 2 forces three chunks ([0,1], [2,3],
    // [4]) on both the capture-id pass and the resulting summary-id pass.
    for (let i = 0; i < 5; i++) {
      const capture = store.createCapture(sampleCaptureInput({ capturedAt: oldCapturedAt }));
      const summary = store.createSummary({ text: `summary ${i}`, creatorType: "user", sourceCaptureIds: [capture.id] });
      store.createProposal({
        kind: "tag",
        rationale: `cites summary ${i}`,
        payload: {},
        creatorType: "user",
        sourceSummaryIds: [summary.id],
      });
    }

    store.updateRetentionSettings({ captureRetentionDays: 1 });
    const result = store.runRetentionCleanup();
    assert.equal(result.deletedCaptures, 5);
    assert.equal(result.deletedSummaries, 5, "every summary across every chunk boundary must be found, not only those in the first chunk");
    assert.equal(result.deletedProposals, 5, "every transitively-cited proposal across every chunk boundary must be found");
    assert.equal(store.listCaptures({}).items.length, 0);
    assert.equal(store.listSummaries({}).items.length, 0);
    assert.equal(store.listProposals({}).items.length, 0);
    store.close();
  });
});

test("deleting a tag or removing a collection item never needs cascade (link rows, not evidence)", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const tag = store.createTag({ name: "label", creatorType: "user" });
    store.assignTag({ tagId: tag.id, recordType: "capture", recordId: capture.id, creatorType: "user" });

    store.deleteTag(tag.id);
    assert.equal(store.listTagAssignments({}).items.length, 0, "deleting a tag must remove its assignments");
    assert.equal(store.listCaptures({}).items.length, 1, "deleting a tag must never delete the tagged capture");
    store.close();
  });
});

test("a tag cannot be assigned twice to the same capture (duplicate assignment is rejected)", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const tag = store.createTag({ name: "label", creatorType: "user" });
    store.assignTag({ tagId: tag.id, recordType: "capture", recordId: capture.id, creatorType: "user" });
    await assertRejects(
      () => store.assignTag({ tagId: tag.id, recordType: "capture", recordId: capture.id, creatorType: "user" }),
      STORE_ERROR_CODES.CONFLICT,
    );
    store.close();
  });
});

// The old single UNIQUE(tag_id, capture_id, summary_id) index never
// actually enforced "assigned at most once", because SQL treats every
// NULL as distinct from every other NULL — two rows both assigning the
// same tag to the same capture (summary_id = NULL in both) would not
// collide. Checked directly against the schema (via a second, read-only
// connection to the same file), independent of whatever the application
// layer happens to prevent today — the duplicate-assignment test above
// already proves the practical behavior; this proves *why* it now holds.
test("the migrated schema uses partial unique indexes (not NULL-distinct-prone whole-row ones) for tag/proposal source uniqueness", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const dbPath = store.dbPath;
    store.close();

    const { DatabaseSync } = await import("node:sqlite");
    const raw = new DatabaseSync(dbPath, { readOnly: true });
    const indexNames = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('tag_assignments', 'proposal_sources')")
      .all()
      .map((r) => r.name);
    raw.close();

    assert.ok(indexNames.includes("idx_tag_assignments_unique_capture"));
    assert.ok(indexNames.includes("idx_tag_assignments_unique_summary"));
    assert.ok(indexNames.includes("idx_proposal_sources_unique_capture"));
    assert.ok(indexNames.includes("idx_proposal_sources_unique_summary"));
    assert.ok(!indexNames.includes("idx_tag_assignments_unique"), "the old NULL-distinct-prone whole-row index must not exist");
    assert.ok(!indexNames.includes("idx_proposal_sources_unique"), "the old NULL-distinct-prone whole-row index must not exist");
  });
});

// A partial filter (recordType without recordId, or vice versa) would
// otherwise be silently widened into "every record of that type" or "that
// id regardless of type" — neither of which is what a caller supplying
// only one of the two actually means.
test("listing tag assignments requires recordType and recordId together, rejecting a partial filter", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const captureA = store.createCapture(sampleCaptureInput({ url: "https://a.example/" }));
    const captureB = store.createCapture(sampleCaptureInput({ url: "https://b.example/" }));
    const tag = store.createTag({ name: "label", creatorType: "user" });
    store.assignTag({ tagId: tag.id, recordType: "capture", recordId: captureA.id, creatorType: "user" });
    store.assignTag({ tagId: tag.id, recordType: "capture", recordId: captureB.id, creatorType: "user" });

    await assertRejects(() => store.listTagAssignments({ recordType: "capture" }), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.listTagAssignments({ recordId: captureA.id }), STORE_ERROR_CODES.VALIDATION_ERROR);

    assert.equal(store.listTagAssignments({ recordType: "capture", recordId: captureA.id }).items.length, 1);
    assert.equal(store.listTagAssignments({}).items.length, 2, "omitting both filters still lists everything");
    store.close();
  });
});

test("collection ordered membership: add, list in order, and reorder", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const captureA = store.createCapture(sampleCaptureInput({ url: "https://a.example/" }));
    const captureB = store.createCapture(sampleCaptureInput({ url: "https://b.example/" }));
    const captureC = store.createCapture(sampleCaptureInput({ url: "https://c.example/" }));
    const collection = store.createCollection({ name: "Reading list", creatorType: "user" });

    const itemA = store.addCollectionItem({ collectionId: collection.id, recordType: "capture", recordId: captureA.id, creatorType: "user" });
    const itemB = store.addCollectionItem({ collectionId: collection.id, recordType: "capture", recordId: captureB.id, creatorType: "user" });
    const itemC = store.addCollectionItem({ collectionId: collection.id, recordType: "capture", recordId: captureC.id, creatorType: "user" });
    assert.deepEqual([itemA.position, itemB.position, itemC.position], [0, 1, 2]);

    let ordered = store.listCollectionItems({ collectionId: collection.id });
    assert.deepEqual(ordered.items.map((i) => i.recordId), [captureA.id, captureB.id, captureC.id]);

    store.reorderCollectionItems({ collectionId: collection.id, orderedItemIds: [itemC.id, itemA.id, itemB.id] });
    ordered = store.listCollectionItems({ collectionId: collection.id });
    assert.deepEqual(ordered.items.map((i) => i.recordId), [captureC.id, captureA.id, captureB.id]);
    assert.deepEqual(ordered.items.map((i) => i.position), [0, 1, 2]);
    store.close();
  });
});

// Regression for the former "+1,000,000" temporary-offset bump: an item
// whose *current* position already sits at or near that offset (allowed,
// since addCollectionItem's explicit `position` has no enforced upper
// bound) could transiently collide with another item's bumped value
// mid-statement. The guaranteed-disjoint (negative vs. non-negative)
// strategy has no such ceiling.
test("reordering succeeds even when an existing item's position is already at the old temporary-offset boundary (0 and 1,000,000)", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const captureA = store.createCapture(sampleCaptureInput({ url: "https://a.example/" }));
    const captureB = store.createCapture(sampleCaptureInput({ url: "https://b.example/" }));
    const collection = store.createCollection({ name: "List", creatorType: "user" });

    const itemA = store.addCollectionItem({
      collectionId: collection.id,
      recordType: "capture",
      recordId: captureA.id,
      position: 0,
      creatorType: "user",
    });
    const itemB = store.addCollectionItem({
      collectionId: collection.id,
      recordType: "capture",
      recordId: captureB.id,
      position: 1_000_000,
      creatorType: "user",
    });

    const result = store.reorderCollectionItems({ collectionId: collection.id, orderedItemIds: [itemB.id, itemA.id] });
    assert.deepEqual(result.items.map((i) => i.recordId), [captureB.id, captureA.id]);
    assert.deepEqual(result.items.map((i) => i.position), [0, 1]);
    store.close();
  });
});

test("reordering a collection rejects a set that does not match its current items exactly", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const collection = store.createCollection({ name: "List", creatorType: "user" });
    const item = store.addCollectionItem({ collectionId: collection.id, recordType: "capture", recordId: capture.id, creatorType: "user" });

    await assertRejects(
      () => store.reorderCollectionItems({ collectionId: collection.id, orderedItemIds: [item.id, 999999] }),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );
    store.close();
  });
});

test("queue items support an explicit, user-defined workflow state across capture/summary/proposal record types", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const queueItem = store.createQueueItem({ recordType: "capture", recordId: capture.id, state: "needs_review", creatorType: "user" });
    assert.equal(queueItem.state, "needs_review");

    const updated = store.updateQueueItem(queueItem.id, { state: "archived" });
    assert.equal(updated.state, "archived");

    store.deleteQueueItem(queueItem.id);
    assert.equal(store.listQueueItems({}).items.length, 0);
    store.close();
  });
});

test("listing queue items by state is bounded and type-checked, like state at creation time", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    store.createQueueItem({ recordType: "capture", recordId: capture.id, state: "needs_review", creatorType: "user" });

    assert.equal(store.listQueueItems({ state: "needs_review" }).items.length, 1);
    await assertRejects(() => store.listQueueItems({ state: "x".repeat(101) }), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.listQueueItems({ state: 12345 }), STORE_ERROR_CODES.VALIDATION_ERROR);
    store.close();
  });
});

test("proposals: created pending, and can only transition once from pending", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const proposal = store.createProposal({
      kind: "collection",
      rationale: "these look related",
      payload: { collectionName: "Trip planning" },
      creatorType: "agent",
      creatorName: "planner",
      sourceCaptureIds: [capture.id],
    });
    assert.equal(proposal.state, "pending");
    assert.equal(proposal.decidedAt, null);

    const accepted = store.updateProposalState(proposal.id, { state: "accepted", creatorType: "user" });
    assert.equal(accepted.state, "accepted");
    assert.ok(typeof accepted.decidedAt === "number");
    assert.equal(accepted.decidedByCreatorType, "user");
    assert.equal(accepted.decidedByCreatorName, null);

    await assertRejects(
      () => store.updateProposalState(proposal.id, { state: "rejected", creatorType: "user" }),
      STORE_ERROR_CODES.CONFLICT,
    );
    store.close();
  });
});

// Accepting/rejecting is itself a derived decision and must identify its
// decider the same way every other derived value does.
test("accepting or rejecting a proposal requires and persists the decider's identity", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    const proposal = store.createProposal({
      kind: "tag",
      rationale: "x",
      payload: {},
      creatorType: "user",
      sourceCaptureIds: [capture.id],
    });

    await assertRejects(() => store.updateProposalState(proposal.id, { state: "accepted" }), STORE_ERROR_CODES.VALIDATION_ERROR);

    const decided = store.updateProposalState(proposal.id, { state: "rejected", creatorType: "client", creatorName: "review-cli" });
    assert.equal(decided.decidedByCreatorType, "client");
    assert.equal(decided.decidedByCreatorName, "review-cli");
    store.close();
  });
});

test("creator identification: client/agent require a creator name, user must not supply one", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());

    await assertRejects(
      () => store.createSummary({ text: "x", creatorType: "agent", sourceCaptureIds: [capture.id] }),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );
    await assertRejects(
      () => store.createSummary({ text: "x", creatorType: "user", creatorName: "someone", sourceCaptureIds: [capture.id] }),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );

    const fromClient = store.createSummary({
      text: "x",
      creatorType: "client",
      creatorName: "review-cli",
      sourceCaptureIds: [capture.id],
    });
    assert.equal(fromClient.creatorType, "client");
    assert.equal(fromClient.creatorName, "review-cli");
    store.close();
  });
});

test("malformed and oversized input is rejected before touching the database", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });

    await assertRejects(() => store.createCapture(sampleCaptureInput({ status: "not-a-real-status" })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(
      () => store.createCapture(sampleCaptureInput({ text: "x".repeat(500_001), returnedCharacterCount: 500_001, characterCount: 500_001 })),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );
    await assertRejects(() => store.createCapture(sampleCaptureInput({ capturedAt: "not-a-number" })), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createTag({ name: "", creatorType: "user" }), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(() => store.createTag({ name: "x".repeat(300), creatorType: "user" }), STORE_ERROR_CODES.VALIDATION_ERROR);
    await assertRejects(
      () => store.createProposal({ kind: "tag", rationale: "x", payload: {}, creatorType: "user", sourceCaptureIds: [] }),
      STORE_ERROR_CODES.VALIDATION_ERROR,
    );

    assert.equal(store.listCaptures({}).items.length, 0);
    store.close();
  });
});

test("SQL injection safety: metacharacter-laden input is stored and returned literally", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const malicious = "'); DROP TABLE tags; --";
    const tag = store.createTag({ name: malicious, creatorType: "user" });
    assert.equal(tag.name, malicious);

    const capture = store.createCapture(
      sampleCaptureInput({ title: "Robert'); DROP TABLE captures;--", url: "https://example.com/?q=' OR '1'='1" }),
    );
    assert.equal(capture.title, "Robert'); DROP TABLE captures;--");

    // Both tables must still exist and be fully queryable.
    assert.equal(store.listTags({}).items.length, 1);
    assert.equal(store.listCaptures({}).items.length, 1);
    store.close();
  });
});

test("uniqueness is enforced on tag and collection names", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    store.createTag({ name: "dup", creatorType: "user" });
    await assertRejects(() => store.createTag({ name: "dup", creatorType: "user" }), STORE_ERROR_CODES.CONFLICT);
    store.close();
  });
});

test("retention settings default to disabled, and cleanup is a no-op until configured", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const settings = store.getRetentionSettings();
    assert.equal(settings.captureRetentionDays, null);

    store.createCapture(sampleCaptureInput({ capturedAt: Date.now() - 1000 * 60 * 60 * 24 * 365 }));
    const result = store.runRetentionCleanup();
    assert.deepEqual(result, { ...result, enabled: false, deletedCaptures: 0, deletedSummaries: 0, deletedProposals: 0 });
    assert.equal(store.listCaptures({}).items.length, 1);
    store.close();
  });
});

test("retention cleanup deletes expired captures and cascades their dependent summaries/proposals", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const oldCapture = store.createCapture(sampleCaptureInput({ capturedAt: Date.now() - 1000 * 60 * 60 * 24 * 10 }));
    const freshCapture = store.createCapture(sampleCaptureInput({ capturedAt: Date.now() }));
    const oldSummary = store.createSummary({ text: "old", creatorType: "user", sourceCaptureIds: [oldCapture.id] });

    store.updateRetentionSettings({ captureRetentionDays: 1 });
    const result = store.runRetentionCleanup();
    assert.equal(result.enabled, true);
    assert.equal(result.deletedCaptures, 1);
    assert.equal(result.deletedSummaries, 1);

    const remainingCaptures = store.listCaptures({}).items.map((c) => c.id);
    assert.deepEqual(remainingCaptures, [freshCapture.id]);
    assert.equal(store.listSummaries({ id: oldSummary.id }).items.length, 0);
    store.close();
  });
});

// Overlapping citations: a single summary cites *two* expiring captures.
// A per-capture loop that deletes the summary once per citing capture
// would attempt to delete it twice (harmless on its own — a second DELETE
// by id affects zero rows — but would double-count it); computing the
// dependents once across the whole expired batch avoids that, and also
// proves a proposal citing that shared summary is still deleted before it.
test("retention cleanup dedupes a summary (and its citing proposal) shared by two expiring captures", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const old = (ms) => Date.now() - ms;
    const captureA = store.createCapture(sampleCaptureInput({ capturedAt: old(1000 * 60 * 60 * 24 * 10) }));
    const captureB = store.createCapture(sampleCaptureInput({ capturedAt: old(1000 * 60 * 60 * 24 * 10) }));
    const sharedSummary = store.createSummary({ text: "covers both", creatorType: "user", sourceCaptureIds: [captureA.id, captureB.id] });
    const proposal = store.createProposal({
      kind: "tag",
      rationale: "x",
      payload: {},
      creatorType: "user",
      sourceSummaryIds: [sharedSummary.id],
    });

    store.updateRetentionSettings({ captureRetentionDays: 1 });
    const result = store.runRetentionCleanup();
    assert.equal(result.deletedCaptures, 2);
    assert.equal(result.deletedSummaries, 1, "the shared summary must be counted once, not twice");
    assert.equal(result.deletedProposals, 1);
    assert.equal(store.listProposals({ id: proposal.id }).items.length, 0);
    store.close();
  });
});

test("store.clear empties every captured/derived table but preserves retention settings", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const capture = store.createCapture(sampleCaptureInput());
    store.createSummary({ text: "s", creatorType: "user", sourceCaptureIds: [capture.id] });
    store.createTag({ name: "t", creatorType: "user" });
    store.createCollection({ name: "c", creatorType: "user" });
    store.updateRetentionSettings({ captureRetentionDays: 30 });

    const result = store.clearAll();
    assert.ok(result.deletedCounts.captures >= 1);

    assert.equal(store.listCaptures({}).items.length, 0);
    assert.equal(store.listSummaries({}).items.length, 0);
    assert.equal(store.listTags({}).items.length, 0);
    assert.equal(store.listCollections({}).items.length, 0);
    assert.equal(store.getRetentionSettings().captureRetentionDays, 30, "clearAll must not reset retention settings");
    store.close();
  });
});

// The core of finding #1: deleting rows alone is not enough to make
// previously retained browser content actually unrecoverable from the
// live file — without secure_delete, SQLite leaves freed bytes sitting in
// now-unused pages. This reads the *raw file bytes* after clearAll, not
// merely queries the SQL layer, so a regression that dropped
// `PRAGMA secure_delete = ON` (or stopped clearing a table) would be
// caught here even if every SQL-level assertion above it still passed.
test("store.clear performs a secure delete: unique captured text is unrecoverable from the live database file, and backup files are removed", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const uniqueMarker = `UNIQUE_MARKER_${randomBytes(8).toString("hex")}`;
    store.createCapture(sampleCaptureInput({ text: `hello ${uniqueMarker} world`, returnedCharacterCount: `hello ${uniqueMarker} world`.length, characterCount: `hello ${uniqueMarker} world`.length }));

    // Prove store.clear also removes backup files, not only live rows: force
    // one to exist first.
    const backupPath = backupDatabase(store.dbPath);
    assert.ok(existsSync(backupPath));

    const result = store.clearAll();
    assert.equal(result.removedBackupCount, 1);
    assert.equal(result.deletedBackupFiles, undefined, "clearAll must report a bounded backup count, never the filename list itself");

    const liveBytes = readFileSync(store.dbPath);
    assert.ok(!liveBytes.includes(uniqueMarker), "secure_delete should scrub the unique text from the live database file");
    assert.ok(!existsSync(backupPath), "store.clear must remove application-managed .bak- files too");
    store.close();
  });
});

// Adversarial case secure_delete alone cannot cover: content deleted by a
// connection that ran with secure_delete OFF (e.g. a pre-remediation run
// of this store, before `PRAGMA secure_delete = ON` was introduced in
// openStore) leaves its bytes sitting unzeroed in a now-unused page —
// turning secure_delete ON on a later connection only changes how *that*
// connection's own future deletes behave, it cannot retroactively scrub a
// page freed before it existed. store.clear's VACUUM (see clearAll) must
// still purge it. This seeds and deletes the marker on a raw connection
// with secure_delete explicitly OFF, reopens through the real migrated
// store, and checks the *raw live file bytes* before and after store.clear.
test("store.clear's VACUUM purges content deleted earlier under secure_delete = OFF, not only this session's own deletes", async () => {
  await withTempDataDir(async (dataDir) => {
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const { DatabaseSync } = await import("node:sqlite");

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec("PRAGMA foreign_keys = ON");
    rawDb.exec("PRAGMA secure_delete = OFF");
    runMigrations(rawDb, dbPath, () => {});
    const marker = `PRE_SECUREDELETE_MARKER_${randomBytes(8).toString("hex")}`;
    const insertResult = rawDb
      .prepare(
        "INSERT INTO captures (browser_session_id, source_operation, schema_version, captured_at, status, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-session", "browser.read_tab", RESULT_SCHEMA_VERSION, Date.now(), "ok", marker, Date.now());
    rawDb.prepare("DELETE FROM captures WHERE id = ?").run(Number(insertResult.lastInsertRowid));
    rawDb.close();

    assert.ok(
      readFileSync(dbPath).includes(marker),
      "this fixture must reproduce the real bug: with secure_delete OFF, a deleted row's bytes remain in the live file",
    );

    // Reopening through the real store turns secure_delete ON for this
    // connection going forward, but that alone cannot retroactively scrub a
    // page that was already freed before this connection ever opened it.
    const store = await openStore({ dataDir });
    assert.ok(
      readFileSync(dbPath).includes(marker),
      "merely reopening with secure_delete = ON must not, by itself, have scrubbed a pre-existing freed page",
    );

    store.clearAll();
    assert.ok(
      !readFileSync(dbPath).includes(marker),
      "store.clear's VACUUM must purge content deleted under a prior secure_delete = OFF connection, not only rows deleted in this session",
    );
    store.close();
  });
});

// Proves the WAL-vs-DELETE journal_mode choice actually matters for backup
// completeness, not merely that the pragma is set: with DELETE mode (this
// store's configuration), there is no separate `-wal` sidecar file after a
// commit, and a plain file copy taken at that point already contains the
// just-committed row.
test("journal_mode is DELETE (not WAL), so a backup taken right after a commit is already complete", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const marker = `WAL_REGRESSION_${randomBytes(8).toString("hex")}`;
    store.createCapture(sampleCaptureInput({ title: marker }));

    const dir = await import("node:fs/promises").then((fs) => fs.readdir(dataDir));
    assert.ok(!dir.some((name) => name.endsWith("-wal") || name.endsWith("-shm")), `no WAL/SHM sidecar file should exist, found: ${dir.join(", ")}`);

    const backupPath = backupDatabase(store.dbPath);
    const backupBytes = readFileSync(backupPath);
    assert.ok(backupBytes.includes(marker), "the backup taken immediately after a commit must already contain that commit's data");
    store.close();
  });
});

// The actual bug the test above only proves this store's configuration
// avoids, not that the bug is real: reproduces it directly by opening a raw
// connection with `PRAGMA journal_mode = WAL` (the mode openStore
// deliberately does not use), committing one row, and showing that a plain
// file copy of only the main database file — exactly what backupDatabase
// does — misses that commit, because it is sitting in a separate `-wal`
// sidecar file instead. This is the origin of the "database ran in WAL
// mode, risking an incomplete file-copy backup" finding documented in
// project.md and README.md.
test("WAL journal mode really does risk an incomplete file-copy backup, unlike this store's DELETE mode", async () => {
  await withTempDataDir(async (dataDir) => {
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const { DatabaseSync } = await import("node:sqlite");

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec("PRAGMA foreign_keys = ON");
    rawDb.exec("PRAGMA journal_mode = WAL");
    runMigrations(rawDb, dbPath, () => {});
    const marker = `WAL_ORIGIN_MARKER_${randomBytes(8).toString("hex")}`;
    rawDb
      .prepare(
        "INSERT INTO captures (browser_session_id, source_operation, schema_version, captured_at, status, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-session", "browser.read_tab", RESULT_SCHEMA_VERSION, Date.now(), "ok", marker, Date.now());

    const dir = await import("node:fs/promises").then((fs) => fs.readdir(dataDir));
    assert.ok(dir.some((name) => name.endsWith("-wal")), `WAL mode should produce a -wal sidecar file, found: ${dir.join(", ")}`);

    const backupPath = backupDatabase(dbPath);
    const backupBytes = readFileSync(backupPath);
    assert.ok(
      !backupBytes.includes(marker),
      "a plain copy of only the main db file under WAL mode can miss a recent commit sitting in the -wal sidecar — exactly the risk this store's DELETE mode avoids",
    );
    rawDb.close();
  });
});

test("backupDatabase copies the database file aside without modifying the original", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    store.createCapture(sampleCaptureInput());
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const before = readFileSync(dbPath);
    const backupPath = backupDatabase(dbPath);
    assert.ok(existsSync(backupPath));
    assert.ok(backupPath.startsWith(dbPath));
    const backupContents = readFileSync(backupPath);
    assert.deepEqual(backupContents, before);
    store.close();
  });
});

// Exercises the real "back up before a breaking migration" path end to
// end, using the actual production MIGRATIONS list — not a fabricated
// standalone scenario. A raw connection applies only migration v1 (via the
// exported runMigrations' optional `migrations` parameter, used only by
// this test) to simulate a database that already has *today's*
// already-corrected v1 schema (coreTablesSql already has the fixed
// partial indexes) applied, but not yet v2; the real `openStore` is then
// used to bring it up to date, which must see a nonzero starting version
// and a breaking v2, and back up first. This proves the backup mechanism
// itself; see the *next* test for the actual pre-remediation legacy schema
// (not merely "today's v1, one migration behind") and what v2 does to it.
test("a breaking migration backs up an already-migrated database before applying, using the real migration list", async () => {
  await withTempDataDir(async (dataDir) => {
    await import("node:fs/promises").then((fs) => fs.mkdir(dataDir, { recursive: true }));
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const { DatabaseSync } = await import("node:sqlite");

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec("PRAGMA foreign_keys = ON");
    runMigrations(rawDb, dbPath, () => {}, [MIGRATIONS[0]]);
    rawDb.close();
    assert.equal(MIGRATIONS.length >= 2, true, "this test requires a second, breaking migration to exist");
    assert.equal(MIGRATIONS[1].breaking, true);

    const beforeBytes = readFileSync(dbPath);

    const store = await openStore({ dataDir });
    const backups = readdirSync(dataDir).filter((name) => name.startsWith(`${DATABASE_FILE_NAME}.bak-`));
    assert.equal(backups.length, 1, "exactly one backup should have been made before applying the breaking migration");
    const backupBytes = readFileSync(join(dataDir, backups[0]));
    assert.deepEqual(backupBytes, beforeBytes, "the backup must be a byte-for-byte copy of the pre-migration database");

    // And the real store is now actually usable at the new schema version.
    const capture = store.createCapture(sampleCaptureInput());
    assert.equal(capture.schemaVersion, RESULT_SCHEMA_VERSION);
    store.close();
  });
});

// A literal reconstruction of the *actual* pre-remediation Stage 3 schema
// (not today's already-corrected v1): no schema_version/document_ready_
// state/code/detail columns on captures (nothing validated a capture's
// shape against a real browser.read_tab result), a single NULL-distinct-
// prone UNIQUE(tag_id, capture_id, summary_id) index instead of the two
// partial indexes, the same bug on proposal_sources, and no
// decided_by_creator_type/name columns on proposals at all. Written
// directly with raw SQL — using today's MIGRATIONS[0] here would just be
// "today's v1 again," the exact gap this remediation closes (migration v2
// must remediate the actual old schema, not a corrected stand-in for it).
const LEGACY_PRE_REMEDIATION_V1_SCHEMA_SQL = `
  CREATE TABLE captures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    browser_session_id TEXT,
    source_operation TEXT,
    window_id INTEGER,
    tab_id INTEGER,
    url TEXT,
    title TEXT,
    captured_at INTEGER,
    status TEXT,
    character_count INTEGER,
    returned_character_count INTEGER,
    truncated INTEGER,
    text TEXT,
    created_at INTEGER
  );
  CREATE TABLE summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    creator_type TEXT,
    creator_name TEXT,
    model_metadata TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE summary_sources (
    summary_id INTEGER NOT NULL,
    capture_id INTEGER NOT NULL,
    PRIMARY KEY (summary_id, capture_id)
  );
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    creator_type TEXT,
    creator_name TEXT,
    created_at INTEGER
  );
  CREATE TABLE tag_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tag_id INTEGER NOT NULL,
    capture_id INTEGER,
    summary_id INTEGER,
    creator_type TEXT,
    creator_name TEXT,
    created_at INTEGER
  );
  -- The real pre-remediation bug: NULL <> NULL means this never actually
  -- rejects a duplicate (tag_id, capture_id) assignment.
  CREATE UNIQUE INDEX idx_tag_assignments_unique ON tag_assignments(tag_id, capture_id, summary_id);
  CREATE TABLE collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    creator_type TEXT,
    creator_name TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE collection_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id INTEGER NOT NULL,
    capture_id INTEGER,
    summary_id INTEGER,
    position INTEGER NOT NULL,
    creator_type TEXT,
    creator_name TEXT,
    created_at INTEGER
  );
  CREATE UNIQUE INDEX idx_collection_items_position ON collection_items(collection_id, position);
  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT,
    rationale TEXT,
    payload TEXT,
    creator_type TEXT,
    creator_name TEXT,
    state TEXT DEFAULT 'pending',
    created_at INTEGER,
    decided_at INTEGER
  );
  CREATE TABLE proposal_sources (
    proposal_id INTEGER NOT NULL,
    capture_id INTEGER,
    summary_id INTEGER
  );
  CREATE UNIQUE INDEX idx_proposal_sources_unique ON proposal_sources(proposal_id, capture_id, summary_id);
  CREATE TABLE queue_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT,
    capture_id INTEGER,
    summary_id INTEGER,
    proposal_id INTEGER,
    state TEXT,
    creator_type TEXT,
    creator_name TEXT,
    created_at INTEGER,
    updated_at INTEGER
  );
  CREATE TABLE retention_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    capture_retention_days INTEGER,
    updated_at INTEGER NOT NULL
  );
`;

test("migration v2 remediates the actual pre-remediation legacy schema: bad legacy data does not survive, and the new schema actually prevents the old bugs", async () => {
  await withTempDataDir(async (dataDir) => {
    await import("node:fs/promises").then((fs) => fs.mkdir(dataDir, { recursive: true }));
    const dbPath = join(dataDir, DATABASE_FILE_NAME);
    const { DatabaseSync } = await import("node:sqlite");

    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(LEGACY_PRE_REMEDIATION_V1_SCHEMA_SQL);
    rawDb.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    rawDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)").run(Date.now());
    rawDb.prepare("INSERT INTO retention_settings (id, capture_retention_days, updated_at) VALUES (1, NULL, ?)").run(Date.now());

    // A caller-invented "evidence" row: the real pre-remediation store had
    // no validateCaptureInput reuse of browser.read_tab's own shape check,
    // so an arbitrary sourceOperation with no code/detail/schema_version
    // columns at all could be written directly.
    const legacyCaptureId = Number(
      rawDb
        .prepare(
          "INSERT INTO captures (browser_session_id, source_operation, window_id, tab_id, url, title, captured_at, status, character_count, returned_character_count, truncated, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("legacy-session", "made-up-evidence", 1, 10, "https://legacy.example/", "Legacy", Date.now(), "ok", 5, 5, 0, "hello", Date.now())
        .lastInsertRowid,
    );

    // The real pre-remediation bug in action: two rows assigning the same
    // tag to the same capture, both with summary_id = NULL — accepted by
    // the old whole-row UNIQUE index because NULL <> NULL.
    rawDb.prepare("INSERT INTO tags (name, creator_type, created_at) VALUES ('legacy-tag', 'user', ?)").run(Date.now());
    const legacyTagId = 1;
    rawDb
      .prepare("INSERT INTO tag_assignments (tag_id, capture_id, summary_id, creator_type, created_at) VALUES (?, ?, NULL, 'user', ?)")
      .run(legacyTagId, legacyCaptureId, Date.now());
    rawDb
      .prepare("INSERT INTO tag_assignments (tag_id, capture_id, summary_id, creator_type, created_at) VALUES (?, ?, NULL, 'user', ?)")
      .run(legacyTagId, legacyCaptureId, Date.now());
    assert.equal(
      rawDb.prepare("SELECT COUNT(*) AS n FROM tag_assignments WHERE tag_id = ? AND capture_id = ?").get(legacyTagId, legacyCaptureId).n,
      2,
      "the legacy whole-row unique index must have actually allowed the duplicate, or this fixture is not reproducing the real bug",
    );

    // The other real pre-remediation bug: an "accepted" proposal with no
    // decider at all — the columns do not even exist on this schema.
    rawDb
      .prepare("INSERT INTO proposals (kind, rationale, payload, creator_type, state, created_at, decided_at) VALUES ('tag', 'because', '{}', 'agent', 'accepted', ?, ?)")
      .run(Date.now(), Date.now());

    rawDb.close();

    // The real openStore() path: sees a non-empty, already-migrated
    // (version 1) database and a breaking v2 next in line, so it must back
    // up first, then remediate.
    const store = await openStore({ dataDir });
    const backups = readdirSync(dataDir).filter((name) => name.startsWith(`${DATABASE_FILE_NAME}.bak-`));
    assert.equal(backups.length, 1, "the real legacy schema must still be backed up before the breaking migration touches it");

    // Stage 3 was never published, so v2's documented pre-release policy is
    // a reset of captured/derived data on top of that backup, not an
    // attempt to surgically repair unverifiable legacy rows: the
    // caller-invented capture, the duplicate tag assignment, and the
    // no-decider "accepted" proposal must not survive.
    assert.equal(store.listCaptures({}).items.length, 0, "the legacy caller-invented capture must not survive the v2 reset");
    assert.equal(store.listTags({}).items.length, 0, "legacy tag rows must not survive the v2 reset");
    assert.equal(store.listProposals({}).items.length, 0, "the legacy no-decider proposal must not survive the v2 reset");
    // Retention settings (service configuration, not captured/derived
    // content) must survive the reset untouched.
    assert.equal(store.getRetentionSettings().captureRetentionDays, null);

    // And the new schema actually prevents the old bug going forward, via
    // the store's own validated API, not a second raw insert.
    const freshCapture = store.createCapture(sampleCaptureInput());
    const freshTag = store.createTag({ name: "fresh-tag", creatorType: "user" });
    store.assignTag({ tagId: freshTag.id, recordType: "capture", recordId: freshCapture.id, creatorType: "user" });
    await assertRejects(
      () => store.assignTag({ tagId: freshTag.id, recordType: "capture", recordId: freshCapture.id, creatorType: "user" }),
      STORE_ERROR_CODES.CONFLICT,
    );

    // And the new partial-unique-index schema is what's actually there now,
    // not the old whole-row one merely shadowed by something else.
    const rawCheck = new DatabaseSync(store.dbPath, { readOnly: true });
    const indexNames = rawCheck
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tag_assignments'")
      .all()
      .map((r) => r.name);
    rawCheck.close();
    assert.ok(indexNames.includes("idx_tag_assignments_unique_capture"));
    assert.ok(!indexNames.includes("idx_tag_assignments_unique"), "the old NULL-distinct-prone whole-row index must be gone, not merely shadowed");

    store.close();
  });
});

// The inverse of the above: a brand-new database applying v1 *and* a
// breaking v2 in the same, first-ever openStore() call must not back up
// anything — there is no prior data to protect, since nothing could have
// been written between v1 and v2 within one call.
test("a brand-new database applying multiple migrations (including a breaking one) in its first start never backs up", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    const backups = readdirSync(dataDir).filter((name) => name.startsWith(`${DATABASE_FILE_NAME}.bak-`));
    assert.equal(backups.length, 0);
    store.close();
  });
});

test("foreign keys are actually enforced at the connection level (not just assumed)", async () => {
  await withTempDataDir(async (dataDir) => {
    const store = await openStore({ dataDir });
    // No application-level pre-check exists for this path other than the
    // database's own FK enforcement — a regression that dropped `PRAGMA
    // foreign_keys = ON` would make this insert silently succeed instead.
    await assertRejects(
      () => store.createSummary({ text: "x", creatorType: "user", sourceCaptureIds: [1] }),
      STORE_ERROR_CODES.SOURCE_NOT_FOUND,
    );
    store.close();
  });
});
