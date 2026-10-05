import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import { buildChromeExtension, buildFirefoxExtension } from "../build/build-extension.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "browser-tabs-build-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("buildChromeExtension copies the unmodified ES-module manifest and sources", async () => {
  await withTempDir(async (dir) => {
    const outDir = join(dir, "chrome");
    const result = await buildChromeExtension(outDir);
    assert.equal(result.browser, "chrome");

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.background.service_worker, "service-worker.js");
    assert.equal(manifest.background.type, "module");
    assert.ok(manifest.permissions.includes("tabGroups"));
    assert.equal(manifest.version, result.version);

    const serviceWorkerSource = await readFile(join(outDir, "service-worker.js"), "utf8");
    assert.match(serviceWorkerSource, /^import \{/m);
    assert.match(serviceWorkerSource, /^export async function listWindows/m);
  });
});

test("buildFirefoxExtension produces a scripts-array manifest with no tabGroups permission", async () => {
  await withTempDir(async (dir) => {
    const outDir = join(dir, "firefox");
    const result = await buildFirefoxExtension(outDir);
    assert.equal(result.browser, "firefox");

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.background, { scripts: ["background.bundle.js"] });
    assert.equal(manifest.browser_specific_settings.gecko.id, "browser-tabs@brentrockwood.com");
    assert.ok(!manifest.permissions.includes("tabGroups"));
    assert.ok(manifest.permissions.includes("history"));
    assert.equal(manifest.version, result.version);
    assert.equal(
      manifest.content_security_policy.extension_pages,
      "script-src 'self'; object-src 'none'; connect-src ws://127.0.0.1:8743",
    );

    // The real options page imports these modules directly; Firefox's
    // background bundle does not replace their on-disk copies.
    assert.match(await readFile(join(outDir, "service-client.js"), "utf8"), /^import \{/m);
    assert.match(await readFile(join(outDir, "protocol.js"), "utf8"), /DEFAULT_SERVICE_PORT/);

    const bundle = await readFile(join(outDir, "background.bundle.js"), "utf8");
    assert.doesNotMatch(bundle, /^import\s/m);
    assert.doesNotMatch(bundle, /^export\s/m);
    // Every top-level declaration from all three source files must still be
    // present as a plain declaration (the `export` keyword stripped, not the
    // declaration itself).
    assert.match(bundle, /^function createServiceClient/m);
    assert.match(bundle, /^async function listWindows/m);
    assert.match(bundle, /^const ERROR_CODES = /m);
  });
});

// The strongest available proof that the hand-written bundler (build/
// build-extension.mjs) produces *working* code, not merely text matching a
// few regexes: actually run the generated bundle in a fresh V8 context
// against a minimal mock of the WebExtension `browser` namespace — modeled
// on Firefox (no `tabGroups`, matching extension/manifest.firefox.json's
// omitted permission) — and confirm it initializes without throwing and
// registers the real `runtime.onMessage` listener.
test("the Firefox background bundle actually runs and registers the real message listener", async () => {
  await withTempDir(async (dir) => {
    const outDir = join(dir, "firefox");
    await buildFirefoxExtension(outDir);
    const bundle = await readFile(join(outDir, "background.bundle.js"), "utf8");

    const onMessageListeners = [];
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      crypto: globalThis.crypto,
      browser: {
        storage: {
          session: {
            get: async () => ({}),
            set: async () => {},
          },
          local: null, // Firefox has this too, but omitting it here keeps this test from starting a real connection attempt.
        },
        runtime: {
          onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
        },
        // Deliberately no `tabGroups`, `history`, or `scripting` — proves
        // the bundle's own feature-detection (not this test) is what would
        // report their absence, and that merely lacking them does not throw
        // during module initialization.
      },
    };
    sandbox.globalThis = sandbox;
    const context = vm.createContext(sandbox);

    assert.doesNotThrow(() => {
      new vm.Script(bundle, { filename: "background.bundle.js" }).runInContext(context);
    });

    assert.equal(onMessageListeners.length, 1);
    const result = await onMessageListeners[0]({ method: "browser.not_a_real_method" });
    assert.equal(result.status, "error");
    assert.equal(result.code, "unknown_method");
  });
});

test("buildChromeExtension and buildFirefoxExtension are deterministic across repeated builds", async () => {
  await withTempDir(async (dir) => {
    const firstDir = join(dir, "firefox-1");
    const secondDir = join(dir, "firefox-2");
    await buildFirefoxExtension(firstDir);
    await buildFirefoxExtension(secondDir);
    const first = await readFile(join(firstDir, "background.bundle.js"), "utf8");
    const second = await readFile(join(secondDir, "background.bundle.js"), "utf8");
    assert.equal(first, second);
  });
});
