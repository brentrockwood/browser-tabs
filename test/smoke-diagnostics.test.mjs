import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { DiagnosticError, describeError, safeLabel } from "../scripts/safe-diagnostics.mjs";

// The Firefox smoke test handles the owner/agent tokens (the owner token is
// even carried in the fixture page's URL) plus page text and URLs read from a
// real browser. These tests pin down that its failure output is built from
// stable status/code/count diagnostics only. The real smoke test needs a
// Firefox binary, so the source-level checks below are what keep a future
// edit from re-introducing a leak.

// scripts/service-lifecycle-check.mjs is covered too: it runs in CI, and the
// real service's stdout (where its pairing credential is printed) must never
// reach its failure output either.
const SMOKE_SOURCES = {
  "firefox-smoke.mjs": await readFile(fileURLToPath(new URL("./smoke/firefox-smoke.mjs", import.meta.url)), "utf8"),
  "webdriver-client.mjs": await readFile(fileURLToPath(new URL("./smoke/webdriver-client.mjs", import.meta.url)), "utf8"),
  "service-lifecycle-check.mjs": await readFile(fileURLToPath(new URL("../scripts/service-lifecycle-check.mjs", import.meta.url)), "utf8"),
};

// Identifiers/properties whose value may be (or may contain) a secret,
// browser-derived text, or raw service/WebDriver output.
const FORBIDDEN_IN_INTERPOLATION =
  /\b(ownerToken|agentToken|token|fixtureUrl|probeRaw|probe|getStdout|getStderr|responseBody|stdout|stderr|data)\b|\.message\b|\.stack\b/;

// The only interpolations allowed to name a forbidden identifier: injecting
// the owner token into the page script that drives the real review UI,
// building the fixture URL itself (never printed), and the Authorization
// header of an outgoing request (a line containing "Bearer").
const ALLOWED_SECRET_INTERPOLATIONS = new Set(["JSON.stringify(ownerToken)", "ownerToken"]);

function interpolations(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .flatMap((line) => [...line.matchAll(/\$\{([^}]*)\}/g)].map((match) => ({ expression: match[1].trim(), line })));
}

test("safeLabel passes identifier-shaped codes and replaces everything else", () => {
  assert.equal(safeLabel("ok"), "ok");
  assert.equal(safeLabel("invalid_credential"), "invalid_credential");
  assert.equal(safeLabel("invalid-argument"), "invalid-argument");
  for (const bad of [undefined, null, 42, {}, "", "has space", "http://127.0.0.1:1/?t=secret", "a".repeat(65), "line\nbreak"]) {
    assert.equal(safeLabel(bad), "(unrecognized)", String(bad));
  }
});

test("describeError never prints the message of an arbitrary error", () => {
  const secret = "a".repeat(64);
  let syntaxError;
  try {
    JSON.parse(`${secret} is not json`);
  } catch (error) {
    syntaxError = error;
  }
  assert.ok(syntaxError.message.length > 0);
  assert.equal(describeError(syntaxError), "SyntaxError");

  const withCode = Object.assign(new Error(`connect failed for http://x/?browserTabsSmokeToken=${secret}`), { code: "ECONNREFUSED" });
  assert.equal(describeError(withCode), "Error/ECONNREFUSED");
  assert.ok(!describeError(withCode).includes(secret));

  assert.equal(describeError(undefined), "(unrecognized)");
  assert.equal(describeError(new DiagnosticError("fixed status text, HTTP status 500")), "fixed status text, HTTP status 500");
});

