// Stage 3: the explicit, versioned CRUD route table for the derived store.
// Kept separate from service/server.mjs's HTTP/auth/rate-limit plumbing:
// this module only maps a route name + already-parsed query/body input onto
// the corresponding service/store.mjs call. Every route below is local-only
// (never reachable from the extension WebSocket) and goes through the same
// authentication, protocol-version, and rate-limit checks as the Stage 2
// browser.* routes (see dispatchStoreRoute's caller in server.mjs).
import { STORE_ERROR_CODES, StoreError } from "./store-errors.mjs";

function queryParam(url, name) {
  const raw = url.searchParams.get(name);
  return raw === null ? undefined : raw;
}

// A query-string id is always required to be a positive integer; an absent
// or empty value is rejected the same explicit way (never coerced to 0 or
// silently ignored).
function requireIdParam(url, name = "id") {
  const raw = queryParam(url, name);
  const value = raw === undefined || raw === "" ? NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StoreError(STORE_ERROR_CODES.VALIDATION_ERROR, `${name}: must be a positive integer query parameter`);
  }
  return value;
}

// An absent optional numeric query param is passed through as `undefined`
// (not supplied) so the store layer's own validators can tell that apart
// from a genuinely malformed value; an explicitly empty one (`?limit=`)
// becomes NaN, same as requireIdParam, so it is rejected rather than
// silently coerced to 0 via Number("").
function optionalIntParam(url, name) {
  const raw = queryParam(url, name);
  if (raw === undefined) return undefined;
  if (raw === "") return NaN;
  return Number(raw);
}

function optionalStringParam(url, name) {
  return queryParam(url, name);
}

// Strict: only an absent param or exactly "true"/"false" is accepted.
// Anything else (a typo, "1"/"0", "TRUE", ...) is rejected explicitly
// rather than silently treated as `false` — a caller who mistypes
// `?cascade=ture` must be told, not have their cascading delete silently
// downgraded to a non-cascading one.
function booleanParam(url, name, defaultValue = false) {
  const raw = queryParam(url, name);
  if (raw === undefined) return defaultValue;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new StoreError(STORE_ERROR_CODES.VALIDATION_ERROR, `${name}: must be "true" or "false"`);
}

function listQuery(url) {
  return { limit: optionalIntParam(url, "limit"), offset: optionalIntParam(url, "offset") };
}

