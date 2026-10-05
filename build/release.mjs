#!/usr/bin/env node
// Stage 6: "Produce a deterministic local release script" (project.md).
//
// Produces, under dist/release/:
//   browser-tabs-chrome-extension-<version>.zip    the Chrome package
//   browser-tabs-firefox-extension-<version>.zip   the Firefox package
//   browser-tabs-source-<version>.zip              service + extension
//                                                   source, enough to run
//                                                   `npm ci && npm run
//                                                   service -- start`
//   checksums.sha256                                sha256sum-format
//                                                   checksums of the three
//                                                   zips above
//   manifest.json                                   version + checksum +
//                                                   byte-size summary of
//                                                   every artifact
//
// No credential, database, or local data-directory path is ever read or
// included: every archive is built from an explicit allowlist of
// repository source files (see SOURCE_FILES below), never a directory walk
// over this checkout's actual working tree — so a stray local file (a real
// credential, a .db file, anything under ~/.browser-tabs) literally cannot
// end up in an artifact no matter what else happens to exist on disk. A
// defensive pattern check (FORBIDDEN_NAME_PATTERN) still runs over every
// included path as a second, independent guard.
//
// Determinism: build/zip.mjs's own writer fixes every entry's timestamp
// and always sorts entries by name, so byte-identical input content always
// produces a byte-identical zip (see that module's own header comment).
// manifest.json deliberately carries no build timestamp, so the whole
// output directory — zips, checksums.sha256, and manifest.json — is
// byte-identical across repeated builds of the same source.
// This script's own file reads are the only other source of ordering, and
// they are already explicit, fixed lists below, not a directory walk.
//
// Usage: node build/release.mjs [outDir]  (default outDir: dist/release;
// absolute or cwd-relative). All build work happens in a private temp
// directory, removed before this returns. Only after every artifact built
// successfully is outDir's content replaced, and outDir must be new, empty,
// or a prior release recognized by the `format` marker in its manifest.json
// (see assertReplaceableOutDir): any other non-empty directory is refused
// before anything is deleted. A recognized prior release is replaced
// wholesale (stale files, old archives removed), so the result is the same
// from a clean or a dirty release directory, and a failed build leaves the
// previous output intact. The filesystem root, the cwd, the repository, the
// home and temp directories (or any ancestor of them), repository
// directories outside dist/, and a symlink as outDir are refused too (see
// assertSafeOutDir).

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildChromeExtension, buildFirefoxExtension } from "./build-extension.mjs";
import { createDeterministicZip } from "./zip.mjs";
import { checkVersions } from "../scripts/check-versions.mjs";

export const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

// Never a directory walk: explicit, so nothing this project does not
// already know about by name can ever be swept into a release.
const SOURCE_FILES = [
  "package.json",
  "package-lock.json",
  "README.md",
  "project.md",
  "extension/manifest.json",
  "extension/manifest.firefox.json",
  "extension/service-worker.js",
  "extension/service-client.js",
  "extension/protocol.js",
  "extension/options.html",
  "extension/options.js",
  "service/server.mjs",
  "service/cli.mjs",
  "service/store.mjs",
  "service/store-routes.mjs",
  "service/store-errors.mjs",
  "service/validation.mjs",
  "service/credential.mjs",
  "service/ui.mjs",
  "client/browser-tabs-client.mjs",
  "client/cli.mjs",
  "ui/index.html",
  "ui/app.js",
  "ui/lib.mjs",
  "ui/styles.css",
];

const FORBIDDEN_NAME_PATTERN = /(^|\/)(credential|agent-token|.*\.db|.*\.db-\w+|.*\.pid|.*\.port)$/i;

function assertNoForbiddenNames(entries, label) {
  for (const { name } of entries) {
    if (FORBIDDEN_NAME_PATTERN.test(name)) {
      throw new Error(`refusing to build ${label}: entry "${name}" matches a forbidden credential/database/local-path pattern`);
    }
  }
}

async function readDirEntries(dir, baseDir = dir) {
  const entries = [];
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const fullPath = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      entries.push(...(await readDirEntries(fullPath, baseDir)));
    } else if (dirent.isFile()) {
      entries.push({ name: relative(baseDir, fullPath).split(sep).join("/"), fullPath });
    }
  }
  return entries;
}

