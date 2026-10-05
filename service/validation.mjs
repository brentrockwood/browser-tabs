// Deep, trust-boundary input validation for the Stage 3 derived store. Every
// field accepted from an HTTP caller is checked here — type, shape, and an
// explicit bound — before it ever reaches a SQL statement; nothing is
// trusted merely because it parsed as JSON. SQL injection safety itself
// comes from service/store.mjs always using parameterized `?` placeholders,
// never string concatenation — this module is the separate, additional
// defense of rejecting malformed/oversized input outright.
import { MAX_TEXT_CHARACTERS, isValidHandle, isValidTimestamp, validateMethodResult } from "../extension/protocol.js";
import { STORE_ERROR_CODES, StoreError } from "./store-errors.mjs";

// Captures persist exactly one Stage 2 result shape — a `browser.read_tab`
// result — never a caller-invented "evidence" object. This is the only
// value `sourceOperation` may take on a capture.
export const CAPTURE_SOURCE_OPERATION = "browser.read_tab";

export const CREATOR_TYPES = Object.freeze(["user", "client", "agent"]);
export const RECORD_TYPES_CAPTURE_SUMMARY = Object.freeze(["capture", "summary"]);
export const RECORD_TYPES_QUEUEABLE = Object.freeze(["capture", "summary", "proposal"]);
export const PROPOSAL_KINDS = Object.freeze(["tag", "collection", "queue", "browser_action"]);
export const PROPOSAL_STATES = Object.freeze(["pending", "accepted", "rejected"]);

export const MAX_URL_LENGTH = 10_000;
export const MAX_TITLE_LENGTH = 2_000;
export const MAX_SESSION_ID_LENGTH = 200;
export const MAX_SOURCE_OPERATION_LENGTH = 200;
export const MAX_CAPTURE_TEXT_LENGTH = MAX_TEXT_CHARACTERS;
export const MAX_DOCUMENT_READY_STATE_LENGTH = 50;
export const MAX_CODE_LENGTH = 200;
export const MAX_DETAIL_LENGTH = 4_000;
export const MAX_SUMMARY_TEXT_LENGTH = 50_000;
export const MAX_NAME_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 2_000;
export const MAX_RATIONALE_LENGTH = 5_000;
export const MAX_CREATOR_NAME_LENGTH = 200;
export const MAX_STATE_LENGTH = 100;
export const MAX_METADATA_BYTES = 20_000;
export const MAX_PAYLOAD_BYTES = 20_000;
export const MAX_SOURCE_IDS = 50;
export const MAX_LIST_LIMIT = 200;
export const DEFAULT_LIST_LIMIT = 50;
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
// store.captures.read's text-chunk bounds: a capture's full text can be up
// to MAX_CAPTURE_TEXT_LENGTH (500,000) characters, so a single read must
// still only ever return one bounded slice of it, never the whole thing —
// see validateCaptureReadInput below.
export const DEFAULT_CAPTURE_READ_CHUNK_CHARS = 10_000;
export const MAX_CAPTURE_READ_CHUNK_CHARS = 100_000;

function fail(fieldName, detail) {
  throw new StoreError(STORE_ERROR_CODES.VALIDATION_ERROR, `${fieldName}: ${detail}`);
}

export function requireNonEmptyString(value, fieldName, { maxLength } = {}) {
  if (typeof value !== "string" || value.length === 0) fail(fieldName, "must be a non-empty string");
  if (maxLength !== undefined && value.length > maxLength) fail(fieldName, `must be at most ${maxLength} characters`);
  return value;
}

export function optionalNullableString(value, fieldName, { maxLength } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(fieldName, "must be a string or null");
  if (maxLength !== undefined && value.length > maxLength) fail(fieldName, `must be at most ${maxLength} characters`);
  return value;
}

export function requirePositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(fieldName, "must be a positive integer");
  return value;
}

export function optionalNullableHandle(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (!isValidHandle(value)) fail(fieldName, "must be a non-negative safe integer or null");
  return value;
}

