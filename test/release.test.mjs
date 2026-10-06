import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { RELEASE_FORMAT, REPO_ROOT, assertReplaceableOutDir, assertSafeOutDir, buildRelease } from "../build/release.mjs";
import { readZipEntries } from "../build/zip.mjs";

const packageJson = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "browser-tabs-release-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Matches only actual local secret/data artifacts (exact basenames
// credential / agent-token, *.db, *.pid, *.port) or forbidden directories
// (node_modules, .git) — never source files that merely contain
// "credential" in their name, like service/credential.mjs.
const LEAKED_ARTIFACT = /(^|\/)(node_modules|\.git)(\/|$)|(^|\/)(credential|agent-token)$|\.(db|pid|port)$|\.db-\w+$/i;

function findArtifact(result, suffix) {
  const artifact = result.artifacts.find((a) => a.name.endsWith(suffix));
  assert.ok(artifact, `expected an artifact ending in "${suffix}" among: ${result.artifacts.map((a) => a.name).join(", ")}`);
  return artifact;
}

test("the leak pattern flags real secret/data artifacts but not credential.mjs", () => {
  for (const bad of ["credential", "x/agent-token", "browser-tabs.db", "a/b.pid", "service.port", "node_modules/ws/index.js", ".git/HEAD", "p/.git/config"]) {
    assert.ok(LEAKED_ARTIFACT.test(bad), bad);
  }
  for (const ok of ["service/credential.mjs", "browser-tabs-0.1.0/service/credential.mjs", "extension/options.js"]) {
    assert.ok(!LEAKED_ARTIFACT.test(ok), ok);
  }
});

test("buildRelease produces version-consistent, checksummed artifacts", async () => {
  await withTempDir(async (dir) => {
    const outDir = join(dir, "release");
    const result = await buildRelease(outDir);

    assert.equal(result.version, packageJson.version);
    assert.equal(result.artifacts.length, 3);

    const manifest = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    assert.equal(manifest.version, packageJson.version);
    assert.equal(manifest.artifacts.length, 3);

    const checksumsText = await readFile(join(outDir, "checksums.sha256"), "utf8");
    for (const artifact of result.artifacts) {
      const buffer = await readFile(join(outDir, artifact.name));
      const actualSha256 = createHash("sha256").update(buffer).digest("hex");
      assert.equal(actualSha256, artifact.sha256, `${artifact.name}'s recomputed sha256 must match the reported one`);
      assert.ok(checksumsText.includes(`${actualSha256}  ${artifact.name}`), `checksums.sha256 must list ${artifact.name}`);
    }
  });
});

test("the Chrome extension artifact contains the ES-module manifest and no forbidden paths", async () => {
  await withTempDir(async (dir) => {
    const result = await buildRelease(join(dir, "release"));
    const artifact = findArtifact(result, "chrome-extension-" + result.version + ".zip");
    const buffer = await readFile(join(dir, "release", artifact.name));
    const entries = readZipEntries(buffer);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("manifest.json"));
    assert.ok(names.includes("service-worker.js"));
    assert.deepEqual(names.filter((n) => LEAKED_ARTIFACT.test(n)), []);

    const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
    assert.equal(manifest.background.service_worker, "service-worker.js");
    assert.equal(manifest.version, result.version);
  });
});

test("the Firefox extension artifact contains the bundled background script and no forbidden paths", async () => {
  await withTempDir(async (dir) => {
    const result = await buildRelease(join(dir, "release"));
    const artifact = findArtifact(result, "firefox-extension-" + result.version + ".zip");
    const buffer = await readFile(join(dir, "release", artifact.name));
    const entries = readZipEntries(buffer);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("background.bundle.js"));
    assert.deepEqual(names.filter((n) => LEAKED_ARTIFACT.test(n)), []);

    const manifest = JSON.parse(entries.find((e) => e.name === "manifest.json").data.toString("utf8"));
    assert.deepEqual(manifest.background, { scripts: ["background.bundle.js"] });
    assert.equal(manifest.version, result.version);
  });
});

