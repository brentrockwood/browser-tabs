// Stage 6: produces browser-specific extension packages from the single
// extension/ source tree, kept at the extension API boundary (project.md:
// "Browser-specific code should remain at the extension API boundary").
//
// Chrome's package is the source files unchanged: Manifest V3 with an
// ES-module `background.service_worker`, which Chrome supports reliably.
//
// Firefox's current, reliably supported MV3 background shape is a
// non-module `background.scripts` event page, not `service_worker` — so
// `extension/service-worker.js`, `extension/service-client.js`, and
// `extension/protocol.js` (plain ES modules with only static named
// imports/exports; verified by reading all three) are concatenated into one
// classic script, `background.bundle.js`, by stripping each file's own
// `import`/`export` statements rather than executing them as modules. This
// is a dependency-free, in-repo bundler, not a general-purpose one: it only
// ever has to handle the narrow shape these three files already use, no
// more. `extension/manifest.firefox.json` is the Firefox manifest source
// (distinct permissions — no `tabGroups`, which Firefox does not implement
// — and a fixed `browser_specific_settings.gecko.id` for a stable
// temporary-install identity), copied to the Firefox package's
// `manifest.json` with its `version` field re-stamped from package.json so
// the two can never silently drift apart (see scripts/check-versions.mjs).
//
// Neither package includes any test-only file, credential, database, or
// local path — only extension/manifest.json (or manifest.firefox.json),
// service-worker.js, service-client.js, protocol.js, options.html, and
// options.js (the exact files already present in extension/).

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const EXTENSION_SOURCE_DIR = fileURLToPath(new URL("../extension/", import.meta.url));
export const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

const SHARED_FILES = ["options.html", "options.js"];
const BACKGROUND_MODULE_FILES = ["protocol.js", "service-client.js", "service-worker.js"];

async function readPackageVersion() {
  const pkg = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"));
  return pkg.version;
}

// Removes a static `import { a, b, c } from "./x.js";` statement (possibly
// spanning multiple lines, one named binding per line, as this project's
// own files write them) — never a dynamic `import(...)`, a default import,
// or a namespace import, none of which any of the three bundled files use.
function stripImports(source) {
  return source.replace(/^import\s*\{[\s\S]*?\}\s*from\s*["'][^"']+["'];?[ \t]*\r?\n/gm, "");
}

// Removes the `export ` keyword from a top-level declaration so the
// resulting concatenation is one ordinary script, not a module — the
// declared names remain in the same shared top-level scope either way, so
// nothing below the point of definition that referenced them by name needs
// to change. Only matches the declaration forms these files actually use
// (`function`, `async function`, `const`, `class`); a bare `export { ... };`
// re-export list is deliberately not handled, since none of these files use
// that form (verified by reading all three).
function stripExports(source) {
  return source.replace(/^export\s+(async function|function|const|class|let|var)\s+/gm, "$1 ");
}

function bundleModule(source) {
  return stripExports(stripImports(source));
}

async function readExtensionFile(name) {
  return readFile(join(EXTENSION_SOURCE_DIR, name), "utf8");
}

async function writeOutFile(outDir, name, contents) {
  await writeFile(join(outDir, name), contents, "utf8");
}

export async function buildChromeExtension(outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const version = await readPackageVersion();
  const manifest = JSON.parse(await readExtensionFile("manifest.json"));
  if (manifest.version !== version) {
    throw new Error(
      `extension/manifest.json version "${manifest.version}" does not match package.json version "${version}"; ` +
        "run scripts/check-versions.mjs and fix the mismatch before building.",
    );
  }
  await writeOutFile(outDir, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  for (const name of [...BACKGROUND_MODULE_FILES, ...SHARED_FILES]) {
    await writeOutFile(outDir, name, await readExtensionFile(name));
  }

  return { outDir, browser: "chrome", version };
}

export async function buildFirefoxExtension(outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const version = await readPackageVersion();
  const manifest = JSON.parse(await readFile(join(EXTENSION_SOURCE_DIR, "manifest.firefox.json"), "utf8"));
  if (manifest.version !== version) {
    throw new Error(
      `extension/manifest.firefox.json version "${manifest.version}" does not match package.json version "${version}"; ` +
        "run scripts/check-versions.mjs and fix the mismatch before building.",
    );
  }
  manifest.background = { scripts: ["background.bundle.js"] };
  await writeOutFile(outDir, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

  const bundledSources = await Promise.all(BACKGROUND_MODULE_FILES.map((name) => readExtensionFile(name)));
  const banner =
    "// Generated by build/build-extension.mjs from extension/{protocol,service-client,service-worker}.js\n" +
    "// for Firefox's background.scripts event page. Do not edit directly; edit the source files and rebuild.\n";
  const bundle = banner + bundledSources.map(bundleModule).join("\n");
  await writeOutFile(outDir, "background.bundle.js", bundle);

  // The options page remains an ES module and imports these two local
  // modules directly, even though the background runtime uses their bundled
  // copies above.
  for (const name of [...SHARED_FILES, "protocol.js", "service-client.js"]) {
    await writeOutFile(outDir, name, await readExtensionFile(name));
  }

  return { outDir, browser: "firefox", version };
}

async function main() {
  const distRoot = fileURLToPath(new URL("../dist/extension/", import.meta.url));
  const chrome = await buildChromeExtension(join(distRoot, "chrome"));
  const firefox = await buildFirefoxExtension(join(distRoot, "firefox"));
  console.log(`Built Chrome extension (v${chrome.version}) at ${chrome.outDir}`);
  console.log(`Built Firefox extension (v${firefox.version}) at ${firefox.outDir}`);
}

// Compares filesystem paths, not URL strings: `import.meta.url` is
// percent-encoded (a space becomes %20), which a hand-built `file://` string
// never matches.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