export function requireTimestamp(value, fieldName) {
  if (!isValidTimestamp(value)) fail(fieldName, "must be a non-negative finite number (ms since epoch)");
  return value;
}

export function requireEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) fail(fieldName, `must be one of: ${allowed.join(", ")}`);
  return value;
}

export function requireBoolean(value, fieldName) {
  if (typeof value !== "boolean") fail(fieldName, "must be a boolean");
  return value;
}

export function optionalNullableBoolean(value, fieldName) {
  if (value === undefined || value === null) return null;
  return requireBoolean(value, fieldName);
}

export function optionalNullableNonNegativeInteger(value, fieldName) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail(fieldName, "must be a non-negative integer or null");
  return value;
}

// Validates a caller-supplied id array used as source-record references
// (e.g. a summary's or proposal's source capture ids): a plain array of
// distinct positive integers, bounded in length. Missing-source rejection
// itself happens later via the database's own foreign-key check — this only
// rejects an obviously malformed list before any SQL is attempted.
export function requireIdArray(value, fieldName, { minLength = 0, maxLength = MAX_SOURCE_IDS } = {}) {
  if (!Array.isArray(value)) fail(fieldName, "must be an array");
  if (value.length < minLength) fail(fieldName, `must contain at least ${minLength} entr${minLength === 1 ? "y" : "ies"}`);
  if (value.length > maxLength) fail(fieldName, `must contain at most ${maxLength} entries`);
  for (const entry of value) {
    if (!Number.isSafeInteger(entry) || entry <= 0) fail(fieldName, "every entry must be a positive integer");
  }
  if (new Set(value).size !== value.length) fail(fieldName, "entries must be distinct");
  return value;
}

// Caller-supplied structured metadata (summary model metadata, proposal
// payload): untrusted JSON from a trust-boundary caller, never evaluated or
// treated as instructions — stored as an opaque, size-bounded JSON string.
export function optionalNullableJsonObject(value, fieldName, { maxBytes = MAX_METADATA_BYTES } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail(fieldName, "must be a plain object or null");
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    fail(fieldName, `must be JSON-serializable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (Buffer.byteLength(serialized) > maxBytes) fail(fieldName, `must serialize to at most ${maxBytes} bytes`);
  return serialized;
}

export function requireJsonObject(value, fieldName, { maxBytes = MAX_PAYLOAD_BYTES } = {}) {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(fieldName, "must be a plain object");
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    fail(fieldName, `must be JSON-serializable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (Buffer.byteLength(serialized) > maxBytes) fail(fieldName, `must serialize to at most ${maxBytes} bytes`);
  return serialized;
}

// Shared by every derived-record create input: "Record whether each derived
// value came from the user, a named local client, or an external agent"
// (project.md Stage 3). `creatorName` is required and bounded for `client`/
// `agent`, and must be absent/null for `user` — a single local user is in
// scope (project.md's trust model), so there is nothing else a `user`
// creator name could legitimately distinguish.
export function requireCreator({ creatorType, creatorName } = {}) {
  requireEnum(creatorType, CREATOR_TYPES, "creatorType");
  if (creatorType === "user") {
    if (creatorName !== undefined && creatorName !== null) {
      fail("creatorName", "must be omitted or null when creatorType is \"user\"");
    }
    return { creatorType, creatorName: null };
  }
  const name = requireNonEmptyString(creatorName, "creatorName", { maxLength: MAX_CREATOR_NAME_LENGTH });
  return { creatorType, creatorName: name };
}

// Optional numeric list-filter query parameters (id, windowId, tagId, ...):
// `undefined` (not supplied) passes through unchanged, but anything else
// malformed (a non-integer, a negative id, an empty-string-turned-NaN from
// the route layer) is rejected explicitly here rather than ever reaching a
// raw SQL parameter bind.
export function optionalFilterPositiveInteger(value, fieldName) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0) fail(fieldName, "must be a positive integer");
  return value;
}

