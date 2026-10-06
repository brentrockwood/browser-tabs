# Development, testing, and releases

## Local development

Install dependencies and load `extension/` directly in Chrome, or build both browser variants:

```sh
npm install
npm run build:extension
```

This writes `dist/extension/chrome/` and `dist/extension/firefox/`. Chrome uses the source Manifest V3 module service worker unchanged. Firefox uses a generated classic-script bundle of the same sources (`background.bundle.js`) and a manifest without the `tabGroups` permission.

## Checks

```sh
npm test                         # unit and HTTP integration tests
npm run check:versions           # package and extension manifest versions agree
npm run check:service-lifecycle  # start, authenticate, restart, stop; no database created
npm audit --omit=dev
```

The lifecycle check needs no browser and runs on macOS and Linux. It also verifies that a database, agent token, or lock file left by an earlier version is not touched.

The main test files:

| File | Covers |
| --- | --- |
| `test/protocol.test.mjs` | normalizers, envelopes, read-result validation |
| `test/service-worker.test.mjs` | the five reads, sessions, the read-only message listener |
| `test/tab-group-mutations.test.mjs` | change requests and results, and the extension's three changes against a stateful mock browser |
| `test/bridge.test.mjs` | the service/extension transport, read routes, bounds, the exact route surface |
| `test/mutation-routes.test.mjs` | the three change routes over HTTP: auth, body bounds, forwarding, `changed` on every response |
| `test/host-defense.test.mjs` | `Host` header checks |
| `test/credential.test.mjs` | the pairing token file |
| `test/release.test.mjs`, `test/build-extension.test.mjs`, `test/versions.test.mjs` | packaging |

## Browser smoke tests

```sh
CHROME_PATH=/path/to/chrome-for-testing npm run test:smoke          # reads via runtime.onMessage
CHROME_PATH=/path/to/chrome-for-testing npm run test:smoke:bridge   # full bridge, changes, restarts
FIREFOX_PATH=/path/to/firefox GECKODRIVER_PATH=/path/to/geckodriver npm run test:smoke:firefox
```

The bridge smoke runs the real service and extension: reads, every change and refusal checked against the browser's own tabs and groups, survival past the service-worker idle window, recovery after a service restart and a browser restart, and session rotation. It takes several minutes because it waits out the idle window and the reconnect alarm on purpose. The Firefox smoke installs the built package, checks the reads, and checks that all three changes answer `unsupported` with `changed: false`.

Set `SMOKE_HEADLESS=false` for a headed run. The Chromium scripts also accept `CHROMIUM_PATH`. Each script ends with `SMOKE_PASS`, `SMOKE_FAIL` (a product assertion failed), or `SMOKE_BLOCKED` (the environment could not run it).

Chrome for Testing is the reference browser because it reliably honors `--load-extension`; consumer Chrome builds may ignore that flag. A Playwright install provides one under `~/Library/Caches/ms-playwright/chromium-*/`.

## Versions

| Version | Source | Change when |
| --- | --- | --- |
| Product | `package.json` and both extension manifests | making a release |
| Protocol | `PROTOCOL_VERSION` in `extension/protocol.js` (currently 7) | the wire contract becomes incompatible |
| Result schema | `RESULT_SCHEMA_VERSION` in `extension/protocol.js` | the result envelope shape changes |

These change independently. `npm run check:versions` fails if the product version differs between the three files.

## Release artifacts

```sh
npm run release
```

The default output is `dist/release/` (ignored by git): Chrome and Firefox extension zips, a source zip, SHA-256 checksums, and a manifest with the product, protocol, and result-schema versions. Builds are byte-for-byte deterministic. Every archive is built from explicit file lists — the source zip holds only the runtime service and extension files, `package.json`, the lock file, `README.md`, `docs/project.md`, `docs/architecture.md`, `docs/development.md`, and `docs/refocus-plan.md` — and a name check refuses credential, database, pid, and port files. A custom output directory may be passed to `node build/release.mjs <outDir>`, subject to the script's safety checks.

## CI

`.github/workflows/ci.yml` runs the version check, unit tests, `npm audit --omit=dev`, and the lifecycle check on macOS and Linux. A best-effort Linux job installs Chromium, Firefox, and geckodriver and runs the three smoke scripts; hosted browser installs are less reliable, so that job does not block.
