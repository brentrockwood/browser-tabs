// Stage 5: the local review UI's static-asset routes (service/ui.mjs) and
// the UI source itself. Covers:
//   - exact-route serving, security headers, no-auth/no-protocol-version
//     requirement, unknown-path and path-traversal-attempt handling;
//   - that serving the UI never logs a credential or any request content;
//   - static source checks on ui/index.html and ui/app.js proving there is
//     no innerHTML/outerHTML/document.write/eval usage, no inline
//     script/style, and no inline event-handler attribute anywhere — the
//     properties this project's restrictive CSP and "escape untrusted text"
//     requirement (project.md Stage 5) actually depend on.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { PROTOCOL_VERSION } from "../extension/protocol.js";
import { createService } from "../service/server.mjs";

const TOKEN = "ui-test-owner-token-0123456789";

function httpRequest({ port, path, method = "GET", headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function withService(options, run) {
  const service = createService({ credentialToken: TOKEN, port: 0, host: "127.0.0.1", ...options });
  const address = await service.listen();
  try {
    await run(address.port);
  } finally {
    await service.close().catch(() => {});
  }
}

const UI_ASSET_PATHS = ["/ui/", "/ui/index.html", "/ui/app.js", "/ui/lib.mjs", "/ui/styles.css"];

test("every UI asset route is served with no Authorization header and no X-Protocol-Version header", async () => {
  await withService({}, async (port) => {
    for (const path of UI_ASSET_PATHS) {
      const response = await httpRequest({ port, path });
      assert.equal(response.status, 200, `${path} did not return 200: ${response.body.slice(0, 200)}`);
      assert.ok(response.body.length > 0, `${path} returned an empty body`);
    }
  });
});

test("UI asset routes carry a restrictive CSP and the other required security headers", async () => {
  await withService({}, async (port) => {
    for (const path of UI_ASSET_PATHS) {
      const response = await httpRequest({ port, path });
      const csp = response.headers["content-security-policy"];
      assert.ok(csp, `${path} missing Content-Security-Policy`);
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /style-src 'self'/);
      assert.match(csp, /connect-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline/);
      assert.doesNotMatch(csp, /unsafe-eval/);

      assert.equal(response.headers["x-content-type-options"], "nosniff", `${path} missing X-Content-Type-Options`);
      assert.equal(response.headers["referrer-policy"], "no-referrer", `${path} missing Referrer-Policy`);
      assert.equal(response.headers["x-frame-options"], "DENY", `${path} missing X-Frame-Options`);
      assert.equal(response.headers["cache-control"], "no-store", `${path} missing Cache-Control: no-store`);
    }
  });
});

test("UI asset routes report the correct content type", async () => {
  await withService({}, async (port) => {
    const html = await httpRequest({ port, path: "/ui/" });
    assert.match(html.headers["content-type"], /text\/html/);
    const js = await httpRequest({ port, path: "/ui/app.js" });
    assert.match(js.headers["content-type"], /javascript/);
    const lib = await httpRequest({ port, path: "/ui/lib.mjs" });
    assert.match(lib.headers["content-type"], /javascript/);
    const css = await httpRequest({ port, path: "/ui/styles.css" });
    assert.match(css.headers["content-type"], /text\/css/);
  });
});

test("/ui/ and /ui/index.html serve the identical page", async () => {
  await withService({}, async (port) => {
    const root = await httpRequest({ port, path: "/ui/" });
    const indexHtml = await httpRequest({ port, path: "/ui/index.html" });
    assert.equal(root.body, indexHtml.body);
  });
});

test("an unknown path under /ui/ is a plain 404 not_found, never the raw service source", async () => {
  await withService({}, async (port) => {
    for (const path of ["/ui/nope.html", "/ui/app.js.map", "/ui", "/ui/../server.mjs", "/ui/%2e%2e/server.mjs", "/ui/%2e%2e%2fserver.mjs"]) {
      const response = await httpRequest({ port, path, headers: { "x-protocol-version": String(PROTOCOL_VERSION) } });
      assert.equal(response.status, 404, `${path} did not 404: ${response.status} ${response.body}`);
      const json = JSON.parse(response.body);
      assert.equal(json.error.code, "not_found");
      assert.doesNotMatch(response.body, /createService|require\(|import /, `${path} leaked service source: ${response.body.slice(0, 300)}`);
    }
  });
});

test("a POST to a UI asset path is not served as a UI asset (falls through to ordinary 404 routing)", async () => {
  await withService({}, async (port) => {
    const response = await httpRequest({ port, path: "/ui/", method: "POST", headers: { "x-protocol-version": String(PROTOCOL_VERSION) } });
    assert.equal(response.status, 404);
  });
});

test("serving UI assets never passes a credential or request content to the log callback", async () => {
  const logLines = [];
  await withService({ log: (message) => logLines.push(message) }, async (port) => {
    for (const path of UI_ASSET_PATHS) {
      await httpRequest({ port, path, headers: { authorization: `Bearer ${TOKEN}`, cookie: "should-not-be-logged=1" } });
    }
    for (const line of logLines) {
      assert.doesNotMatch(String(line), new RegExp(TOKEN), `log line leaked the credential: ${line}`);
    }
  });
});

// ---- static source checks ----

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));
const indexHtmlSource = readFileSync(UI_DIR + "index.html", "utf8");
const appJsSource = readFileSync(UI_DIR + "app.js", "utf8");
const libMjsSource = readFileSync(UI_DIR + "lib.mjs", "utf8");
const stylesCssSource = readFileSync(UI_DIR + "styles.css", "utf8");

