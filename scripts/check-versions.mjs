#!/usr/bin/env node
// Stage 6: "Version the extension, service, API, and database schema
// deliberately" (project.md).
//
// This project deliberately has *one* product-version field —
// package.json's "version" — mirrored into both extension manifests
// (extension/manifest.json for Chrome, extension/manifest.firefox.json for
// Firefox), which this script checks for exact equality. It is not
// auto-fixed here: a mismatch is a real inconsistency a human must resolve,
// and build/build-extension.mjs independently refuses to build from
// mismatched manifests for the same reason.
//
// The wire/storage protocol versions below are deliberately *not* tied to
// that product version, and are not asserted equal to anything by this
// script — they are independent compatibility contracts that only change
// when their own compatibility rules require it. This script's job for
// those is only to report their current values so a release's version
// report always shows all of them together. See "Versioning" in README.md
// for the bump rule for each.
//
// Usage: node scripts/check-versions.mjs
// Exit code: 0 if the product version is consistent, 1 otherwise.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION, RESULT_SCHEMA_VERSION } from "../extension/protocol.js";
import { MIGRATIONS } from "../service/store.mjs";

const PACKAGE_JSON_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const CHROME_MANIFEST_PATH = fileURLToPath(new URL("../extension/manifest.json", import.meta.url));
const FIREFOX_MANIFEST_PATH = fileURLToPath(new URL("../extension/manifest.firefox.json", import.meta.url));

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function checkVersions() {
  const [pkg, chromeManifest, firefoxManifest] = await Promise.all([
    readJson(PACKAGE_JSON_PATH),
    readJson(CHROME_MANIFEST_PATH),
    readJson(FIREFOX_MANIFEST_PATH),
  ]);

  const dbSchemaVersion = Math.max(...MIGRATIONS.map((migration) => migration.version));

  const mismatches = [];
  if (chromeManifest.version !== pkg.version) {
    mismatches.push(
      `extension/manifest.json version "${chromeManifest.version}" does not match package.json version "${pkg.version}"`,
    );
  }
  if (firefoxManifest.version !== pkg.version) {
    mismatches.push(
      `extension/manifest.firefox.json version "${firefoxManifest.version}" does not match package.json version "${pkg.version}"`,
    );
  }

  return {
    ok: mismatches.length === 0,
    mismatches,
    report: {
      productVersion: pkg.version,
      protocolVersion: PROTOCOL_VERSION,
      resultSchemaVersion: RESULT_SCHEMA_VERSION,
      dbSchemaVersion,
    },
  };
}

async function main() {
  const { ok, mismatches, report } = await checkVersions();
  console.log(`Product version (package.json, both extension manifests): ${report.productVersion}`);
  console.log(`API/extension-bridge protocol version (extension/protocol.js PROTOCOL_VERSION): ${report.protocolVersion}`);
  console.log(`Capture/result envelope schema version (RESULT_SCHEMA_VERSION): ${report.resultSchemaVersion}`);
  console.log(`Database schema version (service/store.mjs MIGRATIONS, highest version): ${report.dbSchemaVersion}`);
  if (!ok) {
    console.error("\nVersion mismatch:");
    for (const mismatch of mismatches) console.error(`  - ${mismatch}`);
    process.exitCode = 1;
  }
}

// Compares filesystem paths, not URL strings: `import.meta.url` is
// percent-encoded (a space becomes %20), which a hand-built `file://` string
// never matches.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
