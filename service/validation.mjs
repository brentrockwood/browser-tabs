// Deep, trust-boundary input validation for the Stage 3 derived store. Every
// field accepted from an HTTP caller is checked here — type, shape, and an
// explicit bound — before it ever reaches a SQL statement; nothing is
// trusted merely because it parsed as JSON. SQL injection safety itself
// comes from service/store.mjs always using parameterized `?` placeholders,
// never string concatenation — this module is the separate, additional
// defense of rejecting malformed/oversized input outright.
import {
  MAX_TEXT_CHARACTERS,
  TAB_GROUP_COLORS,
  isValidGroupColor,
  isValidGroupTitle,
  isValidHandle,
  isValidTimestamp,
  normalizeGroupConfig,
  normalizeOpenUrl,
  validateMethodResult,
} from "../extension/protocol.js";
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

// ---- Phase 2 Action 1: open a URL in a new tab ----

export const ACTION_KINDS = Object.freeze(["open_tab", "configure_group"]);
// previewed -> approved | rejected; approved -> one of the four result
// states. Every state after "previewed" other than "approved" is terminal.
export const ACTION_STATES = Object.freeze(["previewed", "approved", "rejected", "executed", "partial", "stale", "failed"]);
export const ACTION_RESULT_STATES = Object.freeze(["executed", "partial", "stale", "failed"]);
// What the browser is known to have undergone: nothing, one new tab (or, for a
// group action, one new group), one existing group updated, or unknown (the
// request was sent but its outcome never came back intact).
export const ACTION_MUTATIONS = Object.freeze(["none", "created", "updated", "unknown"]);
// Each kind's own subset: opening a tab never "updates" anything.
const OPEN_TAB_MUTATIONS = Object.freeze(["none", "created", "unknown"]);
export const ACTION_AUDIT_EVENTS = Object.freeze(["preview", "approve", "reject", "result"]);
// The recorded result of an action found still "approved" after a restart.
export const ACTION_INTERRUPTED_CODE = "interrupted_by_restart";
export const ACTION_INTERRUPTED_DETAIL =
  "the service stopped after this action was approved and before its result was recorded; the browser may or may not have applied it";
// Bounds: how many previews may await a decision at once, and how many audit
// events the append-only log accepts before refusing *new* previews (the
// decision and result events of an already-previewed action are always
// recorded, so the log never has to drop an event for work in flight).
export const MAX_PENDING_ACTIONS = 50;
export const MAX_ACTION_AUDIT_EVENTS = 10_000;
// The browser's observed state is stored clipped to these bounds: it is
// untrusted browser content, and a result must be persistable after the tab
// has already been opened.
export const MAX_OBSERVED_TITLE_LENGTH = 500;
export const MAX_OBSERVED_URL_LENGTH = 2_048;
export const MAX_ACTION_DETAIL_LENGTH = 500;
export const MAX_OBSERVED_STATUS_LENGTH = 50;

export function clipText(value, maxLength) {
  return typeof value === "string" && value.length > maxLength ? value.slice(0, maxLength) : value;
}

// A preview binds the exact normalized URL to the browser session it was
// taken in (and, in the store, to its timestamp); see normalizeOpenUrl in
// extension/protocol.js for what a URL must satisfy.
export function validateActionPreviewInput(input = {}) {
  if (input.kind === "configure_group") {
    const browserSessionId = requireNonEmptyString(input.browserSessionId, "browserSessionId", { maxLength: MAX_SESSION_ID_LENGTH });
    return { kind: "configure_group", url: null, binding: validateGroupBinding(input.binding), browserSessionId };
  }
  if (input.kind !== undefined && input.kind !== "open_tab") fail("kind", `must be one of: ${ACTION_KINDS.join(", ")}`);
  const checked = normalizeOpenUrl(input.url);
  if (!checked.valid) fail("url", checked.reason);
  const browserSessionId = requireNonEmptyString(input.browserSessionId, "browserSessionId", { maxLength: MAX_SESSION_ID_LENGTH });
  return { kind: "open_tab", url: checked.url, binding: null, browserSessionId };
}

// Phase 2 Action 2: what a stored group preview binds — the exact handles and
// bound current state (see normalizeGroupConfig in extension/protocol.js for
// the rules, shared with the extension) plus, for a create, the chosen tab's
// title and address so the preview can be recognized later. Those two are
// untrusted browser text, clipped, shown but never matched against.
function validateGroupBinding(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("binding", "must be a plain object");
  const checked = normalizeGroupConfig(value);
  if (!checked.valid) fail("binding", checked.reason);
  if (checked.config.operation !== "create") return checked.config;
  return {
    ...checked.config,
    tabTitle: optionalNullableString(value.tabTitle, "binding.tabTitle", { maxLength: MAX_OBSERVED_TITLE_LENGTH }),
    tabUrl: optionalNullableString(value.tabUrl, "binding.tabUrl", { maxLength: MAX_OBSERVED_URL_LENGTH }),
  };
}

// The HTTP body of a group preview: only the operation, one exact handle, and
// the requested change — never a session or window (those are learned from
// the browser), never anything else. `title` is a string when present ("" on
// an update clears the title); `color` is a native tab-group color.
export function validateGroupPreviewRequest(body) {
  const accepted = {
    create: ["operation", "tabId", "title", "color"],
    update: ["operation", "groupId", "title", "color"],
  };
  if (!Object.hasOwn(accepted, body.operation)) fail("operation", 'must be "create" or "update"');
  for (const key of Object.keys(body)) {
    if (!accepted[body.operation].includes(key)) fail(key, `is not accepted for operation "${body.operation}"`);
  }
  const handleName = body.operation === "create" ? "tabId" : "groupId";
  if (!isValidHandle(body[handleName])) fail(handleName, "must be a non-negative safe integer");
  if (Object.hasOwn(body, "title") && !isValidGroupTitle(body.title)) fail("title", "must be plain text with no control characters, within the bound");
  if (Object.hasOwn(body, "color") && !isValidGroupColor(body.color)) fail("color", `must be one of: ${TAB_GROUP_COLORS.join(", ")}`);
  if (body.operation === "create" && body.title === "") fail("title", "a new group cannot be created with an empty title");
  return { operation: body.operation, [handleName]: body[handleName], title: body.title ?? null, color: body.color ?? null };
}