async function zipDirectory(dir) {
  const entries = await readDirEntries(dir);
  const withData = await Promise.all(entries.map(async ({ name, fullPath }) => ({ name, data: await readFile(fullPath) })));
  assertNoForbiddenNames(withData, dir);
  return createDeterministicZip(withData);
}

async function zipSourceFiles(version, sourceFiles = SOURCE_FILES) {
  const entries = await Promise.all(
    sourceFiles.map(async (relPath) => ({ name: `browser-tabs-${version}/${relPath}`, data: await readFile(join(REPO_ROOT, relPath)) })),
  );
  assertNoForbiddenNames(entries, "source archive");
  return createDeterministicZip(entries);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isWithinOrEqual(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Resolves symlinks in the longest existing prefix of `path` (the path
// itself may not exist yet) so that, e.g., macOS's /var -> /private/var
// cannot make two spellings of the same directory compare unequal.
async function canonicalize(path) {
  const absolute = resolve(path);
  const missing = [];
  let existing = absolute;
  for (;;) {
    try {
      return join(await realpath(existing), ...missing);
    } catch (error) {
      const parent = dirname(existing);
      if (error?.code !== "ENOENT" || parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
}

// The release step empties `outDir` before writing into it, so refuse any
// target that is not obviously a dedicated output directory: the filesystem
// root, the current working directory, the repository, the user's home, the
// system temp directory — or any ancestor of those (which would contain
// them) — plus anything inside the repository other than strictly under
// `dist/`, and a symlink or non-directory at `outDir` itself.
export async function assertSafeOutDir(requestedOutDir, { tempRoot = tmpdir() } = {}) {
  const outDir = await canonicalize(requestedOutDir);
  if (dirname(outDir) === outDir) {
    throw new Error(`refusing to use the filesystem root as the release output directory`);
  }

  const protectedDirs = [
    ["the current working directory", process.cwd()],
    ["the repository", REPO_ROOT],
    ["the home directory", homedir()],
    ["the system temp directory", tempRoot],
  ];
  for (const [label, dir] of protectedDirs) {
    if (isWithinOrEqual(outDir, await canonicalize(dir))) {
      throw new Error(`refusing to use ${label} (or a directory containing it) as the release output directory`);
    }
  }

  const repoRoot = await canonicalize(REPO_ROOT);
  if (isWithinOrEqual(repoRoot, outDir)) {
    const distDir = join(repoRoot, "dist");
    if (!isWithinOrEqual(distDir, outDir) || outDir === distDir) {
      throw new Error("refusing to use a repository directory other than a subdirectory of dist/ as the release output directory");
    }
  }

  let info;
  try {
    info = await lstat(resolve(requestedOutDir));
  } catch (error) {
    if (error?.code === "ENOENT") return outDir;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("refusing to use a symlink or non-directory as the release output directory");
  }
  return outDir;
}

// Written as the first field of every release manifest.json. It is the
// marker that lets a later run recognize a directory as a previous browser-tabs
// release it may replace (see assertReplaceableOutDir).
export const RELEASE_FORMAT = "browser-tabs-release-v1";
const MAX_RECOGNIZED_MANIFEST_BYTES = 1024 * 1024;

// `outDir` is emptied before the new release is written, so only three kinds
// of target are acceptable: one that does not exist yet, an empty directory,
// or a directory whose manifest.json carries the RELEASE_FORMAT marker (a
// prior release, possibly with stale extra files). Any other non-empty
// directory — a user's Documents folder, a source tree — is refused before
// anything is deleted. Error text never includes any of the directory's
// content, including the manifest's.
export async function assertReplaceableOutDir(outDir) {
  let entries;
  try {
    entries = await readdir(outDir);
  } catch (error) {
    if (error?.code === "ENOENT") return; // new directory
    throw error;
  }
  if (entries.length === 0) return;

  const refusal = (reason) =>
    new Error(
      `refusing to replace a non-empty release output directory that is not a recognized browser-tabs release (${reason}); ` +
        "use a new or empty directory, or remove it yourself first",
    );

  const manifestPath = join(outDir, "manifest.json");
  let info;
  try {
    info = await lstat(manifestPath);
  } catch {
    throw refusal("no manifest.json");
  }
  if (!info.isFile() || info.size > MAX_RECOGNIZED_MANIFEST_BYTES) {
    throw refusal("manifest.json is not a regular file of plausible size");
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw refusal("manifest.json is not valid JSON");
  }
  if (manifest === null || typeof manifest !== "object" || manifest.format !== RELEASE_FORMAT || !Array.isArray(manifest.artifacts)) {
    throw refusal("manifest.json does not carry the release format marker");
  }
}

// Options (both for tests): `sourceFiles` overrides the source-archive
// allowlist, `tempRoot` overrides where the private staging directory is made.
export async function buildRelease(outDir = join(REPO_ROOT, "dist/release"), { sourceFiles = SOURCE_FILES, tempRoot = tmpdir() } = {}) {
  const { ok, mismatches, report } = await checkVersions();
  if (!ok) {
    throw new Error(`refusing to build a release with inconsistent versions: ${mismatches.join("; ")}`);
  }
  const version = report.productVersion;

  outDir = resolve(outDir);
  // Before any work, so a refused target is never touched.
  await assertSafeOutDir(outDir, { tempRoot });
  await assertReplaceableOutDir(outDir);

  // All build work happens inside a fresh private temp directory this call
  // created and owns — never a path derived from `outDir` — and the release
  // is assembled entirely in memory. `outDir` is not touched at all until
  // every artifact has been built successfully, so a failed build leaves any
  // previous output exactly as it was. The staging directory is always
  // removed, success or failure.
  const buildRoot = await mkdtemp(join(tempRoot, "browser-tabs-release-build-"));
  let files;
  let summaries;
  let releaseManifest;
  try {
    const chrome = await buildChromeExtension(join(buildRoot, "chrome"));
    const firefox = await buildFirefoxExtension(join(buildRoot, "firefox"));
    const artifacts = [
      { name: `browser-tabs-chrome-extension-${version}.zip`, data: await zipDirectory(chrome.outDir) },
      { name: `browser-tabs-firefox-extension-${version}.zip`, data: await zipDirectory(firefox.outDir) },
      { name: `browser-tabs-source-${version}.zip`, data: await zipSourceFiles(version, sourceFiles) },
    ];

    summaries = artifacts.map((a) => ({ name: a.name, sha256: sha256Hex(a.data), bytes: a.data.length }));
    summaries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    releaseManifest = {
      format: RELEASE_FORMAT,
      version,
      protocolVersion: report.protocolVersion,
      resultSchemaVersion: report.resultSchemaVersion,
      dbSchemaVersion: report.dbSchemaVersion,
      artifacts: summaries,
    };
    files = [
      ...artifacts,
      { name: "checksums.sha256", data: Buffer.from(summaries.map((s) => `${s.sha256}  ${s.name}\n`).join(""), "utf8") },
      { name: "manifest.json", data: Buffer.from(`${JSON.stringify(releaseManifest, null, 2)}\n`, "utf8") },
    ];
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }

  // Replace exactly `outDir`'s contents. Re-checked immediately before
  // deleting (the directory may have changed during the build): it is still
  // new, empty, or a recognized prior release. Whatever a recognized prior
  // release directory holds (stale files, old archives, subdirectories) is
  // removed — each entry individually, so a symlink is unlinked rather than
  // followed — and only the declared release files remain, making the result
  // independent of what was there.
  await assertSafeOutDir(outDir, { tempRoot });
  await assertReplaceableOutDir(outDir);
  await mkdir(outDir, { recursive: true });
  for (const entry of await readdir(outDir)) {
    await rm(join(outDir, entry), { recursive: true, force: true });
  }
  for (const file of files) {
    await writeFile(join(outDir, file.name), file.data);
  }

  return { outDir, version, artifacts: summaries, releaseManifest };
}

async function main() {
  // `resolve` keeps an absolute argument as-is and anchors a relative one at
  // the current working directory.
  const outDir = process.argv[2] ? resolve(process.cwd(), process.argv[2]) : undefined;
  const result = await buildRelease(outDir);
  console.log(`Built release v${result.version} at ${result.outDir}:`);
  for (const artifact of result.artifacts) {
    console.log(`  ${artifact.name}  ${artifact.bytes} bytes  sha256:${artifact.sha256}`);
  }
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