// name -> { httpMethod, run(ctx) }. `ctx` is `{ store, url, body }`; `body`
// is the already-bounded, already-JSON-parsed request body for POST/PATCH
// routes (undefined for GET/DELETE, which carry no body in this API).
export const STORE_ROUTES = new Map([
  ["store.captures.create", { httpMethod: "POST", run: ({ store, body }) => store.createCapture(body) }],
  [
    "store.captures.list",
    {
      httpMethod: "GET",
      run: ({ store, url }) =>
        store.listCaptures({
          ...listQuery(url),
          id: optionalIntParam(url, "id"),
          windowId: optionalIntParam(url, "windowId"),
          tabId: optionalIntParam(url, "tabId"),
          status: optionalStringParam(url, "status"),
        }),
    },
  ],
  [
    "store.captures.read",
    {
      httpMethod: "GET",
      run: ({ store, url }) =>
        store.readCapture({
          id: requireIdParam(url),
          offset: optionalIntParam(url, "offset"),
          maxChars: optionalIntParam(url, "maxChars"),
        }),
    },
  ],
  [
    "store.captures.delete",
    {
      httpMethod: "DELETE",
      run: ({ store, url }) => store.deleteCapture(requireIdParam(url), { cascade: booleanParam(url, "cascade") }),
    },
  ],

  ["store.summaries.create", { httpMethod: "POST", run: ({ store, body }) => store.createSummary(body) }],
  [
    "store.summaries.list",
    {
      httpMethod: "GET",
      run: ({ store, url }) =>
        store.listSummaries({ ...listQuery(url), id: optionalIntParam(url, "id"), creatorType: optionalStringParam(url, "creatorType") }),
    },
  ],
  [
    "store.summaries.update",
    { httpMethod: "PATCH", run: ({ store, url, body }) => store.updateSummary(requireIdParam(url), body) },
  ],
  [
    "store.summaries.delete",
    {
      httpMethod: "DELETE",
      run: ({ store, url }) => store.deleteSummary(requireIdParam(url), { cascade: booleanParam(url, "cascade") }),
    },
  ],

  ["store.tags.create", { httpMethod: "POST", run: ({ store, body }) => store.createTag(body) }],
  [
    "store.tags.list",
    { httpMethod: "GET", run: ({ store, url }) => store.listTags({ ...listQuery(url), id: optionalIntParam(url, "id") }) },
  ],
  ["store.tags.delete", { httpMethod: "DELETE", run: ({ store, url }) => store.deleteTag(requireIdParam(url)) }],
  ["store.tags.assign", { httpMethod: "POST", run: ({ store, body }) => store.assignTag(body) }],
  [
    "store.tags.unassign",
    {
      httpMethod: "DELETE",
      run: ({ store, url }) =>
        store.unassignTag({
          tagId: requireIdParam(url, "tagId"),
          recordType: optionalStringParam(url, "recordType"),
          recordId: optionalIntParam(url, "recordId"),
        }),
    },
  ],
  [
    "store.tags.assignments.list",
    {
      httpMethod: "GET",
      run: ({ store, url }) =>
        store.listTagAssignments({
          ...listQuery(url),
          tagId: optionalIntParam(url, "tagId"),
          recordType: optionalStringParam(url, "recordType"),
          recordId: optionalIntParam(url, "recordId"),
        }),
    },
  ],

  ["store.collections.create", { httpMethod: "POST", run: ({ store, body }) => store.createCollection(body) }],
  [
    "store.collections.list",
    { httpMethod: "GET", run: ({ store, url }) => store.listCollections({ ...listQuery(url), id: optionalIntParam(url, "id") }) },
  ],
  [
    "store.collections.update",
    { httpMethod: "PATCH", run: ({ store, url, body }) => store.updateCollection(requireIdParam(url), body) },
  ],
  ["store.collections.delete", { httpMethod: "DELETE", run: ({ store, url }) => store.deleteCollection(requireIdParam(url)) }],
  ["store.collections.items.add", { httpMethod: "POST", run: ({ store, body }) => store.addCollectionItem(body) }],
  [
    "store.collections.items.remove",
    { httpMethod: "DELETE", run: ({ store, url }) => store.removeCollectionItem(requireIdParam(url)) },
  ],
  [
    "store.collections.items.list",
    {
      httpMethod: "GET",
      run: ({ store, url }) => store.listCollectionItems({ ...listQuery(url), collectionId: requireIdParam(url, "collectionId") }),
    },
  ],
  [
    "store.collections.items.reorder",
    { httpMethod: "PATCH", run: ({ store, body }) => store.reorderCollectionItems(body) },
  ],

  ["store.queue.create", { httpMethod: "POST", run: ({ store, body }) => store.createQueueItem(body) }],
  [
    "store.queue.list",
    {
      httpMethod: "GET",
      run: ({ store, url }) =>
        store.listQueueItems({
          ...listQuery(url),
          id: optionalIntParam(url, "id"),
          state: optionalStringParam(url, "state"),
          recordType: optionalStringParam(url, "recordType"),
        }),
    },
  ],
  ["store.queue.update", { httpMethod: "PATCH", run: ({ store, url, body }) => store.updateQueueItem(requireIdParam(url), body) }],
  ["store.queue.delete", { httpMethod: "DELETE", run: ({ store, url }) => store.deleteQueueItem(requireIdParam(url)) }],

  ["store.proposals.create", { httpMethod: "POST", run: ({ store, body }) => store.createProposal(body) }],
  [
    "store.proposals.list",
    {
      httpMethod: "GET",
      run: ({ store, url }) =>
        store.listProposals({
          ...listQuery(url),
          id: optionalIntParam(url, "id"),
          state: optionalStringParam(url, "state"),
          kind: optionalStringParam(url, "kind"),
        }),
    },
  ],
  [
    "store.proposals.update",
    { httpMethod: "PATCH", run: ({ store, url, body }) => store.updateProposalState(requireIdParam(url), body) },
  ],
  ["store.proposals.delete", { httpMethod: "DELETE", run: ({ store, url }) => store.deleteProposal(requireIdParam(url)) }],

  ["store.retention.get", { httpMethod: "GET", run: ({ store }) => store.getRetentionSettings() }],
  ["store.retention.update", { httpMethod: "PATCH", run: ({ store, body }) => store.updateRetentionSettings(body) }],
  ["store.retention.cleanup", { httpMethod: "POST", run: ({ store }) => store.runRetentionCleanup() }],

  ["store.clear", { httpMethod: "POST", run: ({ store }) => store.clearAll() }],
]);

// HTTP statuses for stable store error codes (service/store-errors.mjs),
// mirrored alongside service/server.mjs's existing ERROR_STATUS table for
// browser-bridge transport errors; kept separate since these are a
// different error namespace (see store-errors.mjs's header comment).
export const STORE_ERROR_STATUS = Object.freeze({
  [STORE_ERROR_CODES.VALIDATION_ERROR]: 400,
  [STORE_ERROR_CODES.MALFORMED_BODY]: 400,
  [STORE_ERROR_CODES.NOT_FOUND]: 404,
  [STORE_ERROR_CODES.SOURCE_NOT_FOUND]: 422,
  [STORE_ERROR_CODES.HAS_DEPENDENTS]: 409,
  [STORE_ERROR_CODES.CONFLICT]: 409,
  [STORE_ERROR_CODES.PAYLOAD_TOO_LARGE]: 413,
  [STORE_ERROR_CODES.DB_ERROR]: 500,
});