export function optionalFilterNonNegativeInteger(value, fieldName) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) fail(fieldName, "must be a non-negative integer");
  return value;
}

export function optionalFilterEnum(value, allowed, fieldName) {
  if (value === undefined) return undefined;
  return requireEnum(value, allowed, fieldName);
}

// A bounded, typed list-filter string (e.g. queue `state`): `undefined`
// passes through unchanged, but anything present must be a non-empty
// string within the same bound enforced at creation time — never an
// unbounded or wrongly-typed value reaching a raw SQL parameter bind.
export function optionalFilterString(value, fieldName, { maxLength } = {}) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) fail(fieldName, "must be a non-empty string");
  if (maxLength !== undefined && value.length > maxLength) fail(fieldName, `must be at most ${maxLength} characters`);
  return value;
}

export function validateLimitOffset({ limit, offset } = {}) {
  let normalizedLimit = DEFAULT_LIST_LIMIT;
  if (limit !== undefined) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      fail("limit", `must be an integer between 1 and ${MAX_LIST_LIMIT}`);
    }
    normalizedLimit = limit;
  }
  let normalizedOffset = 0;
  if (offset !== undefined) {
    if (!Number.isSafeInteger(offset) || offset < 0) fail("offset", "must be a non-negative integer");
    normalizedOffset = offset;
  }
  return { limit: normalizedLimit, offset: normalizedOffset };
}

