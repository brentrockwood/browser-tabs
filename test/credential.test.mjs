import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureDataDir,
  getAgentCredentialPath,
  getCredentialPath,
  loadOrCreateAgentCredential,
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

// Stage 4: the external-agent credential is a distinct file with a
// distinct value, generated and managed with the exact same race-safe,
// crash-safe, permission-repairing lifecycle as the owner credential above
// — but the two must never be the same value, and clearing/rotating one
// must never affect the other.
test("the external-agent credential is a distinct file and a distinct value from the owner credential, with user-only permissions on first run", async () => {
  await withTempDataDir(async (dataDir) => {
    const owner = await loadOrCreateCredential(dataDir);
    const agent = await loadOrCreateAgentCredential(dataDir);

    assert.notEqual(getAgentCredentialPath(dataDir), getCredentialPath(dataDir));
    assert.notEqual(agent.token, owner.token);
    assert.equal(agent.created, true);
    assert.match(agent.token, /^[0-9a-f]{64}$/);

    const info = await stat(getAgentCredentialPath(dataDir));
    assert.equal(info.mode & 0o777, 0o600);

    // The owner credential's own file must be completely unaffected by
    // having also created an agent credential in the same data directory.
    const ownerAfter = await loadOrCreateCredential(dataDir);
    assert.equal(ownerAfter.token, owner.token);
    assert.equal(ownerAfter.created, false);
  });
});

test("reuses an existing external-agent credential instead of regenerating it", async () => {
  await withTempDataDir(async (dataDir) => {
    const first = await loadOrCreateAgentCredential(dataDir);
    const second = await loadOrCreateAgentCredential(dataDir);
    assert.equal(second.created, false);
    assert.equal(second.token, first.token);
  });
});

test("repairs an existing external-agent credential file left with looser permissions", async () => {
  await withTempDataDir(async (dataDir) => {
    const { token } = await loadOrCreateAgentCredential(dataDir);
    await chmod(getAgentCredentialPath(dataDir), 0o644);

    const repaired = await loadOrCreateAgentCredential(dataDir);
    assert.equal(repaired.token, token);

    const fileInfo = await stat(getAgentCredentialPath(dataDir));
    assert.equal(fileInfo.mode & 0o777, 0o600);
  });
});

test("creates the external-agent credential exactly once under concurrent, racing callers, independent of the owner credential", async () => {
  await withTempDataDir(async (dataDir) => {
    const [ownerResults, agentResults] = await Promise.all([
      Promise.all(Array.from({ length: 4 }, () => loadOrCreateCredential(dataDir))),
      Promise.all(Array.from({ length: 4 }, () => loadOrCreateAgentCredential(dataDir))),
    ]);
    const ownerTokens = new Set(ownerResults.map((result) => result.token));
    const agentTokens = new Set(agentResults.map((result) => result.token));
    assert.equal(ownerTokens.size, 1);
    assert.equal(agentTokens.size, 1);
    assert.notEqual([...ownerTokens][0], [...agentTokens][0]);
  });
});
