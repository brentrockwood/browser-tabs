import assert from "node:assert/strict";
import { test } from "node:test";

import { checkVersions } from "../scripts/check-versions.mjs";

test("package.json, extension/manifest.json, and extension/manifest.firefox.json agree on the product version", async () => {
  const { ok, mismatches, report } = await checkVersions();
  assert.equal(ok, true, mismatches.join("; "));
  assert.equal(typeof report.productVersion, "string");
  assert.ok(report.productVersion.length > 0);
});

test("reports the independent protocol/schema version numbers", async () => {
  const { report } = await checkVersions();
  assert.equal(Number.isInteger(report.protocolVersion), true);
  assert.equal(Number.isInteger(report.resultSchemaVersion), true);
  assert.equal("dbSchemaVersion" in report, false, "the service has no database schema");
});