// Captures persist exactly one Stage 2 result: a `browser.read_tab`
// envelope+result the caller already fetched through the Stage 2 API
// (project.md Stage 3: "Store source records before accepting derived
// records that reference them"). This is explicit, caller-driven
// persistence of evidence already read, never an automatic side effect of
// calling the read API, and never a caller-invented shape: the input is
// validated against the *same* `validateMethodResult` that
// service/server.mjs already uses to decide whether the extension's own
// response is trustworthy (extension/protocol.js) — one source of truth
// for "what a browser.read_tab result looks like," not a second,
// independently-maintained shape definition that could drift from it.
// `validateMethodResult` enforces the envelope (schemaVersion,
// browserSessionId, sourceOperation, capturedAt, status) and, per status,
// the method-specific shape: a non-`"ok"` status requires a non-empty
// `code`; an `"ok"` status requires valid tabId/windowId handles,
// nullable url/title strings, a documentReadyState string, consistent
// text/characterCount/returnedCharacterCount/truncated fields. Beyond that
// shape check, bounds below (url/title/text/code/detail length caps,
// browserSessionId length) are this module's own defense-in-depth, since
// `validateMethodResult` itself only checks type and internal consistency,
// not maximum length.
export function validateCaptureInput(input = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail("body", "must be a plain object");
  }
  if (input.sourceOperation !== CAPTURE_SOURCE_OPERATION) {
    fail(
      "sourceOperation",
      `must be exactly "${CAPTURE_SOURCE_OPERATION}" — a capture persists a Stage 2 browser.read_tab result, not caller-invented evidence`,
    );
  }
  const validation = validateMethodResult(CAPTURE_SOURCE_OPERATION, input);
  if (!validation.valid) {
    fail("body", `must be a valid browser.read_tab result (${validation.reason})`);
  }

  const browserSessionId = requireNonEmptyString(input.browserSessionId, "browserSessionId", {
    maxLength: MAX_SESSION_ID_LENGTH,
  });
  const windowId = optionalNullableHandle(input.windowId, "windowId");
  const tabId = optionalNullableHandle(input.tabId, "tabId");
  const url = optionalNullableString(input.url, "url", { maxLength: MAX_URL_LENGTH });
  const title = optionalNullableString(input.title, "title", { maxLength: MAX_TITLE_LENGTH });
  const documentReadyState = optionalNullableString(input.documentReadyState, "documentReadyState", {
    maxLength: MAX_DOCUMENT_READY_STATE_LENGTH,
  });
  const characterCount = optionalNullableNonNegativeInteger(input.characterCount, "characterCount");
  const returnedCharacterCount = optionalNullableNonNegativeInteger(input.returnedCharacterCount, "returnedCharacterCount");
  const truncated = optionalNullableBoolean(input.truncated, "truncated");
  const text = optionalNullableString(input.text, "text", { maxLength: MAX_CAPTURE_TEXT_LENGTH });

  // Status-dependent fields, enforced here on top of validateMethodResult's
  // own per-status shape check: an "ok" result always has documentReadyState
  // (validateMethodResult already required `text` to be a string for "ok",
  // so a null `text` cannot reach this point for that status); any non-"ok"
  // status always carries a `code` (validateMethodResult already required
  // it to be a non-empty string — this only adds the length bound).
  const code =
    input.status === "ok" ? null : requireNonEmptyString(input.code, "code", { maxLength: MAX_CODE_LENGTH });
  const detail = optionalNullableString(input.detail, "detail", { maxLength: MAX_DETAIL_LENGTH });
  if (input.status === "ok" && documentReadyState === null) {
    fail("documentReadyState", "is required when status is \"ok\"");
  }

  // The real `browser.read_tab` extension response never carries url/
  // title/documentReadyState/characterCount/returnedCharacterCount/
  // truncated/text on a non-"ok" result (see extension/service-worker.js's
  // readTab — a non-"ok" envelope only ever adds tabId/windowId/code/
  // detail). A caller is free to omit tabId/windowId too (several non-"ok"
  // outcomes there are raised before a window/tab handle is even known),
  // so those two are not restricted here — but the "ok"-only fields are
  // rejected outright rather than persisted as invented content a real
  // non-"ok" capture could never actually have.
  //
  // This checks *presence on the original input object* via `Object.hasOwn`,
  // not the normalized value above: `optionalNullableString`/
  // `optionalNullableNonNegativeInteger`/`optionalNullableBoolean` all
  // normalize both "absent" and "explicitly null" to the same `null`, so
  // checking the normalized value (as an earlier revision did) could never
  // tell those two apart — a caller sending `url: null` on a non-"ok"
  // capture would silently pass. A real non-"ok" `browser.read_tab` result
  // never has these keys at all, not even set to null, so presence alone —
  // regardless of value — is what must be rejected.
  if (input.status !== "ok") {
    const OK_ONLY_FIELDS = ["url", "title", "documentReadyState", "characterCount", "returnedCharacterCount", "truncated", "text"];
    const inventedFields = OK_ONLY_FIELDS.filter((field) => Object.hasOwn(input, field));
    if (inventedFields.length > 0) {
      fail(
        inventedFields.join("/"),
        `must be omitted when status is "${input.status}" — a non-"ok" capture persists only the envelope's code/detail, never invented page content, not even as an explicit null`,
      );
    }
  }

  return {
    browserSessionId,
    sourceOperation: CAPTURE_SOURCE_OPERATION,
    schemaVersion: input.schemaVersion,
    windowId,
    tabId,
    url,
    title,
    documentReadyState,
    capturedAt: input.capturedAt,
    status: input.status,
    characterCount,
    returnedCharacterCount,
    truncated,
    text,
    code,
    detail,
  };
}

export function validateSummaryCreateInput(input = {}) {
  const text = requireNonEmptyString(input.text, "text", { maxLength: MAX_SUMMARY_TEXT_LENGTH });
  const creator = requireCreator(input);
  const sourceCaptureIds = requireIdArray(input.sourceCaptureIds, "sourceCaptureIds", { minLength: 1 });
  const modelMetadata = optionalNullableJsonObject(input.modelMetadata, "modelMetadata");
  return { text, ...creator, sourceCaptureIds, modelMetadata };
}

