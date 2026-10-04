# Browser Tabs

A deterministic, local-first browser adapter for inspecting open browser windows, tabs, and page-content snapshots. Model integration is deliberately out of scope.

## Phase-one contract

- Enumerate extension-visible browser windows.
- Enumerate extension-visible tabs in a window.
- Read a versioned, bounded text snapshot from a tab that permits script injection.

The extension never rearranges, closes, creates, or navigates tabs in this phase.

`browser.read_tab` returns the document body's rendered text (`innerText`) in
document order, normalizes CRLF to LF, and caps `text` at 500,000 characters.
It reports the full `characterCount` and `truncated: true` when the cap applies.

## Support boundary

The code targets Manifest V3 WebExtensions. Today, only Chromium-family
browsers are exercised by the test suite in this repository (see
`test/smoke/chromium-smoke.mjs`); Firefox parity is a planned later milestone
(project.md Stage 6) and is not yet tested. Browsers may refuse content
access to internal pages, extension-store pages, or other protected
contexts. Those cases are returned as explicit `unsupported` outcomes with a
stable error code, never as empty or invented page content.

Within Chromium-family browsers, the automated smoke path has a narrower,
evidence-based requirement: it needs a build that reliably honors
`--load-extension` on the command line. A locally installed, branded Google
Chrome (and, by the same restriction, branded Edge/Brave) is known to
silently ignore `--load-extension` and is **not supported** by the automated
smoke test; it is not auto-detected and is not a recommended `CHROME_PATH`
target. What is proven to work is a Chrome for Testing binary
(https://googlechromelabs.github.io/chrome-for-testing/) pointed to
explicitly via `CHROME_PATH`; Chromium (the open-source build) is also
expected to work and is the only browser this script auto-detects.

## Local development

Load `extension/` as an unpacked extension in a Chromium browser. The prototype uses no network and has no external service.

Run the deterministic unit tests (mocked browser APIs, no browser required) with:

```sh
npm test
```

Run the Chromium smoke test (stages a temporary copy of the extension plus a
test-only harness page, loads it unpacked in a real local Chromium or Chrome
for Testing binary, and — by calling `chrome.runtime.sendMessage` from that
harness page, exercising the real `runtime.onMessage` listener rather than
importing its exported functions — checks window listing, tab listing,
reading an ordinary page, reading a protected `chrome://` page, and an
unknown method) with:

```sh
npm run test:smoke
```

This smoke command specifically requires Node.js 22 or later, for the
built-in `WebSocket` client it uses to speak the Chrome DevTools Protocol;
this is not a project-wide requirement — `npm test` (the unit tests) runs on
any Node.js version supporting `node:test`.

It also needs a browser binary that reliably honors `--load-extension`: set
`CHROME_PATH` to a Chrome for Testing binary (proven to work) or rely on
auto-detected Chromium. A locally installed branded Google Chrome, Edge, or
Brave is known to silently ignore `--load-extension` and is deliberately not
auto-detected or recommended as `CHROME_PATH`; pointing `CHROME_PATH` at one
will run, but is unsupported — once Chrome has launched and exposed CDP, the
extension's service worker never loading (as happens when `--load-extension`
was silently ignored) is reported as `SMOKE_FAIL`, not `SMOKE_BLOCKED`, since
at that point the script cannot distinguish "unsupported browser" from a real
startup regression. Set `SMOKE_HEADLESS=false` to run headed.

The script prints `SMOKE_PASS`, `SMOKE_FAIL` (a product assertion failed, the
`runtime.sendMessage` exercise itself threw, or the extension's service
worker never started after Chrome launched and exposed CDP — the extension
behaved incorrectly, or an unsupported browser was used), or `SMOKE_BLOCKED`
(an infrastructure/environment problem prevented the test from running at
all, e.g. no suitable browser found, an invalid `CHROME_PATH` that failed to
launch, or a CDP/setup timeout before the browser was reachable) with the
specific reason, and exits non-zero on anything other than a pass.