for (const [name, source] of Object.entries(SMOKE_SOURCES)) {
  test(`${name} never reads an error's message/stack or slices a response body`, () => {
    assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ""), /\.message\b|\.stack\b|\bdata\.slice\(|\bresponseBody\.slice\(/);
  });

  test(`${name} never interpolates a secret, browser-derived value, or raw output into a string`, () => {
    for (const { expression, line } of interpolations(source)) {
      if (!FORBIDDEN_IN_INTERPOLATION.test(expression)) continue;
      const isAuthorizationHeader = expression === "token" && line.includes("Bearer ");
      assert.ok(
        isAuthorizationHeader || ALLOWED_SECRET_INTERPOLATIONS.has(expression),
        `unexpected interpolation of a sensitive value: \${${expression}}`,
      );
    }
  });

  test(`${name} only JSON.stringifies known-safe values`, () => {
    const allowed = [
      /JSON\.stringify\(body\)/, // outgoing request payloads
      /JSON\.stringify\(ownerToken\)/, // injected into the review-UI page script
      /JSON\.stringify\(acceptProposalId\)/,
      /JSON\.stringify\(rejectProposalId\)/,
      /JSON\.stringify\(manifest, null, 2\)/, // staging the extension manifest
    ];
    for (const line of source.split("\n")) {
      if (!line.includes("JSON.stringify(") || /^\s*\/\//.test(line)) continue;
      assert.ok(
        allowed.some((pattern) => pattern.test(line)),
        `JSON.stringify of an unexpected value (never stringify a probe, browser, or service response): ${line.trim()}`,
      );
    }
  });
}

for (const name of ["firefox-smoke.mjs", "service-lifecycle-check.mjs"]) {
  test(`${name} never puts service stdout/stderr into an error`, () => {
    const source = SMOKE_SOURCES[name];
    const uses = source.split("\n").filter((line) => /getStdout|getStderr/.test(line) && !/^\s*\/\//.test(line));
    // The accessor definition, and the one internal read that matches the
    // printed-token regex — nothing else.
    assert.equal(uses.length, 2, `unexpected stdout/stderr uses: ${uses.join(" | ")}`);
    assert.ok(uses.some((line) => /return \{ child, exited, getStdout: /.test(line)), "expected the accessor definition");
    assert.ok(uses.some((line) => /\.exec\(service\.getStdout\(\)\)/.test(line)), "expected the token-regex read");
  });
}

test("the lifecycle check's token timeout is a fixed message that cannot include the service's output", () => {
  const source = SMOKE_SOURCES["service-lifecycle-check.mjs"];
  const match = /async function waitForToken[\s\S]*?\n\}\n/.exec(source);
  assert.ok(match, "expected waitForToken in the lifecycle check");
  const body = match[0];
  const throws = body.split("\n").filter((line) => line.includes("throw "));
  assert.equal(throws.length, 1);
  assert.match(throws[0], /new DiagnosticError\(`service did not print a pairing token within \$\{timeoutMs\}ms/);
  assert.doesNotMatch(throws[0], /getStdout|\.message/);
  assert.match(source, /LIFECYCLE_CHECK_FAIL: \$\{describeError\(error\)\}/);
});

// SMOKE_FAIL (exit 1) vs SMOKE_BLOCKED (exit 2): only the environment problems
// that precede a real Firefox session may be "blocked"; everything after —
// including the extension failing to connect — must be a product failure.
test("the Firefox smoke test classifies post-setup failures as SMOKE_FAIL and only infrastructure as SMOKE_BLOCKED", () => {
  const source = SMOKE_SOURCES["firefox-smoke.mjs"];
  const code = source.replace(/^\s*\/\/.*$/gm, "");

  assert.match(code, /function fail\([^)]*\) \{\s*console\.error\(`SMOKE_FAIL: [\s\S]*?process\.exitCode = 1;/);
  assert.match(code, /function blocked\([^)]*\) \{\s*console\.error\(`SMOKE_BLOCKED: [\s\S]*?process\.exitCode = 2;/);

  const marker = code.indexOf('phase = "product";');
  assert.ok(marker > 0, 'expected the `phase = "product"` transition');
  assert.match(code, /let phase = "infrastructure";/);

  // The transition happens right after session startup and before any
  // add-on install / page / extension step.
  const sessionStart = code.indexOf("failed to start a WebDriver session");
  assert.ok(sessionStart > 0 && sessionStart < marker, "the phase must switch only after the session starts");
  assert.ok(code.indexOf("installTemporaryAddon(driverPort") > marker);
  assert.ok(code.indexOf("await waitUntilExtensionConnected(") > marker);

  // Every environment blocker that exists is before the transition ...
  const infraBlockers = ["no Firefox executable", "is already in use", "did not start as expected", "failed to launch geckodriver", "geckodriver exited before", "failed to start a WebDriver session"];
  for (const text of infraBlockers) {
    const at = code.indexOf(text);
    assert.ok(at > 0 && at < marker, `expected the infrastructure blocker "${text}" before the transition`);
  }

  // ... and, after it, the only blocked() is the outer catch's `else` branch
  // for a not-yet-product phase; main()'s own catch precedes any session.
  const afterTransition = code.slice(marker);
  const blockedCalls = afterTransition.match(/\bblocked\(/g) ?? [];
  assert.equal(blockedCalls.length, 2, "after the transition only the outer catch's else-branch and main().catch may call blocked()");
  assert.match(afterTransition, /if \(phase === "product"\) fail\(describeError\(error\)\);\s*else blocked\(describeError\(error\)\);/);
  assert.match(afterTransition, /main\(\)\.catch\(\(error\) => \{\s*blocked\(`unexpected error: \$\{describeError\(error\)\}`\);/);

  // The extension-connection wait reports a failure explicitly, not an escape to the outer catch.
  assert.match(
    code,
    /try \{\s*await waitUntilExtensionConnected\(port, 10_000\);\s*\} catch \(error\) \{\s*fail\(`the extension never connected to the service[^`]*\$\{describeError\(error\)\}`\);\s*return;/,
  );
});

test("the Firefox smoke test routes failures through the leak-safe helpers", () => {
  const source = SMOKE_SOURCES["firefox-smoke.mjs"];
  assert.match(source, /from "\.\.\/\.\.\/scripts\/safe-diagnostics\.mjs"/);
  // Every fail()/blocked() message that includes a caught error does so via describeError.
  assert.doesNotMatch(source, /catch \((\w+)\) \{[^}]*\b(fail|blocked)\([^)]*\$\{\1\b[^}]*\}/);
});