test("the source archive includes only service and extension runtime source plus documentation, excluding removed and local paths", async () => {
  await withTempDir(async (dir) => {
    const result = await buildRelease(join(dir, "release"));
    const artifact = findArtifact(result, "source-" + result.version + ".zip");
    const buffer = await readFile(join(dir, "release", artifact.name));
    const entries = readZipEntries(buffer);
    const names = entries.map((e) => e.name);
    const prefix = `browser-tabs-${result.version}/`;
    assert.ok(names.includes(`${prefix}service/server.mjs`));
    assert.ok(names.includes(`${prefix}extension/protocol.js`));
    assert.ok(names.includes(`${prefix}package.json`));
    assert.ok(names.includes(`${prefix}service/credential.mjs`));
    assert.ok(names.includes(`${prefix}docs/architecture.md`));
    assert.ok(names.includes(`${prefix}docs/refocus-plan.md`));
    assert.ok(!names.includes(`${prefix}docs/implementation-history.md`), "the historical diary is not shipped");
    // Removed features must not ship: the review UI, the agent client, and the
    // SQLite store and its routes.
    assert.deepEqual(
      names.filter((n) => /\/(ui|client|test)\/|\/service\/(store|store-routes|store-errors|validation|ui)\.mjs$/.test(n)),
      [],
    );
    assert.deepEqual(names.filter((n) => LEAKED_ARTIFACT.test(n)), []);
  });
});

test("two builds from the same source produce a byte-identical release directory", async () => {
  await withTempDir(async (dir) => {
    const first = await buildRelease(join(dir, "release-1"));
    await buildRelease(join(dir, "release-2"));
    const expectedFiles = [...first.artifacts.map((a) => a.name), "checksums.sha256", "manifest.json"].sort();
    assert.deepEqual((await readdir(join(dir, "release-1"))).sort(), expectedFiles);
    assert.deepEqual((await readdir(join(dir, "release-2"))).sort(), expectedFiles);
    for (const name of expectedFiles) {
      const a = await readFile(join(dir, "release-1", name));
      const b = await readFile(join(dir, "release-2", name));
      assert.ok(a.equals(b), `${name} must be byte-identical across repeated builds`);
    }
    const manifest = JSON.parse(await readFile(join(dir, "release-1", "manifest.json"), "utf8"));
    assert.ok(!("builtAt" in manifest), "the release manifest must not carry a build timestamp");
  });
});

test("an absolute custom output path is used as-is, not nested under the cwd", async () => {
  await withTempDir(async (dir) => {
    const outDir = join(dir, "abs", "out");
    assert.ok(isAbsolute(outDir));
    const result = await buildRelease(outDir);
    assert.equal(result.outDir, outDir);
    for (const artifact of result.artifacts) {
      await readFile(join(outDir, artifact.name));
    }
    // Nothing was created by joining the absolute path under the cwd.
    await assert.rejects(readdir(join(process.cwd(), outDir)), { code: "ENOENT" });
  });
});

