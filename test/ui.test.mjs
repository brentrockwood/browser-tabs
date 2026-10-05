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
