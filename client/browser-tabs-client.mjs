// Stage 4 (remediated): the reference client for an external-agent caller
// of the Browser Tabs service's public HTTP API. This is strictly a
// *scoped, external-agent* client — there is no owner-scoped client in this
// repository, because the owner already has direct, unrestricted access to
// every documented route (curl, `npm run service -- show-token`, or
// `service/cli.mjs` itself). Everything exported here is deliberately
// narrower than the full public API: the methods below are the complete
// allowlist the service's own `AGENT_ALLOWED_*` sets (service/server.mjs)
// grant to the external-agent credential this client authenticates with —
// not a client-side opinion about what an agent "should" be allowed to
// call. There is no generic escape hatch (no public `call(method, ...)`):
// every reachable operation is its own named, individually validated
// method, and the HTTP verb/transport details are private.
//
// Threat/provenance model (see project.md's "Trust model" for the full
// statement this client must respect):
//   - Everything this client reads back from `browser.*` routes (window/tab
//     lists, page text, history) is untrusted browser content, carried with
//     its own capture-provenance envelope. This client never evaluates it,
//     executes it, or lets it select which method is called next.
//   - `captureTab` does not submit a capture body at all — it calls the
//     server-side `workflow.capture_tab` operation, which performs the
//     `browser.read_tab` round trip *on the server* and persists exactly
//     that server-fetched result. There is no method on this client that
//     can submit an arbitrary "capture" JSON body (the service's own
//     `store.captures.create` is owner-only and is not exposed here at
//     all), so this client cannot forge stored browser evidence no matter
//     what its caller asks it to send.
//   - `createSummary`/`createProposal` never accept or send a
//     `creatorType`/`creatorName` — the service overrides both to a fixed,
//     server-controlled external-agent identity for every agent-scoped
//     write (service/server.mjs), so there is nothing for this client to
//     expose there; a caller cannot claim `creatorType: "user"` through
//     this client even by trying, because the parameter does not exist
//     here. `modelMetadata` (on a summary) and `payload` (on a proposal)
//     are preserved by the service as opaque, size-bounded JSON — this
//     project's documented place for caller-supplied *model and prompt*
//     metadata (e.g. `{ model: "...", prompt: "..." }`) — never parsed,
//     executed, or treated as an instruction.
//   - A proposal's `kind` only labels what the proposal is about; creating
//     one never invokes an extension method and never changes its own
//     approval state — it is always created `"pending"`. This client has
//     no method corresponding to `store.proposals.update` (deciding a
//     proposal) at all: that is owner-only, and not part of the allowlist
//     this client authenticates against.
//
// Depends only on Node's built-in `fetch`, `node:crypto`, `node:fs`,
// `node:os`, and `node:path` — no npm package.
import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8743";
// Matches extension/protocol.js's PROTOCOL_VERSION as of this writing
// (see README.md's "Calling the API"). Deliberately a literal, not an
// import from this repository's own protocol module: this client is meant
// to work as a standalone reference for an external caller that may not
// have this repository's source tree at all, and the service rejects a
// mismatched version explicitly (`400 unsupported_protocol_version`) rather
// than silently misbehaving if this ever drifts.
export const DEFAULT_PROTOCOL_VERSION = 5;

// Defense in depth on top of the service's own response-size bound
// (`MAX_RESPONSE_BYTES`/`MAX_WS_MESSAGE_BYTES`, documented in README.md's
// "Bounds" section): this client never buffers more than this many bytes of
// a response body itself, regardless of what `baseUrl` sends back.
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// Checked before a request is even sent, mirroring the service's own
// request-body bound (service/validation.mjs's MAX_REQUEST_BODY_BYTES) so
// an oversized write fails fast locally instead of after a slow upload.
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
// A bounded file read never loads more than this many bytes into memory
// before deciding the file is too large — see readFileBounded below.
const DEFAULT_MAX_CREDENTIAL_FILE_BYTES = 4096;