test("a relative custom output path resolves against the cwd", async () => {
  await withTempDir(async (dir) => {
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const result = await buildRelease("rel-out");
      // realpath: on macOS the temp dir is reached through a /var -> /private/var symlink.
      assert.equal(await realpath(result.outDir), join(await realpath(dir), "rel-out"));
      await readFile(join(dir, "rel-out", "checksums.sha256"));
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("building never touches siblings of the output directory and leaves no staging directory behind", async () => {
  await withTempDir(async (dir) => {
    // The old implementation staged into `<outDir>/../extension-build` and
    // recursively cleared it, so a sibling with that name was destroyed.
    const sibling = join(dir, "extension-build");
    await mkdir(join(sibling, "chrome"), { recursive: true });
    await writeFile(join(sibling, "chrome", "keep.txt"), "precious", "utf8");
    await writeFile(join(sibling, "unrelated.txt"), "precious", "utf8");

    const outDir = join(dir, "release");
    await buildRelease(outDir);

    assert.equal(await readFile(join(sibling, "chrome", "keep.txt"), "utf8"), "precious");
    assert.equal(await readFile(join(sibling, "unrelated.txt"), "utf8"), "precious");
    assert.deepEqual((await readdir(dir)).sort(), ["extension-build", "release"]);
    // Only the declared release files land in outDir (no staging subtree).
    assert.ok(!(await readdir(outDir)).includes("extension-build"));
  });
});

test("a recognized prior release directory with injected stale files is replaced to exactly the clean output", async () => {
  await withTempDir(async (dir) => {
    const clean = await buildRelease(join(dir, "clean"));

    // A prior release (carries the format marker), then dirtied.
    const dirty = join(dir, "dirty");
    await buildRelease(dirty);
    await mkdir(join(dir, "dirty", "old-subdir", "nested"), { recursive: true });
    await writeFile(join(dirty, "stale.txt"), "stale", "utf8");
    await writeFile(join(dirty, "browser-tabs-chrome-extension-0.0.1.zip"), "prior archive", "utf8");
    await writeFile(join(dirty, "old-subdir", "nested", "x"), "x", "utf8");
    // A stale copy of a file this build also produces must be overwritten, not merged.
    await writeFile(join(dirty, "checksums.sha256"), "stale checksums", "utf8");
    // A symlink inside outDir is unlinked, never followed out of it.
    const outsideTarget = join(dir, "outside-target");
    await mkdir(outsideTarget);
    await writeFile(join(outsideTarget, "survivor.txt"), "survivor", "utf8");
    await symlink(outsideTarget, join(dirty, "link-out"));

    await buildRelease(dirty);

    const expected = [...clean.artifacts.map((a) => a.name), "checksums.sha256", "manifest.json"].sort();
    assert.deepEqual((await readdir(dirty)).sort(), expected);
    for (const name of expected) {
      assert.ok((await readFile(join(dir, "clean", name))).equals(await readFile(join(dirty, name))), `${name} must match the clean build`);
    }
    assert.equal(await readFile(join(outsideTarget, "survivor.txt"), "utf8"), "survivor");
  });
});

test("the release manifest carries a deterministic format marker, first, and nothing time-dependent", async () => {
  await withTempDir(async (dir) => {
    await buildRelease(join(dir, "a"));
    await buildRelease(join(dir, "b"));
    const textA = await readFile(join(dir, "a", "manifest.json"), "utf8");
    const textB = await readFile(join(dir, "b", "manifest.json"), "utf8");
    assert.equal(textA, textB);
    const manifest = JSON.parse(textA);
    assert.equal(RELEASE_FORMAT, "browser-tabs-release-v1");
    assert.equal(manifest.format, RELEASE_FORMAT);
    assert.equal(Object.keys(manifest)[0], "format");
  });
});

test("an arbitrary non-empty directory is refused and left completely untouched", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "documents");
    await mkdir(join(target, "sub"), { recursive: true });
    await writeFile(join(target, "important.txt"), "important", "utf8");
    await writeFile(join(target, "sub", "nested.txt"), "nested", "utf8");

    await assert.rejects(buildRelease(target), /not a recognized browser-tabs release/);

    assert.deepEqual((await readdir(target)).sort(), ["important.txt", "sub"]);
    assert.equal(await readFile(join(target, "important.txt"), "utf8"), "important");
    assert.equal(await readFile(join(target, "sub", "nested.txt"), "utf8"), "nested");
  });
});

