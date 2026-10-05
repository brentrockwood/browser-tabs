#!/usr/bin/env node
// Stage 4 (remediated): a small reference CLI over
// client/browser-tabs-client.mjs's external-agent-scoped
// BrowserTabsAgentClient. Takes a single JSON document naming one of that
// client's own allowlisted methods — no flag parser, per project
// convention for this script — and prints the decoded result (or a
// structured error) as JSON. There is no generic "call anything" mode:
// `DISPATCH` below is exactly the same method allowlist the client class
// itself exposes, so this script cannot reach anything the client
// couldn't already reach on its own.
//
// Usage:
//   node client/cli.mjs <request.json>
//   node client/cli.mjs -            # read the JSON document from stdin
//   echo '{"method":"browser.list_windows"}' | node client/cli.mjs -
//
// Request document shape:
//   {
//     "method": "store.captures.list",   // required; one of DISPATCH's keys
//     "query": { "limit": 5 },            // optional, for a listing/read method
//     "body": { ... }                     // optional, for a write method
//   }
//
// Environment (credentials and target; never taken from argv, so they
// cannot leak into shell history or a process listing):
//   BROWSER_TABS_URL                     base URL, default http://127.0.0.1:8743
//   BROWSER_TABS_AGENT_TOKEN             the external-agent credential, or:
//   BROWSER_TABS_AGENT_CREDENTIAL_FILE   path to a file containing it,
//                                        default ~/.browser-tabs/agent-token
//   BROWSER_TABS_PROTOCOL_VERSION        default 4
//
// Exit code is 0 on success (result JSON on stdout), 1 on any failure
// (message on stderr). The credential is never printed or logged.
import { open } from "node:fs/promises";

import { BrowserTabsAgentClient, BrowserTabsAgentClientError, DEFAULT_BASE_URL, DEFAULT_PROTOCOL_VERSION, loadAgentCredential } from "./browser-tabs-client.mjs";

const MAX_REQUEST_DOCUMENT_BYTES = 1 * 1024 * 1024;

// Bounded reads for both the file-argument and stdin cases: neither ever
// buffers more than MAX_REQUEST_DOCUMENT_BYTES + 1 bytes before deciding
// the input is too large, regardless of what a `stat` (file case) reports.
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
    if (total > maxBytes) throw new Error(`file exceeds the maximum allowed size of ${maxBytes} bytes: ${path}`);
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readStdinBounded(maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`stdin input exceeds the maximum allowed size of ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readRequestDocument(arg) {
  if (arg === undefined) throw new Error("usage: node client/cli.mjs <request.json>|-");
  const raw = arg === "-" ? await readStdinBounded(MAX_REQUEST_DOCUMENT_BYTES) : await readFileBounded(arg, MAX_REQUEST_DOCUMENT_BYTES);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`request document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request document must be a JSON object");
  }
  if (typeof parsed.method !== "string" || parsed.method.length === 0) {
    throw new Error('request document must include a non-empty string "method"');
  }
  if (parsed.query !== undefined && (typeof parsed.query !== "object" || parsed.query === null || Array.isArray(parsed.query))) {
    throw new Error('"query", if present, must be a JSON object');
  }
  if (parsed.body !== undefined && (typeof parsed.body !== "object" || parsed.body === null || Array.isArray(parsed.body))) {
    throw new Error('"body", if present, must be a JSON object');
  }
  return parsed;
}

// name -> how to call the one corresponding BrowserTabsAgentClient method.
// Exactly this client class's own public surface — nothing here reaches a
// method the class does not already expose, and nothing exposes a
// generic/arbitrary-method path.
const DISPATCH = {
  "browser.list_windows": (client) => client.listWindows(),
  "browser.list_tabs": (client, req) => client.listTabs(req.query ?? {}),
  "browser.list_tab_groups": (client, req) => client.listTabGroups(req.query ?? {}),
  "browser.query_history": (client, req) => client.queryHistory(req.query ?? {}),
  "browser.get_capabilities": (client) => client.getCapabilities(),
  "browser.read_tab": (client, req) => client.readTab(req.query ?? {}),
  "workflow.capture_tab": (client, req) => client.captureTab(req.query ?? {}),
  "store.captures.list": (client, req) => client.listCaptures(req.query ?? {}),
  "store.captures.read": (client, req) => client.readCapture(req.query ?? {}),
  "store.summaries.create": (client, req) => client.createSummary(req.body ?? {}),
  "store.summaries.list": (client, req) => client.listSummaries(req.query ?? {}),
  "store.proposals.create": (client, req) => client.createProposal(req.body ?? {}),
  "store.proposals.list": (client, req) => client.listProposals(req.query ?? {}),
};

async function main() {
  const request = await readRequestDocument(process.argv[2]);
  if (!Object.hasOwn(DISPATCH, request.method)) {
    throw new Error(`unknown or unsupported method for this client: ${request.method}. Supported: ${Object.keys(DISPATCH).join(", ")}`);
  }

  const token = await loadAgentCredential();
  const client = new BrowserTabsAgentClient({
    baseUrl: process.env.BROWSER_TABS_URL || DEFAULT_BASE_URL,
    protocolVersion: process.env.BROWSER_TABS_PROTOCOL_VERSION ? Number(process.env.BROWSER_TABS_PROTOCOL_VERSION) : DEFAULT_PROTOCOL_VERSION,
    token,
  });

  const result = await DISPATCH[request.method](client, request);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  if (error instanceof BrowserTabsAgentClientError) {
    process.stderr.write(`${JSON.stringify({ error: { status: error.status, code: error.code, detail: error.detail ?? error.message } }, null, 2)}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