test("ui/app.js never assigns innerHTML/outerHTML and never uses document.write or eval", () => {
  assert.doesNotMatch(appJsSource, /\.innerHTML/, "app.js must never use innerHTML — use textContent/DOM builders instead");
  assert.doesNotMatch(appJsSource, /\.outerHTML/, "app.js must never use outerHTML");
  assert.doesNotMatch(appJsSource, /document\.write/, "app.js must never use document.write");
  assert.doesNotMatch(appJsSource, /\beval\s*\(/, "app.js must never use eval");
  assert.doesNotMatch(appJsSource, /new Function\s*\(/, "app.js must never construct a Function from a string");
});

test("ui/lib.mjs is pure DOM-free logic: no document/window/fetch/HTML-building usage at all", () => {
  // The whole point of factoring these race-prevention primitives out of
  // app.js (Stage 5 remediation) is that they are deterministically unit
  // testable in plain Node (test/ui-lib.test.mjs) with no DOM — this locks
  // that property in so a future change cannot quietly reintroduce a DOM
  // dependency here without the source check itself failing.
  assert.doesNotMatch(libMjsSource, /\bdocument\./, "lib.mjs must stay DOM-free");
  assert.doesNotMatch(libMjsSource, /\bwindow\./, "lib.mjs must stay DOM-free");
  assert.doesNotMatch(libMjsSource, /\bfetch\s*\(/, "lib.mjs must not perform network requests");
  assert.doesNotMatch(libMjsSource, /\.innerHTML|\.outerHTML/, "lib.mjs must never touch innerHTML/outerHTML");
});

test("ui/app.js sets browser/content-derived fields via textContent, never by building HTML strings", () => {
  // Every render function that touches a browser- or derived-record-owned
  // string field (title, url, text, rationale, name, ...) must go through
  // this file's own `el()`/`textContent` helpers, never string
  // concatenation assigned into markup. This is a coarse but meaningful
  // proxy: the file must use `textContent` (it does, extensively) and must
  // never contain a template literal that both interpolates a variable and
  // is assigned to innerHTML — already checked above by the innerHTML scan.
  assert.match(appJsSource, /\.textContent/, "expected textContent to be used for rendering");
});

test("ui/index.html has no inline <script> content, no inline event-handler attributes, and no inline styles", () => {
  const scriptTags = [...indexHtmlSource.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.equal(scriptTags.length, 1, "expected exactly one <script> tag");
  assert.match(scriptTags[0][0], /src="\/ui\/app\.js"/, "the one <script> tag must load the external app.js, not inline code");
  assert.equal(scriptTags[0][1].trim(), "", "the <script> tag must have no inline body");

  assert.doesNotMatch(indexHtmlSource, /\son[a-z]+\s*=/i, "no inline event-handler attribute (onclick=, onload=, ...) is allowed");
  assert.doesNotMatch(indexHtmlSource, /\sstyle\s*=/i, "no inline style attribute is allowed");
  assert.doesNotMatch(indexHtmlSource, /<style\b/i, "no inline <style> block is allowed; styles.css is loaded externally");
  assert.doesNotMatch(indexHtmlSource, /javascript:/i, "no javascript: URI is allowed");
});

test("ui/index.html loads styles.css only via an external <link>, matching the CSP's style-src 'self'", () => {
  assert.match(indexHtmlSource, /<link rel="stylesheet" href="\/ui\/styles\.css">/);
});

test("ui/styles.css parses as plain CSS text (sanity check that it is not accidentally HTML/script)", () => {
  assert.doesNotMatch(stylesCssSource, /<script/i);
  assert.doesNotMatch(stylesCssSource, /<\/html>/i);
});

test("ui/app.js sends the same protocol version the service requires", () => {
  // The page duplicates the constant (it has no build step and cannot import
  // extension/protocol.js), so a protocol bump must reach it too: a stale
  // value would make every authenticated call fail with
  // unsupported_protocol_version.
  const match = /^const PROTOCOL_VERSION = (\d+);$/m.exec(appJsSource);
  assert.ok(match, "expected a literal `const PROTOCOL_VERSION = <n>;` in ui/app.js");
  assert.equal(Number(match[1]), PROTOCOL_VERSION);
});

// ---- Phase 2 Action 1: the open-a-URL-in-a-new-tab section ----

test("ui/index.html's actions section has a labelled address field, a Preview button, and no inline script/style/handler", () => {
  assert.match(indexHtmlSource, /<section id="actions-section" aria-labelledby="actions-heading">/);
  assert.match(indexHtmlSource, /<label for="action-url-input">/);
  assert.match(indexHtmlSource, /<input type="text" id="action-url-input"[^>]*maxlength="2048"[^>]*aria-describedby="action-url-help"/);
  assert.match(indexHtmlSource, /<p id="action-url-help">/);
  assert.match(indexHtmlSource, /<button type="submit" id="preview-button" disabled>Preview<\/button>/);
  // Open and Reject exist only on rendered previews (see app.js), never as
  // static buttons that could act without a stored preview.
  assert.doesNotMatch(indexHtmlSource, /id="open-button"|id="approve-button"|id="reject-button"/);
  // Status text is announced politely.
  for (const id of ["action-form-status", "action-decision-status", "actions-status", "audit-status"]) {
    assert.match(indexHtmlSource, new RegExp(`id="${id}" role="status" aria-live="polite"`));
  }
});

test("ui/app.js decides an action by id alone: no body and no address on approve/reject, and the address only ever goes to preview", () => {
  const approveRejectCalls = [...appJsSource.matchAll(/apiRequest\(`\/api\/action\.open_tab\.\$\{operation\}\?id=\$\{id\}`[^)]*\)/g)];
  assert.equal(approveRejectCalls.length, 1, "exactly one call site decides an action");
  assert.doesNotMatch(approveRejectCalls[0][0], /body/, "the decision request must carry no body");
  assert.match(appJsSource, /apiRequest\("\/api\/action\.open_tab\.preview", \{ method: "POST", body: \{ url \} \}\)/);
  assert.equal([...appJsSource.matchAll(/action\.open_tab\./g)].length, 2, "only the preview and the id-only decision route are referenced");
  assert.doesNotMatch(appJsSource, /browser\.open_tab/, "the page never names the extension-level method");
});

test("ui/app.js renders an action's address and observed text as text only, never as a link or navigation", () => {
  const section = appJsSource.slice(appJsSource.indexOf("// ---- browser actions"), appJsSource.indexOf("// ---- tags ----"));
  assert.ok(section.length > 500, "expected to locate the actions section of app.js");
  assert.doesNotMatch(section, /createElement\(\s*["']a["']/, "no anchor elements");
  assert.doesNotMatch(section, /\bel\(\s*["']a["']/, "no anchor elements via the el() helper");
  assert.doesNotMatch(section, /\bhref\b|\bsrc\b|window\.open|location\s*=|location\.href|\.navigate/, "the page must never navigate to or open an action's address");
  assert.doesNotMatch(section, /setAttribute\([^)]*\b(?:a\.url|r\.observed|\.title)\b/, "untrusted text is never placed in an attribute");
  assert.match(section, /text: `Address: \$\{a\.url\}`/);
});

test("ui/app.js guards action decisions against double submits and stale list refreshes, and keeps them accessible", () => {
  assert.match(appJsSource, /const actionDecisions = createDecisionTracker\(\)/);
  assert.match(appJsSource, /const actionsListGuard = createListVersionGuard\(\)/);
  assert.match(appJsSource, /if \(!actionDecisions\.begin\(id\)\) return;/, "a second click while submitting is ignored");
  assert.match(appJsSource, /actionsListGuard\.apply\(token\)/, "an older list response never overwrites a newer one");
  assert.match(appJsSource, /actionDecisions\.isSubmitting\(a\.id\)/, "a row rebuilt mid-decision comes back disabled");
  // Every Open/Reject button names the address it acts on, via aria-describedby
  // pointing at the row's own address paragraph (never untrusted text in an attribute).
  assert.match(appJsSource, /"aria-describedby": urlId/);
  assert.match(appJsSource, /attrs: \{ id: urlId \}/);
  // The new controls are disabled until the owner token is accepted.
  for (const id of ["preview-button", "refresh-actions-button", "refresh-audit-button"]) {
    assert.match(appJsSource, new RegExp(`"${id}"`));
  }
});

// ---- Phase 2 Action 2: the tab-group form ----

test("ui/index.html's tab-group form has labelled fields, a select of exactly the native colors, and a Preview button disabled until connected", () => {
  assert.match(indexHtmlSource, /<form id="group-form">/);
  assert.match(indexHtmlSource, /<label for="group-title-input">/);
  assert.match(indexHtmlSource, /<input type="text" id="group-title-input"[^>]*maxlength="100"[^>]*aria-describedby="group-title-help"/);
  assert.match(indexHtmlSource, /<label for="group-clear-title">/);
  assert.match(indexHtmlSource, /<label for="group-color-select">/);
  const select = /<select id="group-color-select"[\s\S]*?<\/select>/.exec(indexHtmlSource)[0];
  const colors = [...select.matchAll(/<option value="([a-z]+)">/g)].map((m) => m[1]);
  assert.deepEqual(colors, ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
  assert.match(indexHtmlSource, /<button type="submit" id="group-preview-button" disabled>Preview group change<\/button>/);
  assert.match(indexHtmlSource, /id="group-form-status" role="status" aria-live="polite"/);
  // Apply and Reject exist only on rendered previews, never as static buttons.
  assert.doesNotMatch(indexHtmlSource, /id="apply-button"|id="group-apply-button"/);
  assert.match(appJsSource, /"group-preview-button"/);
});

test("ui/app.js sends a group preview with only the chosen operation, one handle, and the requested change, and decides by id alone", () => {
  assert.match(appJsSource, /apiRequest\("\/api\/action\.configure_group\.preview", \{ method: "POST", body \}\)/);
  const decisions = [...appJsSource.matchAll(/apiRequest\(`\/api\/action\.configure_group\.\$\{operation\}\?id=\$\{id\}`[^)]*\)/g)];
  assert.equal(decisions.length, 1, "exactly one call site decides a group action");
  assert.doesNotMatch(decisions[0][0], /body/);
  assert.equal([...appJsSource.matchAll(/action\.configure_group\./g)].length, 2, "only the preview and the id-only decision route are referenced");
  assert.doesNotMatch(appJsSource, /browser\.configure_group|browser\.inspect_group_target/, "the page never names the extension-level methods");
  // The target is only ever { operation, tabId } or { operation, groupId }: no session, no window.
  assert.match(appJsSource, /chooseGroupTarget\(\{ operation: "create", tabId: t\.tabId \}/);
  assert.match(appJsSource, /chooseGroupTarget\(\{ operation: "update", groupId: g\.groupId \}/);
  const form = appJsSource.slice(appJsSource.indexOf("// ---- tab groups: create around one tab"), appJsSource.indexOf("// ---- tags ----"));
  assert.ok(form.length > 500, "expected to locate the tab-group form section of app.js");
  assert.doesNotMatch(form, /sessionId|browserSessionId|windowId/, "the form never supplies a session or a window");
});

// ---- Phase 2 Action 3: the move-tabs form ----

test("ui/index.html's move form has labelled fields, its own native-color select, live status text, and a Preview button disabled until connected", () => {
  assert.match(indexHtmlSource, /<form id="move-form">/);
  assert.match(indexHtmlSource, /<label for="move-title-input">/);
  assert.match(indexHtmlSource, /<input type="text" id="move-title-input"[^>]*maxlength="100"[^>]*aria-describedby="move-title-help"/);
  assert.match(indexHtmlSource, /<label for="move-color-select">/);
  const select = /<select id="move-color-select"[\s\S]*?<\/select>/.exec(indexHtmlSource)[0];
  assert.deepEqual([...select.matchAll(/<option value="([a-z]+)">/g)].map((m) => m[1]), ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
  assert.match(indexHtmlSource, /<button type="submit" id="move-preview-button" disabled>Preview move<\/button>/);
  assert.match(indexHtmlSource, /id="move-selection" role="status" aria-live="polite"/);
  assert.match(indexHtmlSource, /id="move-form-status" role="status" aria-live="polite"/);
  for (const id of ["move-preview-button", "move-new-button", "move-clear-button"]) assert.match(appJsSource, new RegExp(`"${id}"`));
});

test("ui/app.js sends a move preview with only tab ids and a destination, and decides by id alone", () => {
  assert.match(appJsSource, /apiRequest\("\/api\/action\.move_tabs\.preview", \{ method: "POST", body \}\)/);
  const decisions = [...appJsSource.matchAll(/apiRequest\(`\/api\/action\.move_tabs\.\$\{operation\}\?id=\$\{id\}`[^)]*\)/g)];
  assert.equal(decisions.length, 1, "exactly one call site decides a move action");
  assert.doesNotMatch(decisions[0][0], /body/);
  assert.equal([...appJsSource.matchAll(/action\.move_tabs\./g)].length, 2, "only the preview and the id-only decision route are referenced");
  assert.doesNotMatch(appJsSource, /browser\.move_tabs|browser\.inspect_move_target/, "the page never names the extension-level methods");
  const section = appJsSource.slice(appJsSource.indexOf("// ---- moving tabs into a group"), appJsSource.indexOf("// ---- collections ----"));
  assert.ok(section.length > 500, "expected to locate the move section of app.js");
  assert.doesNotMatch(section, /sessionId|browserSessionId/, "the form never supplies a session");
  assert.match(section, /body = \{ tabIds: \[\.\.\.moveSelection\.keys\(\)\], destination:/);
});

test("ui/app.js bounds and scopes the tab selection, and drops it with every session or list it came from", () => {
  assert.match(appJsSource, /const MAX_MOVE_TABS = 100;/);
  assert.match(appJsSource, /moveSelection\.size >= MAX_MOVE_TABS/, "at most 100 tabs");
  assert.match(appJsSource, /moveSelection\.values\(\)\.next\(\)\.value !== tab\.windowId/, "one window only");
  assert.match(appJsSource, /selectBox\.disabled = Boolean\(t\.pinned\)/, "a pinned tab cannot be ticked");
  // Dropped on: Disconnect (resetDisplayedData), stale or replaced session, and a fresh window load.
  const reset = appJsSource.slice(appJsSource.indexOf("function resetDisplayedData"), appJsSource.indexOf('qs("auth-form")'));
  assert.match(reset, /clearMoveSelection\(\)/);
  const stale = appJsSource.slice(appJsSource.indexOf("function handleStaleBrowserSession"), appJsSource.indexOf("// ---- connection status"));
  assert.match(stale, /clearMoveSelection\(\)/);
  const remember = appJsSource.slice(appJsSource.indexOf("function rememberSessionFromWindowsResult"), appJsSource.indexOf("// True if `result` is the server's explicit"));
  assert.match(remember, /clearMoveSelection\(\)/);
  const load = appJsSource.slice(appJsSource.indexOf('qs("load-windows-button").addEventListener'));
  assert.ok(load.indexOf("clearMoveSelection()") > 0 && load.indexOf("clearMoveSelection()") < load.indexOf("renderWindowRow(w)"), "cleared before the new rows render");
});

test("ui/app.js renders a move preview's tab text as text only, with each tab's current group visible", () => {
  const section = appJsSource.slice(appJsSource.indexOf("// ---- browser actions"), appJsSource.indexOf("// ---- tags ----"));
  assert.match(section, /text: describeMoveBinding\(a\.binding\)/);
  assert.match(section, /text: describeMoveTab\(tab\)/);
  assert.match(section, /currently \$\{membership\}/);
  assert.match(section, /a group left with no tabs is removed by the browser itself/);
  assert.doesNotMatch(section, /\bhref\b|\bsrc\b|window\.open|\.innerHTML/);
  // A stored move holds no tab title or address, so none is ever shown for one.
  const describeTab = /function describeMoveTab\(t\) \{[\s\S]*?\n\}/.exec(appJsSource)[0];
  assert.doesNotMatch(describeTab, /title|url/i);
});

// ---- Phase 2 Action 4: the archive-tab form ----

test("ui/index.html's archive form has a live target line, a Preview button disabled until connected, and live status text, with no static Archive/Reject buttons", () => {
  assert.match(indexHtmlSource, /<form id="archive-form">/);
  assert.match(indexHtmlSource, /id="archive-target" role="status" aria-live="polite"/);
  assert.match(indexHtmlSource, /<button type="submit" id="archive-preview-button" disabled>Preview archive<\/button>/);
  assert.match(indexHtmlSource, /id="archive-form-status" role="status" aria-live="polite"/);
  assert.doesNotMatch(indexHtmlSource, /id="archive-button"|id="archive-approve-button"|id="archive-reject-button"/);
  assert.match(appJsSource, /"archive-preview-button"/);
  // The page explains the order: capture first, then close; and what a partial/unknown outcome means.
  assert.match(indexHtmlSource, /save a capture of it, then close it/);
  assert.match(indexHtmlSource, /the capture is kept and the tab stays\s+open/);
});

test("ui/app.js sends an archive preview with exactly {tabId}, from the chosen tab's row, and decides by id alone", () => {
  assert.match(appJsSource, /apiRequest\("\/api\/action\.archive_tab\.preview", \{ method: "POST", body: \{ tabId: archiveTarget\.tabId \} \}\)/);
  const decisions = [...appJsSource.matchAll(/apiRequest\(`\/api\/action\.archive_tab\.\$\{operation\}\?id=\$\{id\}`[^)]*\)/g)];
  assert.equal(decisions.length, 1, "exactly one call site decides an archive action");
  assert.doesNotMatch(decisions[0][0], /body/);
  assert.equal([...appJsSource.matchAll(/action\.archive_tab\./g)].length, 2, "only the preview and the id-only decision route are referenced");
  assert.doesNotMatch(appJsSource, /browser\.close_tab|browser\.inspect_archive_target/, "the page never names the extension-level methods");
  assert.match(appJsSource, /chooseArchiveTarget\(t\.tabId, /);
  const section = appJsSource.slice(appJsSource.indexOf("// ---- archiving a tab"), appJsSource.indexOf("// ---- moving tabs into a group"));
  assert.ok(section.length > 500, "expected to locate the archive section of app.js");
  assert.doesNotMatch(section, /sessionId|browserSessionId|windowId|\.url|\.title/, "the form supplies no session, window, address, or title");
});

test("ui/app.js shows the bound title and address as text only, the saved capture apart from the close, and unknown/none/closed wording", () => {
  const section = appJsSource.slice(appJsSource.indexOf("// ---- browser actions"), appJsSource.indexOf("// ---- tags ----"));
  assert.match(section, /text: `Title \(untrusted browser text\): \$\{a\.binding\.title \?\? "\(none\)"\}`/);
  assert.match(section, /text: `Address \(untrusted browser text\): \$\{a\.binding\.url\}`/);
  assert.match(section, /dlEntry\(dl, "Saved capture", archiveCaptureLabel\(r, a\.state\)\)/);
  assert.match(section, /closed: "yes — the tab was closed"/);
  assert.match(section, /none: "no — the tab was not closed"/);
  assert.match(section, /unknown — the tab may or may not have been closed; any capture shown below was saved first/);
  assert.match(section, /partly done — a capture was saved but the tab was deliberately left open/);
  assert.doesNotMatch(section, /\bhref\b|\bsrc\b|window\.open|\.innerHTML/, "the address is never turned into a link");
});

test("an archive result never claims 'none saved' where a capture may have been saved (restart reconciliation), and shows a known id exactly", () => {
  const source = /function archiveCaptureLabel\(r, state\) \{[\s\S]*?\n\}/.exec(appJsSource)[0];
  const archiveCaptureLabel = new Function(`${source}\nreturn archiveCaptureLabel;`)();
  // Known: the exact id, whatever the outcome.
  for (const [state, mutation] of [["executed", "closed"], ["partial", "none"], ["failed", "unknown"]]) {
    assert.equal(archiveCaptureLabel({ captureId: 42, mutation }, state), "capture #42");
  }
  // Failed with an unknown mutation and no id (a crash reconciled on restart): unknown, not "none saved".
  assert.match(archiveCaptureLabel({ captureId: null, mutation: "unknown" }, "failed"), /^unknown — a capture may have been saved/);
  assert.doesNotMatch(archiveCaptureLabel({ captureId: null, mutation: "unknown" }, "failed"), /none saved/);
  // Certainly nothing saved: stale, failed before the capture, and a missing/undefined id.
  assert.equal(archiveCaptureLabel({ captureId: null, mutation: "none" }, "stale"), "none saved");
  assert.equal(archiveCaptureLabel({ captureId: null, mutation: "none" }, "failed"), "none saved");
  assert.equal(archiveCaptureLabel({ mutation: "none" }, "failed"), "none saved");
  assert.equal(archiveCaptureLabel({ captureId: null, mutation: "none" }, "rejected"), "none saved");
  // The archive result display goes through it, with no other literal claim.
  const section = appJsSource.slice(appJsSource.indexOf("// ---- browser actions"), appJsSource.indexOf("// ---- tags ----"));
  assert.equal([...section.matchAll(/"none saved"/g)].length, 1, "'none saved' appears only inside archiveCaptureLabel");
});

test("ui/app.js drops the chosen archive target on disconnect, a stale or replaced session, and a fresh Load windows or Load tabs", () => {
  const reset = appJsSource.slice(appJsSource.indexOf("function resetDisplayedData"), appJsSource.indexOf('qs("auth-form")'));
  assert.match(reset, /clearArchiveTarget\(\)/);
  const stale = appJsSource.slice(appJsSource.indexOf("function handleStaleBrowserSession"), appJsSource.indexOf("// ---- connection status"));
  assert.match(stale, /clearArchiveTarget\(\)/);
  const remember = appJsSource.slice(appJsSource.indexOf("function rememberSessionFromWindowsResult"), appJsSource.indexOf("// True if `result` is the server's explicit"));
  assert.match(remember, /clearArchiveTarget\(\)/);
  const load = appJsSource.slice(appJsSource.indexOf('qs("load-windows-button").addEventListener'));
  assert.ok(load.indexOf("clearArchiveTarget()") > 0 && load.indexOf("clearArchiveTarget()") < load.indexOf("renderWindowRow(w)"), "cleared before the new rows render");
  const tabsHandler = appJsSource.slice(appJsSource.indexOf("loadTabsButton.addEventListener"), appJsSource.indexOf("const loadGroupsButton"));
  assert.ok(tabsHandler.indexOf("clearArchiveTarget()") > 0 && tabsHandler.indexOf("clearArchiveTarget()") < tabsHandler.indexOf("apiRequest("), "and before a tab list is replaced");
  const groupsHandler = appJsSource.slice(appJsSource.indexOf("loadGroupsButton.addEventListener"), appJsSource.indexOf("return el(\"li\", {}, [renderWindowInfo(w)"));
  assert.doesNotMatch(groupsHandler, /clearArchiveTarget/, "loading groups replaces no tab row");
});

test("ui/app.js distinguishes a known move from which tabs were observed, and an unknown effect from none", () => {
  const section = appJsSource.slice(appJsSource.indexOf("// ---- browser actions"), appJsSource.indexOf("// ---- tags ----"));
  assert.match(section, /Observed in the group/);
  assert.match(section, /none observed \(or observation unavailable\)/);
  assert.match(section, /a move into the group was made \(see which tabs were observed there\)/);
  assert.match(section, /unknown — the move may or may not have been applied/);
  assert.doesNotMatch(section, /Moved tabs/, "the old label implied every selected tab was moved");
  assert.match(section, /a\.state === "executed" \|\| a\.state === "partial"/, "observed ids are shown only when a move is known");
});

test("a fresh Load tabs drops the whole move selection and destination; a fresh Load groups drops only the destination", () => {
  const tabsHandler = appJsSource.slice(appJsSource.indexOf("loadTabsButton.addEventListener"), appJsSource.indexOf("const loadGroupsButton"));
  assert.match(tabsHandler, /clearMoveSelection\(\);\n\s+clearArchiveTarget\(\);\n\s+const bgen = /, "cleared before the request starts");
  assert.ok(tabsHandler.indexOf("clearMoveSelection()") < tabsHandler.indexOf("apiRequest("), "and before the tab rows are replaced");
  assert.doesNotMatch(tabsHandler, /clearMoveDestination/);
  const groupsHandler = appJsSource.slice(appJsSource.indexOf("loadGroupsButton.addEventListener"), appJsSource.indexOf("return el(\"li\", {}, [renderWindowInfo(w)"));
  assert.match(groupsHandler, /clearMoveDestination\(\);\n\s+const bgen = /, "cleared before the request starts");
  assert.ok(groupsHandler.indexOf("clearMoveDestination()") < groupsHandler.indexOf("apiRequest("));
  assert.doesNotMatch(groupsHandler, /clearMoveSelection/, "the ticked tabs survive loading groups");
  // The two helpers do exactly what their names say.
  const destination = /function clearMoveDestination\(\) \{[\s\S]*?\n\}/.exec(appJsSource)[0];
  assert.match(destination, /moveDestination = null;/);
  assert.doesNotMatch(destination, /moveSelection/);
  const selection = /function clearMoveSelection\(\) \{[\s\S]*?\n\}/.exec(appJsSource)[0];
  assert.match(selection, /moveSelection = new Map\(\);/);
  assert.match(selection, /moveDestination = null;/);
});

test("ui/app.js drops the chosen group target when a fresh session replaces the known one, before rendering, and only then", () => {
  assert.match(appJsSource, /import \{[^}]*\bisReplacedSession\b[^}]*\} from "\.\/lib\.mjs";/);
  const remember = appJsSource.slice(appJsSource.indexOf("function rememberSessionFromWindowsResult"), appJsSource.indexOf("// True if `result` is the server's explicit"));
  assert.match(
    remember,
    /if \(isReplacedSession\(state\.sessionId, result\.browserSessionId\)\) \{\n\s+clearGroupTarget\(\);\n\s+clearMoveSelection\(\);\n\s+clearArchiveTarget\(\);\n\s+\}\n\s+state\.sessionId = result\.browserSessionId;/,
    "checked against the previous id, before it is overwritten",
  );
  assert.equal([...appJsSource.matchAll(/isReplacedSession\(/g)].length, 1, "one call site: no unconditional clearing on load");
  // rememberSessionFromWindowsResult runs before the window list is rendered.
  const load = appJsSource.slice(appJsSource.indexOf('qs("load-windows-button").addEventListener'));
  assert.ok(load.indexOf("rememberSessionFromWindowsResult(result)") < load.indexOf("renderWindowRow(w)"));
});

test("ui/app.js renders a group preview's tab text as text only and keeps the chosen target from outliving its browser session", () => {
  const section = appJsSource.slice(appJsSource.indexOf("// ---- browser actions"), appJsSource.indexOf("// ---- tags ----"));
  assert.match(section, /text: describeGroupBinding\(a\.binding\)/);
  assert.doesNotMatch(section, /\bhref\b|\bsrc\b|window\.open|\.innerHTML/);
  const stale = appJsSource.slice(appJsSource.indexOf("function handleStaleBrowserSession"), appJsSource.indexOf("// ---- connection status"));
  assert.match(stale, /clearGroupTarget\(\)/, "a stale browser session discards the chosen tab or group");
  assert.match(appJsSource, /clearGroupTarget\(\);\n/, "Disconnect resets the chosen target through resetDisplayedData");
});