// Mirrors small, public bounds already documented in README.md (not
// imported — this client has no dependency on this repository's internal
// source), applied here purely as client-side defense in depth: the
// service enforces its own, authoritative versions of every one of these.
const MAX_SESSION_ID_LENGTH = 200;
const MAX_HANDLE = 2 ** 31 - 1; // generous bound for a window/tab id
const MAX_RECORD_ID = 1_000_000_000; // generous bound for a store record id
const MAX_LIST_LIMIT = 200;
const MAX_LIST_OFFSET = 1_000_000;
const MAX_HISTORY_RESULTS = 500;
const MAX_CAPTURE_READ_CHUNK_CHARS = 100_000;
const MAX_CAPTURE_READ_OFFSET = 10_000_000;
const MAX_SUMMARY_TEXT_LENGTH = 50_000;
const MAX_RATIONALE_LENGTH = 5_000;
const MAX_METADATA_BYTES = 20_000;
const MAX_PAYLOAD_BYTES = 20_000;
const MAX_SOURCE_IDS = 50;
const PROPOSAL_KINDS = Object.freeze(["tag", "collection", "queue", "browser_action"]);
const RESULT_STATUSES = Object.freeze(["ok", "unsupported", "not_ready", "error", "incomplete"]);
const PROPOSAL_STATES = Object.freeze(["pending", "accepted", "rejected"]);

// Query strings are kept small and simple on purpose: a handful of scalar
// filters/identifiers, never a structure deep enough to need its own
// recursive bound.
const MAX_QUERY_ENTRIES = 16;
const MAX_URL_BYTES = 8_000;

export class BrowserTabsAgentClientError extends Error {
  constructor(message, { status, code, detail } = {}) {
    super(message);
    this.name = "BrowserTabsAgentClientError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function assertFiniteInteger(value, name, { min, max } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`${name} must be a finite integer`);
  }
  if (min !== undefined && value < min) throw new TypeError(`${name} must be >= ${min}`);
  if (max !== undefined && value > max) throw new TypeError(`${name} must be <= ${max}`);
  return value;
}

function assertOptionalFiniteInteger(value, name, opts) {
  if (value === undefined) return undefined;
  return assertFiniteInteger(value, name, opts);
}

function assertNonEmptyString(value, name, { maxLength } = {}) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  if (maxLength !== undefined && value.length > maxLength) throw new TypeError(`${name} must be at most ${maxLength} characters`);
  return value;
}

function assertOptionalNonEmptyString(value, name, opts) {
  if (value === undefined) return undefined;
  return assertNonEmptyString(value, name, opts);
}

function assertOptionalEnum(value, allowed, name) {
  if (value === undefined) return undefined;
  if (!allowed.includes(value)) throw new TypeError(`${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

// Strict: only an actual plain object (`{}`-literal shape — `Object.create`'s
// prototype is either `Object.prototype` or `null`) is accepted. Rejects
// arrays, `null`, class instances (`Date`, `Map`, a custom class, ...), and
// anything else that merely happens to satisfy `typeof value === "object"`.
function assertPlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError(`${name} must be a plain object, not a class instance`);
  }
}

function assertJsonSerializable(value, name, { maxBytes }) {
  assertPlainObject(value, name);
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${name} must be JSON-serializable (${error instanceof Error ? error.message : String(error)})`);
  }
  if (Buffer.byteLength(serialized) > maxBytes) {
    throw new TypeError(`${name} must serialize to at most ${maxBytes} bytes`);
  }
}

function assertIdArray(value, name, { maxLength = MAX_SOURCE_IDS } = {}) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  if (value.length > maxLength) throw new TypeError(`${name} must contain at most ${maxLength} entries`);
  for (const entry of value) assertFiniteInteger(entry, `${name}[]`, { min: 1, max: MAX_RECORD_ID });
  return value;
}

function assertOptionalIdArray(value, name, opts) {
  if (value === undefined) return undefined;
  return assertIdArray(value, name, opts);
}