function validateObservedTab(value) {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail("observed", "must be a plain object or null");
  if (!Number.isSafeInteger(value.index) || value.index < 0) fail("observed.index", "must be a non-negative integer");
  return {
    index: value.index,
    active: requireBoolean(value.active, "observed.active"),
    status: requireNonEmptyString(value.status, "observed.status", { maxLength: MAX_OBSERVED_STATUS_LENGTH }),
    title: optionalNullableString(value.title, "observed.title", { maxLength: MAX_OBSERVED_TITLE_LENGTH }),
    url: optionalNullableString(value.url, "observed.url", { maxLength: MAX_OBSERVED_URL_LENGTH }),
    pendingUrl: optionalNullableString(value.pendingUrl, "observed.pendingUrl", { maxLength: MAX_OBSERVED_URL_LENGTH }),
  };
}

// The outcome of one approved action, as the service interpreted the
// extension's answer. The combinations are checked, not trusted: "executed"
// and "partial" mean a tab was created (and only "executed" observed it),
// "stale" means nothing was.
export function validateActionResultInput(input = {}, kind = "open_tab") {
  if (kind === "configure_group") return validateGroupResultInput(input);
  const state = requireEnum(input.state, ACTION_RESULT_STATES, "state");
  const mutation = requireEnum(input.mutation, OPEN_TAB_MUTATIONS, "mutation");
  if ((state === "executed" || state === "partial") && mutation !== "created") {
    fail("mutation", `must be "created" when state is "${state}"`);
  }
  if (state === "stale" && mutation !== "none") fail("mutation", 'must be "none" when state is "stale"');
  const code = state === "executed" ? null : requireNonEmptyString(input.code, "code", { maxLength: MAX_CODE_LENGTH });
  const detail = optionalNullableString(input.detail, "detail", { maxLength: MAX_ACTION_DETAIL_LENGTH });
  const tabId = optionalNullableHandle(input.tabId, "tabId");
  const windowId = optionalNullableHandle(input.windowId, "windowId");
  const observed = validateObservedTab(input.observed ?? null);
  if (state === "executed" && (observed === null || tabId === null || windowId === null)) {
    fail("observed", 'is required, with tabId and windowId, when state is "executed"');
  }
  if (state !== "executed" && observed !== null) fail("observed", 'is only allowed when state is "executed"');
  if ((state === "stale" || state === "failed") && (tabId !== null || windowId !== null)) {
    fail("tabId/windowId", `must be omitted when state is "${state}"`);
  }
  return { state, mutation, code, detail, tabId, windowId, observed };
}

function validateObservedGroup(value) {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) fail("observed", "must be a plain object or null");
  return {
    windowId: requireHandle(value.windowId, "observed.windowId"),
    title: optionalNullableString(value.title, "observed.title", { maxLength: MAX_OBSERVED_TITLE_LENGTH }),
    color: optionalNullableString(value.color, "observed.color", { maxLength: MAX_OBSERVED_STATUS_LENGTH }),
    collapsed: requireBoolean(value.collapsed, "observed.collapsed"),
  };
}

function requireHandle(value, fieldName) {
  if (!isValidHandle(value)) fail(fieldName, "must be a non-negative safe integer");
  return value;
}

// The group-action counterpart of the above. "executed" means the change was
// made and observed (`mutation` "created" for a new group, "updated" for an
// existing one, with the group's handles and observed state); "partial"
// means a change was made but not completed or observed; "stale" and "failed"
// carry no handles or observation, and "stale" is always a certain no-op.
function validateGroupResultInput(input) {
  const state = requireEnum(input.state, ACTION_RESULT_STATES, "state");
  const mutation = requireEnum(input.mutation, ACTION_MUTATIONS, "mutation");
  if ((state === "executed" || state === "partial") && mutation !== "created" && mutation !== "updated") {
    fail("mutation", `must be "created" or "updated" when state is "${state}"`);
  }
  if (state === "stale" && mutation !== "none") fail("mutation", 'must be "none" when state is "stale"');
  if (state === "failed" && mutation !== "none" && mutation !== "unknown") fail("mutation", 'must be "none" or "unknown" when state is "failed"');
  const code = state === "executed" ? null : requireNonEmptyString(input.code, "code", { maxLength: MAX_CODE_LENGTH });
  const detail = optionalNullableString(input.detail, "detail", { maxLength: MAX_ACTION_DETAIL_LENGTH });
  const tabId = optionalNullableHandle(input.tabId, "tabId");
  const groupId = optionalNullableHandle(input.groupId, "groupId");
  const windowId = optionalNullableHandle(input.windowId, "windowId");
  const observed = validateObservedGroup(input.observed ?? null);
  if (state === "executed" && (observed === null || groupId === null || windowId === null)) {
    fail("observed", 'is required, with groupId and windowId, when state is "executed"');
  }
  if (state !== "executed" && observed !== null) fail("observed", 'is only allowed when state is "executed"');
  if ((state === "stale" || state === "failed") && (tabId !== null || groupId !== null || windowId !== null)) {
    fail("tabId/groupId/windowId", `must be omitted when state is "${state}"`);
  }
  return { state, mutation, code, detail, tabId, groupId, windowId, observed };
}