test("a non-empty directory whose manifest.json lacks the marker, or is malformed, is refused without echoing its content", async () => {
  const secret = "SECRET-CONTENT-0123456789";
  const cases = [
    ["a manifest without the marker", JSON.stringify({ version: "1.0.0", artifacts: [], note: secret })],
    ["a manifest with the wrong marker", JSON.stringify({ format: `${secret}`, artifacts: [] })],
    ["a manifest with the marker but no artifacts array", JSON.stringify({ format: RELEASE_FORMAT, note: secret })],
    ["malformed JSON", `{ "format": "${secret}", `],
    ["a JSON scalar", JSON.stringify(secret)],
    ["a JSON null", "null"],
  ];
  for (const [label, manifestText] of cases) {
    await withTempDir(async (dir) => {
      const target = join(dir, "target");
      await mkdir(target);
      await writeFile(join(target, "manifest.json"), manifestText, "utf8");
      await writeFile(join(target, "keep.txt"), "keep", "utf8");

      let error;
      await assert.rejects(buildRelease(target), (thrown) => {
        error = thrown;
        return /not a recognized browser-tabs release/.test(thrown.message);
      }, label);
      assert.ok(!String(error.message).includes(secret), `${label}: the error must not echo manifest content`);
      assert.ok(!String(error.stack).includes(secret), `${label}: the stack must not echo manifest content`);
      assert.deepEqual((await readdir(target)).sort(), ["keep.txt", "manifest.json"], label);
      assert.equal(await readFile(join(target, "keep.txt"), "utf8"), "keep", label);
    });
  }
});

test("a non-empty directory with no manifest.json, or a manifest.json that is a directory, is refused", async () => {
  await withTempDir(async (dir) => {
    const noManifest = join(dir, "no-manifest");
    await mkdir(noManifest);
    await writeFile(join(noManifest, "a.txt"), "a", "utf8");
    await assert.rejects(buildRelease(noManifest), /not a recognized browser-tabs release/);
    assert.deepEqual(await readdir(noManifest), ["a.txt"]);

    const dirManifest = join(dir, "dir-manifest");
    await mkdir(join(dirManifest, "manifest.json"), { recursive: true });
    await assert.rejects(buildRelease(dirManifest), /not a recognized browser-tabs release/);
    assert.deepEqual(await readdir(dirManifest), ["manifest.json"]);
  });
});

test("an existing empty directory is accepted", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "empty");
    await mkdir(target);
    const result = await buildRelease(target);
    assert.equal((await readdir(target)).length, result.artifacts.length + 2);
  });
});

test("assertReplaceableOutDir accepts new, empty, and recognized directories only", async () => {
  await withTempDir(async (dir) => {
    await assertReplaceableOutDir(join(dir, "does-not-exist"));
    await mkdir(join(dir, "empty"));
    await assertReplaceableOutDir(join(dir, "empty"));
    await mkdir(join(dir, "recognized"));
    await writeFile(join(dir, "recognized", "manifest.json"), JSON.stringify({ format: RELEASE_FORMAT, artifacts: [] }), "utf8");
    await writeFile(join(dir, "recognized", "stale.bin"), "x", "utf8");
    await assertReplaceableOutDir(join(dir, "recognized"));
    await mkdir(join(dir, "other"));
    await writeFile(join(dir, "other", "x"), "x", "utf8");
    await assert.rejects(assertReplaceableOutDir(join(dir, "other")), /refusing/);
  });
});