// Exactly `http://127.0.0.1:<1-65535>/` — no userinfo, no path beyond the
// root, no query, no hash, no other scheme or host. This client only ever
// talks to a local, loopback-bound instance of this project's own service
// (project.md's trust model); accepting anything looser here would make a
// misconfigured or malicious `baseUrl` a meaningful attack surface (e.g. an
// attacker-controlled redirect target, or a non-loopback host).
function assertStrictLoopbackBaseUrl(candidate) {
  let url;
  try {
    url = new URL(candidate);
  } catch (error) {
    throw new TypeError(`baseUrl must be a valid URL: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (url.protocol !== "http:") throw new TypeError(`baseUrl must use http:, got "${url.protocol}"`);
  if (url.hostname !== "127.0.0.1") throw new TypeError(`baseUrl host must be exactly "127.0.0.1", got "${url.hostname}"`);
  if (url.username !== "" || url.password !== "") throw new TypeError("baseUrl must not include userinfo (username/password)");
  if (url.port === "") throw new TypeError("baseUrl must include an explicit port");
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError(`baseUrl port must be between 1 and 65535, got "${url.port}"`);
  if (url.pathname !== "/") throw new TypeError(`baseUrl must have the root path "/", got "${url.pathname}"`);
  if (url.search !== "") throw new TypeError("baseUrl must not include a query string");
  if (url.hash !== "") throw new TypeError("baseUrl must not include a fragment");
  return url;
}

async function readBoundedText(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new BrowserTabsAgentClientError(`response exceeded the maximum allowed size of ${maxBytes} bytes`, { status: response.status });
    }
    return text;
  }
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BrowserTabsAgentClientError(`response exceeded the maximum allowed size of ${maxBytes} bytes`, { status: response.status });
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

// Reads at most `maxBytes + 1` bytes of `path` via explicit open/stat/read
// calls — never `readFile`'s "load the whole file" behavior — so an
// oversized (or, via a race, unexpectedly-grown) file is detected and
// rejected without ever buffering more than one byte past the limit.
// `stat` is consulted first as a fast-path rejection, but the actual read
// is still capped independently: a non-regular file (FIFO, device, a file
// that grows between `stat` and `read`) cannot bypass the bound merely by
// misreporting its size.
async function readFileBounded(path, maxBytes) {
  const handle = await open(path, "r");
  try {
    let statSize;
    try {
      statSize = (await handle.stat()).size;
    } catch {
      statSize = undefined;
    }
    if (statSize !== undefined && statSize > maxBytes) {
      throw new Error(`file exceeds the maximum allowed size of ${maxBytes} bytes (reports ${statSize} bytes): ${path}`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) {
      throw new Error(`file exceeds the maximum allowed size of ${maxBytes} bytes: ${path}`);
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

// Reads the service's external-agent credential from the environment or a
// credential file — never from a command-line argument (which can leak
// into shell history or a process listing) and never logged by this
// function or any caller that uses it correctly. `BROWSER_TABS_AGENT_TOKEN`
// takes precedence; otherwise the file at
// `BROWSER_TABS_AGENT_CREDENTIAL_FILE`, or `~/.browser-tabs/agent-token`
// (the same default path the service itself writes — see
// service/credential.mjs's getAgentCredentialPath — read here
// independently, not imported, so this client has no dependency on this
// repository's own source tree). This is deliberately **not** the owner
// credential (`credential`/`BROWSER_TABS_TOKEN`): there is no function in
// this module that reads the owner credential, by design.
export async function loadAgentCredential({
  tokenEnv = "BROWSER_TABS_AGENT_TOKEN",
  credentialFileEnv = "BROWSER_TABS_AGENT_CREDENTIAL_FILE",
  defaultCredentialFile = join(homedir(), ".browser-tabs", "agent-token"),
  env = process.env,
  maxFileBytes = DEFAULT_MAX_CREDENTIAL_FILE_BYTES,
} = {}) {
  const fromEnv = env[tokenEnv];
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  const credentialPath = env[credentialFileEnv] || defaultCredentialFile;
  let raw;
  try {
    raw = await readFileBounded(credentialPath, maxFileBytes);
  } catch (error) {
    throw new Error(
      `no external-agent credential available: set ${tokenEnv}, or ${credentialFileEnv} to a readable credential file ` +
        `(tried "${credentialPath}"). Underlying error: ${error instanceof Error ? (error.code ?? error.message) : String(error)}`,
    );
  }
  const token = raw.trim();
  if (!token) throw new Error(`credential file "${credentialPath}" is empty`);
  return token;
}

// name -> HTTP verb. This *is* the method allowlist: `#request` refuses
// anything not listed here before building a single byte of the request,
// and every public method on this class corresponds to exactly one entry.
// Mirrors (and must never exceed) the service's own AGENT_ALLOWED_* sets
// in service/server.mjs — this is the client-side half of that same
// allowlist, kept in sync by hand since this client has no import of the
// service's internals to check against automatically.
const METHOD_HTTP_VERBS = new Map([
  ["browser.list_windows", "GET"],
  ["browser.list_tabs", "GET"],
  ["browser.list_tab_groups", "GET"],
  ["browser.read_tab", "GET"],
  ["browser.query_history", "GET"],
  ["browser.get_capabilities", "GET"],
  ["workflow.capture_tab", "POST"],
  ["store.captures.list", "GET"],
  ["store.captures.read", "GET"],
  ["store.summaries.create", "POST"],
  ["store.summaries.list", "GET"],
  ["store.proposals.create", "POST"],
  ["store.proposals.list", "GET"],
]);

export class BrowserTabsAgentClient {
  #baseUrl;
  #token;
  #protocolVersion;
  #fetchImpl;
  #maxResponseBytes;
  #maxRequestBodyBytes;

  constructor({
    baseUrl = DEFAULT_BASE_URL,
    token,
    protocolVersion = DEFAULT_PROTOCOL_VERSION,
    fetchImpl = globalThis.fetch,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
  } = {}) {
    if (typeof token !== "string" || token.length === 0) {
      throw new TypeError("token is required (see loadAgentCredential) and must never be a hard-coded literal in caller source");
    }
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetchImpl must be a function (this runtime has no global fetch; pass one explicitly)");
    }
    this.#baseUrl = assertStrictLoopbackBaseUrl(baseUrl);
    this.#token = token;
    this.#protocolVersion = protocolVersion;
    this.#fetchImpl = fetchImpl;
    this.#maxResponseBytes = maxResponseBytes;
    this.#maxRequestBodyBytes = maxRequestBodyBytes;
  }

  // Private transport: every public method below is a thin, individually
  // validated wrapper over this. There is no public equivalent — a caller
  // of this class cannot reach an arbitrary method name, only the ones
  // named as methods on this class, each of which calls this with a fixed,
  // literal first argument.
  async #request(method, { query, body } = {}) {
    if (!METHOD_HTTP_VERBS.has(method)) {
      // Defense in depth: every call site below passes a literal method
      // name already present in METHOD_HTTP_VERBS, so this should be
      // unreachable; it exists so a future internal mistake fails loudly
      // rather than silently reaching an unintended route.
      throw new TypeError(`method not in this client's allowlist: ${method}`);
    }
    const httpMethod = METHOD_HTTP_VERBS.get(method);

    const url = new URL(`/api/${method}`, this.#baseUrl);
    if (query !== undefined) {
      assertPlainObject(query, "query");
      let entryCount = 0;
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) continue;
        entryCount += 1;
        if (entryCount > MAX_QUERY_ENTRIES) throw new TypeError(`query has more than ${MAX_QUERY_ENTRIES} entries`);
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
          throw new TypeError(`query.${key} must be a string, number, boolean, or undefined`);
        }
        url.searchParams.set(key, String(value));
      }
    }
    if (Buffer.byteLength(url.toString()) > MAX_URL_BYTES) {
      throw new TypeError(`request URL exceeds the maximum allowed size of ${MAX_URL_BYTES} bytes`);
    }

    const requestId = randomUUID();
    const headers = {
      authorization: `Bearer ${this.#token}`,
      "x-protocol-version": String(this.#protocolVersion),
      "x-request-id": requestId,
    };

    let payload;
    if (body !== undefined) {
      if (httpMethod !== "POST" && httpMethod !== "PATCH") {
        throw new TypeError(`body is only valid with httpMethod POST or PATCH, not ${httpMethod}`);
      }
      assertPlainObject(body, "body");
      payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > this.#maxRequestBodyBytes) {
        throw new TypeError(`body exceeds the maximum allowed request size of ${this.#maxRequestBodyBytes} bytes`);
      }
      headers["content-type"] = "application/json";
    }

    // `redirect: "error"` so a redirect response (e.g. from a misbehaving
    // or compromised proxy sitting between this client and the loopback
    // service) is surfaced as a thrown error, never silently followed to a
    // different, uninspected destination carrying this request's
    // Authorization header.
    const response = await this.#fetchImpl(url, { method: httpMethod, headers, body: payload, redirect: "error" });
    const text = await readBoundedText(response, this.#maxResponseBytes);

    let parsed;
    try {
      parsed = text.length === 0 ? {} : JSON.parse(text);
    } catch (error) {
      throw new BrowserTabsAgentClientError(`response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`, {
        status: response.status,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new BrowserTabsAgentClientError("response was not a JSON object", { status: response.status });
    }
    if (parsed.protocolVersion !== this.#protocolVersion) {
      throw new BrowserTabsAgentClientError(
        `response protocolVersion mismatch (expected ${this.#protocolVersion}, got ${JSON.stringify(parsed.protocolVersion)})`,
        { status: response.status },
      );
    }
    // Every named-method response carries exactly one of `result`/`error`
    // (project.md's protocol rules) — never both, never neither.
    const hasResult = Object.hasOwn(parsed, "result");
    const hasError = Object.hasOwn(parsed, "error");
    if (hasResult === hasError) {
      throw new BrowserTabsAgentClientError("response must contain exactly one of result or error", { status: response.status });
    }
    // The service always echoes the request id it was sent for a
    // named-method request (project.md's protocol rules). Required, not
    // merely checked if present: a response that omits `requestId`
    // altogether is exactly as unreliably correlated with this request as
    // one with the wrong value, so both are rejected the same way.
    if (parsed.requestId !== requestId) {
      throw new BrowserTabsAgentClientError(
        `response requestId mismatch (sent ${JSON.stringify(requestId)}, got ${JSON.stringify(parsed.requestId)})`,
        { status: response.status },
      );
    }

    if (hasError) {
      const err = parsed.error;
      if (err === null || typeof err !== "object" || Array.isArray(err) || typeof err.code !== "string" || err.code.length === 0) {
        throw new BrowserTabsAgentClientError("error envelope missing a stable string code", { status: response.status });
      }
      throw new BrowserTabsAgentClientError(typeof err.detail === "string" ? err.detail : err.code, {
        status: response.status,
        code: err.code,
        detail: typeof err.detail === "string" ? err.detail : undefined,
      });
    }
    if (!response.ok) {
      throw new BrowserTabsAgentClientError(`response had a result but a non-success HTTP status ${response.status}`, { status: response.status });
    }
    return parsed.result;
  }

  // ---- listing sources (browser.* read routes; see README.md's
  // "Stage 2: the read API") ----

  listWindows() {
    return this.#request("browser.list_windows");
  }

  listTabs({ windowId, browserSessionId } = {}) {
    assertOptionalFiniteInteger(windowId, "windowId", { min: 0, max: MAX_HANDLE });
    assertOptionalNonEmptyString(browserSessionId, "browserSessionId", { maxLength: MAX_SESSION_ID_LENGTH });
    return this.#request("browser.list_tabs", { query: { windowId, browserSessionId } });
  }

  listTabGroups({ windowId, browserSessionId } = {}) {
    assertOptionalFiniteInteger(windowId, "windowId", { min: 0, max: MAX_HANDLE });
    assertOptionalNonEmptyString(browserSessionId, "browserSessionId", { maxLength: MAX_SESSION_ID_LENGTH });
    return this.#request("browser.list_tab_groups", { query: { windowId, browserSessionId } });
  }

  queryHistory({ startTime, endTime, maxResults, cursor } = {}) {
    assertOptionalFiniteInteger(startTime, "startTime", { min: 0 });
    assertOptionalFiniteInteger(endTime, "endTime", { min: 0 });
    assertOptionalFiniteInteger(maxResults, "maxResults", { min: 1, max: MAX_HISTORY_RESULTS });
    assertOptionalFiniteInteger(cursor, "cursor", { min: 0 });
    return this.#request("browser.query_history", { query: { startTime, endTime, maxResults, cursor } });
  }

  getCapabilities() {
    return this.#request("browser.get_capabilities");
  }

  // Reads one bounded, capture-provenance-wrapped page-text snapshot. This
  // is untrusted browser content — see this module's header comment — and
  // is not persisted by this call; use captureTab to persist evidence.
  readTab({ tabId, browserSessionId } = {}) {
    assertOptionalFiniteInteger(tabId, "tabId", { min: 0, max: MAX_HANDLE });
    assertOptionalNonEmptyString(browserSessionId, "browserSessionId", { maxLength: MAX_SESSION_ID_LENGTH });
    return this.#request("browser.read_tab", { query: { tabId, browserSessionId } });
  }

  // ---- the one capture-creation path exposed to this client ----

  // Calls the server-side `workflow.capture_tab` operation: the service
  // performs the real `browser.read_tab` round trip itself and persists
  // exactly that result — this method never submits a capture body, and
  // there is no method on this client that does (store.captures.create is
  // owner-only and is not exposed here). Returns the same bounded capture
  // projection store.captures.create would (no raw `text`; see readCapture
  // to page through it afterward).
  captureTab({ tabId, browserSessionId } = {}) {
    assertFiniteInteger(tabId, "tabId", { min: 0, max: MAX_HANDLE });
    assertNonEmptyString(browserSessionId, "browserSessionId", { maxLength: MAX_SESSION_ID_LENGTH });
    return this.#request("workflow.capture_tab", { query: { tabId, browserSessionId } });
  }

  listCaptures({ id, windowId, tabId, status, limit, offset } = {}) {
    assertOptionalFiniteInteger(id, "id", { min: 1, max: MAX_RECORD_ID });
    assertOptionalFiniteInteger(windowId, "windowId", { min: 0, max: MAX_HANDLE });
    assertOptionalFiniteInteger(tabId, "tabId", { min: 0, max: MAX_HANDLE });
    assertOptionalEnum(status, RESULT_STATUSES, "status");
    assertOptionalFiniteInteger(limit, "limit", { min: 1, max: MAX_LIST_LIMIT });
    assertOptionalFiniteInteger(offset, "offset", { min: 0, max: MAX_LIST_OFFSET });
    return this.#request("store.captures.list", { query: { id, windowId, tabId, status, limit, offset } });
  }

  // Returns one bounded slice (`chunk`) of a capture's full text, never the
  // whole thing in one call — see README.md's "Records" section for the
  // offset/maxChars bounds.
  readCapture({ id, offset, maxChars } = {}) {
    assertFiniteInteger(id, "id", { min: 1, max: MAX_RECORD_ID });
    assertOptionalFiniteInteger(offset, "offset", { min: 0, max: MAX_CAPTURE_READ_OFFSET });
    assertOptionalFiniteInteger(maxChars, "maxChars", { min: 1, max: MAX_CAPTURE_READ_CHUNK_CHARS });
    return this.#request("store.captures.read", { query: { id, offset, maxChars } });
  }

  // ---- summaries: writing derived text, with caller-supplied model/prompt
  // metadata preserved verbatim as untrusted, derived provenance (never
  // evaluated by the service — see this module's header comment). No
  // creatorType/creatorName parameter exists here: the service assigns the
  // external-agent identity itself, unconditionally, for every write this
  // client can make. ----

  // `sourceCaptureIds` (at least one) is required by the service itself
  // (service/validation.mjs's validateSummaryCreateInput), not merely by
  // this client. `modelMetadata`, if supplied, is this project's
  // documented place for caller-supplied model/prompt provenance — e.g.
  // `{ model: "...", prompt: "..." }` — stored as an opaque JSON blob and
  // returned unchanged, never parsed or executed.
  createSummary({ text, sourceCaptureIds, modelMetadata } = {}) {
    assertNonEmptyString(text, "text", { maxLength: MAX_SUMMARY_TEXT_LENGTH });
    assertIdArray(sourceCaptureIds, "sourceCaptureIds");
    if (sourceCaptureIds.length === 0) throw new TypeError("sourceCaptureIds must contain at least one entry");
    if (modelMetadata !== undefined) assertJsonSerializable(modelMetadata, "modelMetadata", { maxBytes: MAX_METADATA_BYTES });
    const body = { text, sourceCaptureIds };
    if (modelMetadata !== undefined) body.modelMetadata = modelMetadata;
    return this.#request("store.summaries.create", { httpMethod: "POST", body });
  }

  listSummaries({ id, limit, offset } = {}) {
    assertOptionalFiniteInteger(id, "id", { min: 1, max: MAX_RECORD_ID });
    assertOptionalFiniteInteger(limit, "limit", { min: 1, max: MAX_LIST_LIMIT });
    assertOptionalFiniteInteger(offset, "offset", { min: 0, max: MAX_LIST_OFFSET });
    return this.#request("store.summaries.list", { query: { id, limit, offset } });
  }

  // ---- proposals: suggesting — never applying — tags, collections, queue
  // changes, or a future browser action (see this module's header
  // comment). No creatorType/creatorName parameter here either, and no
  // method corresponding to deciding a proposal (store.proposals.update)
  // exists on this client at all: that is owner-only. ----

  // `sourceCaptureIds`/`sourceSummaryIds` (at least one, combined) is
  // required by the service itself (service/validation.mjs's
  // validateProposalCreateInput), not merely by this client. The proposal
  // is always created `"pending"`.
  createProposal({ kind, rationale, payload, sourceCaptureIds, sourceSummaryIds } = {}) {
    assertOptionalEnum(kind, PROPOSAL_KINDS, "kind");
    if (kind === undefined) throw new TypeError("kind is required");
    assertNonEmptyString(rationale, "rationale", { maxLength: MAX_RATIONALE_LENGTH });
    assertJsonSerializable(payload, "payload", { maxBytes: MAX_PAYLOAD_BYTES });
    assertOptionalIdArray(sourceCaptureIds, "sourceCaptureIds");
    assertOptionalIdArray(sourceSummaryIds, "sourceSummaryIds");
    if ((sourceCaptureIds?.length ?? 0) === 0 && (sourceSummaryIds?.length ?? 0) === 0) {
      throw new TypeError("at least one of sourceCaptureIds/sourceSummaryIds is required");
    }
    const body = { kind, rationale, payload };
    if (sourceCaptureIds !== undefined) body.sourceCaptureIds = sourceCaptureIds;
    if (sourceSummaryIds !== undefined) body.sourceSummaryIds = sourceSummaryIds;
    return this.#request("store.proposals.create", { httpMethod: "POST", body });
  }

  listProposals({ id, state, kind, limit, offset } = {}) {
    assertOptionalFiniteInteger(id, "id", { min: 1, max: MAX_RECORD_ID });
    assertOptionalEnum(state, PROPOSAL_STATES, "state");
    assertOptionalEnum(kind, PROPOSAL_KINDS, "kind");
    assertOptionalFiniteInteger(limit, "limit", { min: 1, max: MAX_LIST_LIMIT });
    assertOptionalFiniteInteger(offset, "offset", { min: 0, max: MAX_LIST_OFFSET });
    return this.#request("store.proposals.list", { query: { id, state, kind, limit, offset } });
  }
}
