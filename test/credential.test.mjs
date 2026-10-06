import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureDataDir,
  getCredentialPath,
  loadOrCreateCredential,
} from "../service/credential.mjs";

async function withTempDataDir(run) {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-credential-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("generates a new credential with user-only permissions on first run", async () => {
  await withTempDataDir(async (dataDir) => {
    const { token, created } = await loadOrCreateCredential(dataDir);
    assert.equal(created, true);
    assert.match(token, /^[0-9a-f]{64}$/);

    const info = await stat(getCredentialPath(dataDir));
    assert.equal(info.mode & 0o777, 0o600);
  });
});

test("reuses an existing credential instead of regenerating it", async () => {
  await withTempDataDir(async (dataDir) => {
    const first = await loadOrCreateCredential(dataDir);
    const second = await loadOrCreateCredential(dataDir);
    assert.equal(second.created, false);
    assert.equal(second.token, first.token);
  });
});

test("repairs an existing data directory and credential file left with looser permissions", async () => {
  await withTempDataDir(async (dataDir) => {
    const { token } = await loadOrCreateCredential(dataDir);
    // Simulate a directory/file created by an earlier, buggy version, or
    // loosened by hand.
    await chmod(dataDir, 0o755);
    await chmod(getCredentialPath(dataDir), 0o644);

    const repaired = await loadOrCreateCredential(dataDir);
    assert.equal(repaired.token, token);

    const dirInfo = await stat(dataDir);
    assert.equal(dirInfo.mode & 0o777, 0o700);
    const fileInfo = await stat(getCredentialPath(dataDir));
    assert.equal(fileInfo.mode & 0o777, 0o600);
  });
});

test("ensureDataDir alone also repairs a pre-existing directory's permissions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "browser-tabs-credential-"));
  try {
    await rm(dataDir, { recursive: true, force: true });
    await mkdir(dataDir, { mode: 0o777 });
    await ensureDataDir(dataDir);
    const info = await stat(dataDir);
    assert.equal(info.mode & 0o777, 0o700);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("creates the credential exactly once under concurrent, racing callers", async () => {
  await withTempDataDir(async (dataDir) => {
    const results = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateCredential(dataDir)));
    const tokens = new Set(results.map((result) => result.token));
    assert.equal(tokens.size, 1, "every concurrent caller must agree on the same token");
    assert.equal(results.filter((result) => result.created).length, 1, "exactly one caller creates it");

    const onDisk = await loadOrCreateCredential(dataDir);
    assert.equal(onDisk.token, [...tokens][0]);
  });
});

// The service has one pairing credential. An `agent-token` file left by an
// earlier version is neither created, read, changed, nor deleted.
test("loading the pairing credential leaves an obsolete agent-token file untouched and never creates one", async () => {
  await withTempDataDir(async (dataDir) => {
    await loadOrCreateCredential(dataDir);
    assert.deepEqual(await readdir(dataDir), ["credential"]);

    const obsolete = join(dataDir, "agent-token");
    await writeFile(obsolete, "obsolete-agent-token", { mode: 0o644 });
    const again = await loadOrCreateCredential(dataDir);
    assert.equal(again.created, false);
    assert.equal(await readFile(obsolete, "utf8"), "obsolete-agent-token");
    assert.equal((await stat(obsolete)).mode & 0o777, 0o644);
  });
});
