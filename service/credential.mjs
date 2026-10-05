import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Resolved once per process from the environment so tests can point it at a
// temporary directory without touching the real user data directory.
export function getDataDir() {
  return process.env.BROWSER_TABS_DATA_DIR || join(homedir(), ".browser-tabs");
}

export function getCredentialPath(dataDir = getDataDir()) {
  return join(dataDir, "credential");
}

// Stage 4: a distinct, separately-stored credential for external-agent
// callers (project.md Stage 4 remediation: "a distinct scoped external-agent
// credential managed by the service"). This is a different token in a
// different file from the owner pairing credential above — never the same
// value, never derived from it — so revoking or rotating one has no effect
// on the other, and a leaked agent token cannot be used to authenticate as
// the owner. The owner credential above retains full, unscoped access; the
// agent credential is authorized only for the server-side allowlists in
// service/server.mjs (AGENT_ALLOWED_*).
export function getAgentCredentialPath(dataDir = getDataDir()) {
  return join(dataDir, "agent-token");
}

// Repairs permissions on an already-existing directory too, not just a
// freshly created one: `mkdir`'s `mode` option only takes effect when it
// actually creates the directory, so a pre-existing `~/.browser-tabs` left
// with looser permissions (an earlier version of this code, or a manual
// edit) would otherwise go uncorrected on every subsequent start.
export async function ensureDataDir(dataDir = getDataDir()) {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  return dataDir;
}

async function readExistingCredential(credentialPath) {
  try {
    const token = (await readFile(credentialPath, "utf8")).trim();
    if (!token) return null;
    // Repair permissions on every load, not only at creation, in case an
    // existing file was left with looser permissions.
    await chmod(credentialPath, 0o600);
    return token;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Loads the persisted credential at `credentialPath`, generating and storing
// a new one with user-only permissions on first run. Reusing an existing
// credential (rather than regenerating on every start) is what lets a
// service restart recover without re-pairing the extension or re-issuing an
// external-agent token. Factored out so the owner credential
// (loadOrCreateCredential) and the Stage 4 external-agent credential
// (loadOrCreateAgentCredential) below share the exact same race-safe,
// crash-safe generation logic against two different, independent files —
// never the same file, never one derived from the other.
//
// Race-safe and crash-safe: if two callers race to create the credential
// for the first time (e.g. two CLI invocations started at once), the
// exclusive `link()` below ensures only one of them actually creates the
// file; the loser reads back the winner's token instead of silently
// producing a second, inconsistent credential that would never match what
// the other process wrote. A process killed mid-write also cannot leave a
// partial or empty file at the real path, since the full token is always
// written to a private temp file first (see below).
async function loadOrCreateCredentialAt(credentialPath) {
  const existing = await readExistingCredential(credentialPath);
  if (existing) return { token: existing, created: false };

  const token = randomBytes(32).toString("hex");
  // Write the full token to a private, uniquely-named temp file first, so a
  // process killed or interrupted mid-write can never leave a partial (or
  // empty) file visible under the real credential path — nothing is ever
  // written directly to `credentialPath`. Then `link()` it into place:
  // unlike `rename()`, a hard link fails with EEXIST instead of silently
  // overwriting a winner that raced us to create it first, so this keeps
  // the exact same race-safety as before while adding crash-safety.
  const tempPath = `${credentialPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tempPath, token, { mode: 0o600 });
    try {
      await link(tempPath, credentialPath);
      await chmod(credentialPath, 0o600);
      return { token, created: true };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Another process created it first, between our read and our link;
      // defer to whatever actually landed on disk so every caller ends up
      // agreeing on the same credential.
      const winner = await readExistingCredential(credentialPath);
      if (winner) return { token: winner, created: false };
      throw error;
    }
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

export async function loadOrCreateCredential(dataDir = getDataDir()) {
  await ensureDataDir(dataDir);
  return loadOrCreateCredentialAt(getCredentialPath(dataDir));
}

// Stage 4: loads (or, on first use, generates) the separate external-agent
// credential — a distinct file, a distinct random token, never shared with
// or derived from the owner credential above. Called independently from
// `loadOrCreateCredential` so an operator who never intends to allow an
// external agent never has one implicitly created merely by starting the
// service in a way that happens to touch this function; service/cli.mjs
// calls both unconditionally on `start`, matching the owner credential's own
// "always present once the service has started" behavior, but the two
// remain fully independent on disk and in memory.
export async function loadOrCreateAgentCredential(dataDir = getDataDir()) {
  await ensureDataDir(dataDir);
  return loadOrCreateCredentialAt(getAgentCredentialPath(dataDir));
}