test("a successful build leaves nothing behind in its staging root", async () => {
  await withTempDir(async (dir) => {
    const tempRoot = join(dir, "staging-root");
    await mkdir(tempRoot);
    await buildRelease(join(dir, "release"), { tempRoot });
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

test("a failed build preserves the previous output untouched and cleans up its staging directory", async () => {
  await withTempDir(async (dir) => {
    const outDir = join(dir, "release");
    const first = await buildRelease(outDir);
    await writeFile(join(outDir, "extra-user-file.txt"), "keep me", "utf8");
    const before = new Map();
    for (const name of await readdir(outDir)) before.set(name, await readFile(join(outDir, name)));

    const tempRoot = join(dir, "staging-root");
    await mkdir(tempRoot);
    // A source-archive entry that does not exist fails the build *after* the
    // extension staging work has already started.
    await assert.rejects(buildRelease(outDir, { tempRoot, sourceFiles: ["package.json", "no/such/file.txt"] }), { code: "ENOENT" });

    assert.deepEqual((await readdir(outDir)).sort(), [...before.keys()].sort());
    for (const [name, data] of before) {
      assert.ok(data.equals(await readFile(join(outDir, name))), `${name} must be unchanged after a failed build`);
    }
    assert.ok(first.artifacts.length === 3);
    assert.deepEqual(await readdir(tempRoot), []);
  });
});

test("assertSafeOutDir refuses the filesystem root, the cwd, the repository, and their ancestors", async () => {
  // Called directly (non-destructively): these are exactly the targets that
  // must never be emptied, so none of them is ever passed to buildRelease here.
  const dangerous = [
    parse(process.cwd()).root,
    process.cwd(),
    dirname(process.cwd()),
    REPO_ROOT,
    dirname(REPO_ROOT.replace(/[\\/]+$/, "")),
    homedir(),
    dirname(homedir()),
    tmpdir(),
    join(REPO_ROOT, "service"),
    join(REPO_ROOT, "extension"),
    join(REPO_ROOT, "build"),
    join(REPO_ROOT, "dist"),
    REPO_ROOT.replace(/[\\/]+$/, "") + "/../" + "browser-tabs",
  ];
  for (const target of dangerous) {
    await assert.rejects(assertSafeOutDir(target), /refusing/, `must refuse ${target}`);
  }
  // The default output location and an ordinary temp subdirectory are fine.
  await assertSafeOutDir(join(REPO_ROOT, "dist", "release"));
  await assertSafeOutDir(join(tmpdir(), "browser-tabs-release-safe-dir-that-does-not-exist"));
});

test("buildRelease refuses a protected outDir before touching it (private cwd / temp root stand-ins)", async () => {
  await withTempDir(async (dir) => {
    // The private temp root counts as "the system temp directory".
    const tempRoot = join(dir, "staging-root");
    await mkdir(tempRoot);
    await writeFile(join(tempRoot, "sentinel.txt"), "sentinel", "utf8");
    await assert.rejects(buildRelease(tempRoot, { tempRoot }), /refusing/);
    assert.equal(await readFile(join(tempRoot, "sentinel.txt"), "utf8"), "sentinel");

    // The cwd itself.
    const cwdDir = join(dir, "cwd");
    await mkdir(cwdDir);
    await writeFile(join(cwdDir, "sentinel.txt"), "sentinel", "utf8");
    const originalCwd = process.cwd();
    process.chdir(cwdDir);
    try {
      await assert.rejects(buildRelease(cwdDir), /refusing/);
      await assert.rejects(buildRelease("."), /refusing/);
      await assert.rejects(buildRelease(".."), /refusing/);
    } finally {
      process.chdir(originalCwd);
    }
    assert.equal(await readFile(join(cwdDir, "sentinel.txt"), "utf8"), "sentinel");
    assert.equal(await readFile(join(dir, "cwd", "sentinel.txt"), "utf8"), "sentinel");
  });
});

test("buildRelease refuses a symlink as outDir and leaves its target alone", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "real-target");
    await mkdir(target);
    await writeFile(join(target, "sentinel.txt"), "sentinel", "utf8");
    const link = join(dir, "link");
    await symlink(target, link);
    await assert.rejects(buildRelease(link), /refusing/);
    assert.deepEqual(await readdir(target), ["sentinel.txt"]);
  });
});

test("buildRelease refuses a regular file as outDir", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "a-file");
    await writeFile(file, "x", "utf8");
    await assert.rejects(buildRelease(file), /refusing/);
    assert.equal(await readFile(file, "utf8"), "x");
  });
});