export function validateSummaryUpdateInput(input = {}) {
  const out = {};
  if (input.text !== undefined) out.text = requireNonEmptyString(input.text, "text", { maxLength: MAX_SUMMARY_TEXT_LENGTH });
  if (input.modelMetadata !== undefined) out.modelMetadata = optionalNullableJsonObject(input.modelMetadata, "modelMetadata");
  if (Object.keys(out).length === 0) fail("body", "must include at least one of: text, modelMetadata");
  return out;
}

export function validateTagCreateInput(input = {}) {
  const name = requireNonEmptyString(input.name, "name", { maxLength: MAX_NAME_LENGTH }).trim();
  if (name.length === 0) fail("name", "must not be blank");
  const creator = requireCreator(input);
  return { name, ...creator };
}

export function validateTagAssignmentInput(input = {}) {
  const tagId = requirePositiveInteger(input.tagId, "tagId");
  const recordType = requireEnum(input.recordType, RECORD_TYPES_CAPTURE_SUMMARY, "recordType");
  const recordId = requirePositiveInteger(input.recordId, "recordId");
  const creator = requireCreator(input);
  return { tagId, recordType, recordId, ...creator };
}

export function validateTagUnassignmentInput(input = {}) {
  const tagId = requirePositiveInteger(input.tagId, "tagId");
  const recordType = requireEnum(input.recordType, RECORD_TYPES_CAPTURE_SUMMARY, "recordType");
  const recordId = requirePositiveInteger(input.recordId, "recordId");
  return { tagId, recordType, recordId };
}

export function validateCollectionCreateInput(input = {}) {
  const name = requireNonEmptyString(input.name, "name", { maxLength: MAX_NAME_LENGTH }).trim();
  if (name.length === 0) fail("name", "must not be blank");
  const description = optionalNullableString(input.description, "description", { maxLength: MAX_DESCRIPTION_LENGTH });
  const creator = requireCreator(input);
  return { name, description, ...creator };
}

export function validateCollectionUpdateInput(input = {}) {
  const out = {};
  if (input.name !== undefined) {
    const name = requireNonEmptyString(input.name, "name", { maxLength: MAX_NAME_LENGTH }).trim();
    if (name.length === 0) fail("name", "must not be blank");
    out.name = name;
  }
  if (input.description !== undefined) out.description = optionalNullableString(input.description, "description", { maxLength: MAX_DESCRIPTION_LENGTH });
  if (Object.keys(out).length === 0) fail("body", "must include at least one of: name, description");
  return out;
}

export function validateCollectionItemInput(input = {}) {
  const collectionId = requirePositiveInteger(input.collectionId, "collectionId");
  const recordType = requireEnum(input.recordType, RECORD_TYPES_CAPTURE_SUMMARY, "recordType");
  const recordId = requirePositiveInteger(input.recordId, "recordId");
  const position = input.position === undefined ? null : optionalNullableNonNegativeInteger(input.position, "position");
  const creator = requireCreator(input);
  return { collectionId, recordType, recordId, position, ...creator };
}

export function validateCollectionReorderInput(input = {}) {
  const collectionId = requirePositiveInteger(input.collectionId, "collectionId");
  const orderedItemIds = requireIdArray(input.orderedItemIds, "orderedItemIds", { minLength: 1, maxLength: 10_000 });
  return { collectionId, orderedItemIds };
}

export function validateQueueCreateInput(input = {}) {
  const recordType = requireEnum(input.recordType, RECORD_TYPES_QUEUEABLE, "recordType");
  const recordId = requirePositiveInteger(input.recordId, "recordId");
  const state = requireNonEmptyString(input.state, "state", { maxLength: MAX_STATE_LENGTH });
  const creator = requireCreator(input);
  return { recordType, recordId, state, ...creator };
}

export function validateQueueUpdateInput(input = {}) {
  const state = requireNonEmptyString(input.state, "state", { maxLength: MAX_STATE_LENGTH });
  return { state };
}

