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

// Loads the persisted pairing credential, generating and storing a new one
// with user-only permissions on first run. Reusing an existing credential
// (rather than regenerating on every start) is what lets a service restart
// recover without re-pairing the extension.
//
// Race-safe and crash-safe: if two callers race to create the credential
// for the first time (e.g. two CLI invocations started at once), the
// exclusive `link()` below ensures only one of them actually creates the
// file; the loser reads back the winner's token instead of silently
// producing a second, inconsistent credential that would never match what
// the other process wrote. A process killed mid-write also cannot leave a
// partial or empty file at the real path, since the full token is always
// written to a private temp file first (see below).
export async function loadOrCreateCredential(dataDir = getDataDir()) {
  await ensureDataDir(dataDir);
  const credentialPath = getCredentialPath(dataDir);

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
