// Stage 5: the local review UI's static asset routes.
//
// This is an exact allowlist of fixed request paths -> fixed, checked-in
// files (ui/index.html, ui/app.js, ui/lib.mjs, ui/styles.css), read once at
// module load — never a generic static-file server that walks a
// caller-supplied path off disk. There is no dynamic path segment anywhere
// in UI_ROUTES, so
// there is no path-traversal surface to sanitize against: a request for
// anything other than one of these exact strings simply has no entry in
// the Map and falls through to the server's existing 404 `not_found`
// handling (service/server.mjs), exactly like an unknown /api/ method.
//
// The UI itself carries no secret and performs no action merely by being
// served — every operation it makes goes through the existing authenticated
// /api/ routes, exactly like any other local API caller (see ui/app.js).
// Static asset responses are therefore served without requiring
// Authorization or X-Protocol-Version (ordinary browser navigation and
// <script>/<link> fetches never send either), but still carry a
// restrictive Content-Security-Policy and the other headers below —
// project.md Stage 5: "Escape untrusted text and use a restrictive Content
// Security Policy."
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UI_DIR = fileURLToPath(new URL("../ui/", import.meta.url));

function readAsset(name) {
  return readFileSync(UI_DIR + name);
}

const INDEX_HTML = readAsset("index.html");
const APP_JS = readAsset("app.js");
// Stage 5 remediation: the small, pure, DOM-free race-prevention helpers
// ui/app.js imports as a native ES module (see ui/lib.mjs and
// test/ui-lib.test.mjs) — served the same way as app.js itself.
const LIB_MJS = readAsset("lib.mjs");
const STYLES_CSS = readAsset("styles.css");

// path -> { body: Buffer, contentType }. "/ui/" and "/ui/index.html" both
// serve the one page; there is no server-rendered content and no template
// substitution anywhere in this module, so there is nothing here that could
// embed untrusted data into a response.
export const UI_ROUTES = new Map([
  ["/ui/", { body: INDEX_HTML, contentType: "text/html; charset=utf-8" }],
  ["/ui/index.html", { body: INDEX_HTML, contentType: "text/html; charset=utf-8" }],
  ["/ui/app.js", { body: APP_JS, contentType: "text/javascript; charset=utf-8" }],
  ["/ui/lib.mjs", { body: LIB_MJS, contentType: "text/javascript; charset=utf-8" }],
  ["/ui/styles.css", { body: STYLES_CSS, contentType: "text/css; charset=utf-8" }],
]);

// Deliberately restrictive: no default source at all; script and style only
// from this same origin (no inline script/style, no eval, no remote
// script); fetches only to this same origin (the API this page calls);
// never framed or framing; no form submission target, no <base> rewrite.
// This is a static string — not built from any request- or caller-derived
// value — so there is no injection surface in the header itself either.
export const UI_CONTENT_SECURITY_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export function serveUiAsset(res, asset) {
  res.writeHead(200, {
    "Content-Type": asset.contentType,
    "Content-Length": asset.body.length,
    "Content-Security-Policy": UI_CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    // The UI's own asset bytes are static and not sensitive, but this is a
    // review surface for owner-token-gated browser/derived data rendered by
    // the same page — never cache it (project.md: "no-store").
    "Cache-Control": "no-store",
  });
  res.end(asset.body);
}