export function validateProposalCreateInput(input = {}) {
  const kind = requireEnum(input.kind, PROPOSAL_KINDS, "kind");
  const rationale = requireNonEmptyString(input.rationale, "rationale", { maxLength: MAX_RATIONALE_LENGTH });
  const payload = requireJsonObject(input.payload, "payload");
  const creator = requireCreator(input);
  const sourceCaptureIds = input.sourceCaptureIds === undefined ? [] : requireIdArray(input.sourceCaptureIds, "sourceCaptureIds");
  const sourceSummaryIds = input.sourceSummaryIds === undefined ? [] : requireIdArray(input.sourceSummaryIds, "sourceSummaryIds");
  if (sourceCaptureIds.length === 0 && sourceSummaryIds.length === 0) {
    fail("sourceCaptureIds/sourceSummaryIds", "at least one source capture or summary id is required");
  }
  return { kind, rationale, payload, ...creator, sourceCaptureIds, sourceSummaryIds };
}

// Accepting/rejecting a proposal is itself a derived decision and must
// identify its decider the same way every other derived value does
// (project.md Stage 3). This is a caller-asserted identity, not a
// cryptographically distinct principal: project.md's trust model gives the
// whole local API a single shared credential, so nothing here proves which
// human or process actually supplied `creatorType`/`creatorName` — it only
// records what the caller claimed, the same honest limit that already
// applies to every other creator field in this module.
export function validateProposalUpdateInput(input = {}) {
  const state = requireEnum(input.state, ["accepted", "rejected"], "state");
  const decider = requireCreator(input);
  return { state, decidedByCreatorType: decider.creatorType, decidedByCreatorName: decider.creatorName };
}

// store.captures.read: a bounded, offset-addressable slice of one
// capture's text (project.md: "Lists and text payloads are bounded"), so a
// caller can inspect retained text after a restart without ever requesting
// the whole thing in one response. `id` is required; `offset`/`maxChars`
// default to the start of the text and a conservative chunk size.
export function validateCaptureReadInput({ id, offset, maxChars } = {}) {
  const validId = requirePositiveInteger(id, "id");
  let normalizedOffset = 0;
  if (offset !== undefined) {
    if (!Number.isSafeInteger(offset) || offset < 0) fail("offset", "must be a non-negative integer");
    normalizedOffset = offset;
  }
  let normalizedMaxChars = DEFAULT_CAPTURE_READ_CHUNK_CHARS;
  if (maxChars !== undefined) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > MAX_CAPTURE_READ_CHUNK_CHARS) {
      fail("maxChars", `must be an integer between 1 and ${MAX_CAPTURE_READ_CHUNK_CHARS}`);
    }
    normalizedMaxChars = maxChars;
  }
  return { id: validId, offset: normalizedOffset, maxChars: normalizedMaxChars };
}

// A record-type filter pair (e.g. tag-assignment listing's recordType/
// recordId): either both are supplied, or neither is. A partial filter —
// recordType alone, or recordId alone — is rejected explicitly rather than
// silently widened into "every record of that type" or "that id regardless
// of type," either of which would be a different, unintended query than
// whatever the caller who supplied only one of the two actually meant.
export function requireRecordFilterPairOrNeither(recordType, recordId, allowedTypes) {
  const hasType = recordType !== undefined;
  const hasId = recordId !== undefined;
  if (hasType !== hasId) {
    fail("recordType/recordId", "must be supplied together (both or neither) — a partial record filter is rejected");
  }
  if (!hasType) return { recordType: undefined, recordId: undefined };
  return {
    recordType: requireEnum(recordType, allowedTypes, "recordType"),
    recordId: requirePositiveInteger(recordId, "recordId"),
  };
}

export function validateRetentionUpdateInput(input = {}) {
  if (input.captureRetentionDays === null) return { captureRetentionDays: null };
  const value = input.captureRetentionDays;
  if (!Number.isSafeInteger(value) || value < 1 || value > 3650) {
    fail("captureRetentionDays", "must be a positive integer (days) of at most 3650, or null to disable retention cleanup");
  }
  return { captureRetentionDays: value };
}
