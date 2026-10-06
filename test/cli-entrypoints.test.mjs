import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));

// The three CLI entrypoints decide whether to run main() by comparing their
// own location to process.argv[1]. A hand-built `file://${argv[1]}` string
// never equals the percent-encoded `import.meta.url` when the path contains
// a space or another URL-special character, so the script silently did
// nothing (exit 0, no output). These tests run each entrypoint from a path
// full of such characters and assert real output and artifacts.
//
// Each invocation uses a minimal copy of the repository files it needs
// (explicit list below, no symlinks) under a freshly created, specially
// named temp directory, so nothing in the real tree is read-modified or
// written, and concurrent test files never share an output location.
const SPECIAL_DIR_NAME = "browser tabs & %20 #special ü";

const COPIED_FILES = [
  "package.json",
  "package-lock.json",
  "README.md",
  "project.md",
  "build/build-extension.mjs",
  "build/release.mjs",
  "build/zip.mjs",
  "scripts/check-versions.mjs",
  "extension/manifest.json",
  "extension/manifest.firefox.json",
  "extension/protocol.js",
  "extension/service-client.js",
  "extension/service-worker.js",
  "extension/options.html",
  "extension/options.js",
  "service/server.mjs",
  "service/cli.mjs",
  "service/credential.mjs",
  "docs/architecture.md",
  "docs/development.md",
  "docs/refocus-plan.md",
];

async function withSpecialRepoCopy(fn) {
  // realpath: Node reports `import.meta.url` for the entry module with
  // symlinks resolved, while process.argv[1] keeps the path as typed, so a
  // temp directory reached through a symlink (macOS: /var -> /private/var)
  // would make the two differ for reasons unrelated to URL encoding.
  const base = await realpath(await mkdtemp(join(tmpdir(), "browser-tabs-cli-entry-")));
  try {
    const copyRoot = join(base, SPECIAL_DIR_NAME, "repo copy");
    for (const relPath of COPIED_FILES) {
      await mkdir(dirname(join(copyRoot, relPath)), { recursive: true });
      await copyFile(join(REPO_ROOT, relPath), join(copyRoot, relPath));
    }
    return await fn({ base, copyRoot });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function runNode(script, args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (error) {
    assert.fail(`${script} exited abnormally (code ${error.code}): stdout=${error.stdout} stderr=${error.stderr}`);
  }
}

test("the special-character path really does defeat the old string-built guard", async () => {
  await withSpecialRepoCopy(async ({ copyRoot }) => {
    const script = join(copyRoot, "scripts", "check-versions.mjs");
    assert.notEqual(pathToFileURL(script).href, `file://${script}`);
  });
});

test("scripts/check-versions.mjs runs when invoked from a path with spaces and URL-special characters", async () => {
  await withSpecialRepoCopy(async ({ copyRoot }) => {
    const absolute = await runNode(join(copyRoot, "scripts", "check-versions.mjs"), [], copyRoot);
    assert.ok(
      absolute.stdout.includes(`Product version (package.json, both extension manifests): ${packageJson.version}`),
      `unexpected stdout: ${absolute.stdout}`,
    );
    assert.match(absolute.stdout, /API\/extension-bridge protocol version \(extension\/protocol\.js PROTOCOL_VERSION\): \d+/);

    // A relative script path (resolved against the cwd) must work too.
    const relative = await runNode(join("scripts", "check-versions.mjs"), [], copyRoot);
    assert.equal(relative.stdout, absolute.stdout);
  });
});

test("build/build-extension.mjs runs from a path with spaces and URL-special characters and writes both packages", async () => {
  await withSpecialRepoCopy(async ({ copyRoot }) => {
    const { stdout } = await runNode(join(copyRoot, "build", "build-extension.mjs"), [], copyRoot);
    assert.match(stdout, new RegExp(`Built Chrome extension \\(v${packageJson.version.replace(/\./g, "\\.")}\\) at `));
    assert.match(stdout, new RegExp(`Built Firefox extension \\(v${packageJson.version.replace(/\./g, "\\.")}\\) at `));

    const chromeManifest = JSON.parse(await readFile(join(copyRoot, "dist", "extension", "chrome", "manifest.json"), "utf8"));
    assert.equal(chromeManifest.version, packageJson.version);
    assert.equal(chromeManifest.background.service_worker, "service-worker.js");
    const firefoxManifest = JSON.parse(await readFile(join(copyRoot, "dist", "extension", "firefox", "manifest.json"), "utf8"));
    assert.deepEqual(firefoxManifest.background, { scripts: ["background.bundle.js"] });
    await readFile(join(copyRoot, "dist", "extension", "firefox", "background.bundle.js"), "utf8");
  });
});

test("build/release.mjs runs from a path with spaces and URL-special characters and writes the release", async () => {
  await withSpecialRepoCopy(async ({ base, copyRoot }) => {
    // The output directory is outside the copy, in the same private temp base.
    const outDir = join(base, "release out %20 #1");
    const { stdout } = await runNode(join(copyRoot, "build", "release.mjs"), [outDir], copyRoot);
    assert.ok(stdout.includes(`Built release v${packageJson.version} at ${outDir}:`), `unexpected stdout: ${stdout}`);

    const names = (await readdir(outDir)).sort();
    assert.deepEqual(
      names,
      [
        `browser-tabs-chrome-extension-${packageJson.version}.zip`,
        `browser-tabs-firefox-extension-${packageJson.version}.zip`,
        `browser-tabs-source-${packageJson.version}.zip`,
        "checksums.sha256",
        "manifest.json",
      ].sort(),
    );
    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.format, "browser-tabs-release-v1");
    assert.equal(manifest.version, packageJson.version);
    assert.equal(manifest.artifacts.length, 3);
  });
});

test("none of the three entrypoints uses a hand-built file:// main guard any more", async () => {
  for (const relPath of ["build/release.mjs", "build/build-extension.mjs", "scripts/check-versions.mjs"]) {
    const source = await readFile(join(REPO_ROOT, relPath), "utf8");
    assert.ok(!source.includes("`file://${process.argv[1]}`"), `${relPath} still compares import.meta.url to a string-built file:// URL`);
    assert.match(
      source,
      /if \(process\.argv\[1\] && fileURLToPath\(import\.meta\.url\) === resolve\(process\.argv\[1\]\)\) \{/,
      `${relPath} must compare filesystem paths`,
    );
  }
});
