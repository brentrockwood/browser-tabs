// Stage 3: the service-owned SQLite derived store (project.md "Add the
// derived store"). Uses Node's built-in `node:sqlite` (DatabaseSync) —
// deliberately no ORM, per project.md's implementation defaults. All
// read/write access goes through parameterized `?` placeholders (never
// string-concatenated SQL for a caller-controlled value), and every write
// that touches more than one statement runs inside an explicit transaction
// (see runInTransaction below) so a failure midway always rolls back rather
// than partially applying.
import { copyFileSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ALLOWED_RESULT_STATUSES } from "../extension/protocol.js";
import { STORE_ERROR_CODES, StoreError, toStoreError } from "./store-errors.mjs";
import {
  ACTION_INTERRUPTED_CODE,
  ACTION_INTERRUPTED_DETAIL,
  ACTION_STATES,
  CREATOR_TYPES,
  MAX_ACTION_AUDIT_EVENTS,
  MAX_PENDING_ACTIONS,
  MAX_STATE_LENGTH,
  PROPOSAL_KINDS,
  PROPOSAL_STATES,
  RECORD_TYPES_CAPTURE_SUMMARY,
  RECORD_TYPES_QUEUEABLE,
  optionalFilterEnum,
  optionalFilterNonNegativeInteger,
  optionalFilterPositiveInteger,
  optionalFilterString,
  requireRecordFilterPairOrNeither,
  validateActionPreviewInput,
  validateActionResultInput,
  validateCaptureInput,
  validateCaptureReadInput,
  validateCollectionCreateInput,
  validateCollectionItemInput,
  validateCollectionReorderInput,
  validateCollectionUpdateInput,
  validateLimitOffset,
  validateProposalCreateInput,
  validateProposalUpdateInput,
  validateQueueCreateInput,
  validateQueueUpdateInput,
  validateRetentionUpdateInput,
  validateSummaryCreateInput,
  validateSummaryUpdateInput,
  validateTagAssignmentInput,
  validateTagCreateInput,
  validateTagUnassignmentInput,
} from "./validation.mjs";

export const DATABASE_FILE_NAME = "browser-tabs.db";

// Loaded lazily (not a static top-level import) so that importing this
// module — and anything that merely re-exports from it, like the route
// table — never itself throws on a Node runtime without `node:sqlite`;
// only actually opening a store does. Cached after the first successful
// load.
let cachedDatabaseSync = null;
async function loadDatabaseSync() {
  if (cachedDatabaseSync) return cachedDatabaseSync;
  try {
    ({ DatabaseSync: cachedDatabaseSync } = await import("node:sqlite"));
  } catch (error) {
    throw new StoreError(
      STORE_ERROR_CODES.DB_ERROR,
      "node:sqlite is not available in this Node.js runtime. Browser Tabs requires Node.js 24 or later. " +
        `Underlying error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return cachedDatabaseSync;
}

function nowMs() {
  return Date.now();
}

// Every multi-statement write goes through this: BEGIN IMMEDIATE (acquires
// the write lock up front rather than at the first write statement, so two
// concurrent writers fail fast instead of deadlocking), then either COMMIT
// on success or ROLLBACK on any failure — a thrown validation error, a
// foreign-key violation, a uniqueness violation, or anything unexpected.
// Nothing is ever left partially applied. Errors are normalized to a
// StoreError with a stable code before leaving this function.
function runInTransaction(db, fn, errorOptions) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The transaction may already have been implicitly rolled back by
      // SQLite itself (e.g. after certain constraint failures); a failing
      // ROLLBACK here must never mask the original error below.
    }
    throw toStoreError(error, errorOptions);
  }
}

// The captured/derived table definitions shared by migration v1 (a
// brand-new database) and migration v2's reset-and-rebuild path (an
// existing, pre-v2 database — see MIGRATIONS below) — one definition of
// "the correct schema," never two that could drift apart. Deliberately
// excludes `retention_settings`: that table is service configuration, not
// captured/derived browser content, and survives v2's reset untouched.
function coreTablesSql() {
  return `
        CREATE TABLE captures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          browser_session_id TEXT NOT NULL,
          source_operation TEXT NOT NULL,
          window_id INTEGER,
          tab_id INTEGER,
          url TEXT,
          title TEXT,
          captured_at INTEGER NOT NULL,
          status TEXT NOT NULL,
          character_count INTEGER,
          returned_character_count INTEGER,
          truncated INTEGER,
          text TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_captures_captured_at ON captures(captured_at);

        CREATE TABLE summaries (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          creator_type TEXT NOT NULL CHECK (creator_type IN ('user','client','agent')),
          creator_name TEXT,
          model_metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- A summary's source captures. capture_id is ON DELETE RESTRICT (not
        -- CASCADE): a capture is evidence, and deleting it out from under a
        -- summary that cites it is refused by default (see deleteCapture's
        -- documented cascade option below) rather than silently orphaning
        -- the summary's provenance.
        CREATE TABLE summary_sources (
          summary_id INTEGER NOT NULL REFERENCES summaries(id) ON DELETE CASCADE,
          capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
          PRIMARY KEY (summary_id, capture_id)
        );
        CREATE INDEX idx_summary_sources_capture ON summary_sources(capture_id);

        CREATE TABLE tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          creator_type TEXT NOT NULL CHECK (creator_type IN ('user','client','agent')),
          creator_name TEXT,
          created_at INTEGER NOT NULL
        );

        -- A tag assignment is a label link, not evidence: unlike
        -- summary_sources above, capture_id/summary_id are ON DELETE
        -- CASCADE, so deleting the tagged record (or the tag itself) simply
        -- removes the link.
        CREATE TABLE tag_assignments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          capture_id INTEGER REFERENCES captures(id) ON DELETE CASCADE,
          summary_id INTEGER REFERENCES summaries(id) ON DELETE CASCADE,
          creator_type TEXT NOT NULL CHECK (creator_type IN ('user','client','agent')),
          creator_name TEXT,
          created_at INTEGER NOT NULL,
          CHECK ((capture_id IS NOT NULL) + (summary_id IS NOT NULL) = 1)
        );
        -- Two partial unique indexes, not one unique index over all three
        -- columns: SQLite (standard SQL) treats every NULL as distinct from
        -- every other NULL in a unique index, so a single
        -- UNIQUE(tag_id, capture_id, summary_id) index would never actually
        -- reject a second identical (tag_id, capture_id) assignment — both
        -- rows would have summary_id = NULL, and NULL <> NULL for
        -- uniqueness purposes. Each partial index below only indexes rows
        -- where its own column is actually set, so it correctly enforces
        -- "this tag is assigned to this capture at most once" and
        -- "...to this summary at most once" independently.
        CREATE UNIQUE INDEX idx_tag_assignments_unique_capture ON tag_assignments(tag_id, capture_id) WHERE capture_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_tag_assignments_unique_summary ON tag_assignments(tag_id, summary_id) WHERE summary_id IS NOT NULL;
        CREATE INDEX idx_tag_assignments_capture ON tag_assignments(capture_id);
        CREATE INDEX idx_tag_assignments_summary ON tag_assignments(summary_id);

        CREATE TABLE collections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          creator_type TEXT NOT NULL CHECK (creator_type IN ('user','client','agent')),
          creator_name TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- Ordered membership (project.md: "collection: ... ordered
        -- membership"). Same link-not-evidence cascade reasoning as
        -- tag_assignments. 'position' is unique per collection so the order
        -- is always well-defined; reorderCollectionItems below updates it
        -- in two phases to avoid transient collisions.
        CREATE TABLE collection_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
          capture_id INTEGER REFERENCES captures(id) ON DELETE CASCADE,
          summary_id INTEGER REFERENCES summaries(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          creator_type TEXT NOT NULL CHECK (creator_type IN ('user','client','agent')),
          creator_name TEXT,
          created_at INTEGER NOT NULL,
          CHECK ((capture_id IS NOT NULL) + (summary_id IS NOT NULL) = 1)
        );
        CREATE UNIQUE INDEX idx_collection_items_position ON collection_items(collection_id, position);
        CREATE INDEX idx_collection_items_capture ON collection_items(capture_id);
        CREATE INDEX idx_collection_items_summary ON collection_items(summary_id);

        CREATE TABLE proposals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK (kind IN ('tag','collection','queue','browser_action')),
          rationale TEXT NOT NULL,
          payload TEXT NOT NULL,
          creator_type TEXT NOT NULL CHECK (creator_type IN ('user','client','agent')),
          creator_name TEXT,
          state TEXT NOT NULL CHECK (state IN ('pending','accepted','rejected')) DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          decided_at INTEGER
        );

        -- A proposal's cited evidence. Same RESTRICT-by-default reasoning as
        -- summary_sources: a proposal's rationale is only as trustworthy as
        -- the evidence it cites, so deleting cited evidence out from under
        -- a proposal is refused by default too.
        CREATE TABLE proposal_sources (
          proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
          capture_id INTEGER REFERENCES captures(id) ON DELETE RESTRICT,
          summary_id INTEGER REFERENCES summaries(id) ON DELETE RESTRICT,
          CHECK ((capture_id IS NOT NULL) + (summary_id IS NOT NULL) = 1)
        );
        -- Same NULL-distinctness reasoning as idx_tag_assignments above:
        -- two partial unique indexes, not one unique index over all three
        -- columns.
        CREATE UNIQUE INDEX idx_proposal_sources_unique_capture ON proposal_sources(proposal_id, capture_id) WHERE capture_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_proposal_sources_unique_summary ON proposal_sources(proposal_id, summary_id) WHERE summary_id IS NOT NULL;
        CREATE INDEX idx_proposal_sources_capture ON proposal_sources(capture_id);
        CREATE INDEX idx_proposal_sources_summary ON proposal_sources(summary_id);

        -- A queue item points at exactly one of a capture, summary, or
        -- proposal (record_type names which column is set); link-not-
        -- evidence cascade reasoning again, same as tag_assignments.
        CREATE TABLE queue_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_type TEXT NOT NULL CHECK (record_type IN ('capture','summary','proposal')),
          capture_id INTEGER REFERENCES captures(id) ON DELETE CASCADE,
          summary_id INTEGER REFERENCES summaries(id) ON DELETE CASCADE,
          proposal_id INTEGER REFERENCES proposals(id) ON DELETE CASCADE,
          state TEXT NOT NULL,
          creator_type TEXT NOT NULL CHECK (creator_type IN ('user','client','agent')),
          creator_name TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK ((capture_id IS NOT NULL) + (summary_id IS NOT NULL) + (proposal_id IS NOT NULL) = 1)
        );
        CREATE INDEX idx_queue_items_capture ON queue_items(capture_id);
        CREATE INDEX idx_queue_items_summary ON queue_items(summary_id);
        CREATE INDEX idx_queue_items_proposal ON queue_items(proposal_id);
  `;
}

// Forward-only schema migrations. Each entry's `apply(db, context)` runs
// inside the same transaction as its own `schema_migrations` bookkeeping
// row (see runMigrations), so a failed migration never leaves that table
// out of sync with the schema it claims to describe. `breaking: true` means
// "back up the database file first if applying this to a database that
// already had at least one migration applied before this openStore() call"
// — see runMigrations. `context.startingVersion` is the schema version that
// was already on disk *before this openStore() call touched anything* (0
// for a brand-new database); migration v2 below uses it to decide between
// its two paths. Migration v2 is a real, breaking migration (not a
// fabricated test fixture); test/store.test.mjs exercises the backup path
// against this actual list, not a stand-in.
export const MIGRATIONS = [
  {
    version: 1,
    breaking: false,
    apply: (db) => {
      db.exec(coreTablesSql());
      // Singleton row (id is CHECK'd to 1): retention policy applied by
      // runRetentionCleanup below. NULL capture_retention_days means
      // retention cleanup is disabled (the default: never delete anything
      // automatically). Not part of coreTablesSql: this is service
      // configuration, not captured/derived browser content, and must
      // survive migration v2's reset path below untouched.
      db.exec(`
        CREATE TABLE retention_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          capture_retention_days INTEGER,
          updated_at INTEGER NOT NULL
        );
      `);
      db.prepare("INSERT INTO retention_settings (id, capture_retention_days, updated_at) VALUES (1, NULL, ?)").run(nowMs());
    },
  },
  {
    // Remediation pass: captures previously accepted caller-invented
    // "evidence" shapes (any sourceOperation, no code/detail/schemaVersion/
    // documentReadyState) rather than a validated Stage 2 browser.read_tab
    // result, tag/proposal-source uniqueness used a single NULL-distinct-
    // prone whole-row index that never actually rejected a duplicate
    // assignment, and proposal decisions carried no decider identity.
    //
    // This must remediate whatever the *actual* pre-remediation schema on
    // disk looks like, not merely re-apply today's already-corrected v1
    // definition (coreTablesSql, above, already has the fixed partial
    // indexes — a database that only ever ran *this* v1 has nothing left
    // to fix there). Stage 3 has never been published, so there is no real
    // deployed database whose captures/derived data must be preserved
    // across this remediation: rather than attempt to surgically repair an
    // unknown legacy shape in place (which could silently leave an old
    // whole-row unique index around, or leave an invalid caller-invented
    // capture or a no-decider "accepted" proposal sitting in the new
    // schema), this is a documented, breaking pre-release reset.
    //
    // `context.startingVersion > 0` means this database already had at
    // least one migration applied *before this openStore() call* — i.e. it
    // is a genuinely pre-existing database, not merely "v1 ran a moment
    // ago in this same call" (runMigrations' backup decision uses the same
    // signal). In that case every captured/derived table is dropped and
    // recreated from the same, single `coreTablesSql()` definition used
    // for a brand-new database — which also removes any old NULL-
    // distinct-prone index, since DROP TABLE drops the indexes built on
    // top of it — before the new columns are added. `retention_settings`
    // and `schema_migrations` are left alone: they are service
    // configuration/bookkeeping, not captured/derived browser content.
    // `runMigrations` already backs up the file first in this case, so the
    // pre-reset data is not destroyed, only no longer live.
    //
    // If `startingVersion` is 0, v1 just created brand-new, empty tables
    // moments ago within this same call — there is nothing to reset, so
    // only the new columns are added, exactly as before. Fresh-install
    // behavior is unchanged by this migration.
    version: 2,
    breaking: true,
    apply: (db, { startingVersion } = {}) => {
      if (startingVersion > 0) {
        db.exec(`
          DROP TABLE IF EXISTS queue_items;
          DROP TABLE IF EXISTS tag_assignments;
          DROP TABLE IF EXISTS collection_items;
          DROP TABLE IF EXISTS proposal_sources;
          DROP TABLE IF EXISTS summary_sources;
          DROP TABLE IF EXISTS proposals;
          DROP TABLE IF EXISTS summaries;
          DROP TABLE IF EXISTS tags;
          DROP TABLE IF EXISTS collections;
          DROP TABLE IF EXISTS captures;
        `);
        db.exec(coreTablesSql());
      }
      db.exec(`
        ALTER TABLE captures ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE captures ADD COLUMN document_ready_state TEXT;
        ALTER TABLE captures ADD COLUMN code TEXT;
        ALTER TABLE captures ADD COLUMN detail TEXT;
        ALTER TABLE proposals ADD COLUMN decided_by_creator_type TEXT CHECK (decided_by_creator_type IN ('user','client','agent'));
        ALTER TABLE proposals ADD COLUMN decided_by_creator_name TEXT;
      `);
    },
  },
  {
    // Phase 2 Action 1: browser actions and their audit log. Purely additive
    // (two new tables), so not breaking and no backup is taken.
    //
    // `actions` holds each previewed operation — the exact normalized URL,
    // the browser session it was previewed in, and when — and walks one
    // state machine, enforced by the store's conditional UPDATEs and, as a
    // backstop, by the triggers below: what a preview bound can never be
    // rewritten, and a terminal state can never change. It also holds the
    // observed result (untrusted browser content, clipped), so
    // `store.clear` deletes it like any other retained browser content.
    //
    // `action_audit` is append-only, enforced by triggers: no UPDATE and no
    // DELETE, ever, including from `store.clear` (it carries no browser
    // content — see appendActionAudit in openStore for what an event holds).
    // `action_id` is deliberately not a foreign key, so clearing the
    // action records never touches, or is blocked by, the audit trail.
    version: 3,
    breaking: false,
    apply: (db) => {
      db.exec(`
        CREATE TABLE actions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK (kind IN ('open_tab')),
          url TEXT NOT NULL,
          browser_session_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('previewed','approved','rejected','executed','partial','stale','failed')),
          previewed_at INTEGER NOT NULL,
          decided_at INTEGER,
          completed_at INTEGER,
          result TEXT
        );
        CREATE INDEX idx_actions_state ON actions(state);

        CREATE TRIGGER actions_bound_fields_immutable
        BEFORE UPDATE OF kind, url, browser_session_id, previewed_at ON actions
        BEGIN
          SELECT RAISE(ABORT, 'a previewed action''s kind, url, session, and timestamp are immutable');
        END;
        CREATE TRIGGER actions_terminal_state_immutable
        BEFORE UPDATE OF state ON actions
        WHEN OLD.state NOT IN ('previewed','approved')
        BEGIN
          SELECT RAISE(ABORT, 'a terminal action state cannot change');
        END;

        CREATE TABLE action_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          action_id INTEGER NOT NULL,
          event TEXT NOT NULL CHECK (event IN ('preview','approve','reject','result')),
          occurred_at INTEGER NOT NULL,
          detail TEXT NOT NULL
        );
        CREATE INDEX idx_action_audit_action ON action_audit(action_id);

        CREATE TRIGGER action_audit_no_update
        BEFORE UPDATE ON action_audit
        BEGIN
          SELECT RAISE(ABORT, 'the action audit log is append-only');
        END;
        CREATE TRIGGER action_audit_no_delete
        BEFORE DELETE ON action_audit
        BEGIN
          SELECT RAISE(ABORT, 'the action audit log is append-only');
        END;
      `);
    },
  },
  {
    // Phase 2 Action 2: a second action kind, `configure_group`. A CHECK
    // constraint cannot be altered in place, so `actions` is rebuilt — in this
    // migration's own transaction, so it either completes or leaves the v3 table
    // untouched — with the kind list widened, `url` nullable (a group action has
    // none), and a new `binding` column holding the group preview's exact handles
    // and bound state as JSON. Existing rows are copied unchanged. An
    // AUTOINCREMENT counter lives in `sqlite_sequence` and would otherwise reset
    // (dropping the old table deletes its entry), re-using ids that the
    // append-only audit log already refers to: it is carried over explicitly.
    // `action_audit` is not touched. Not marked breaking: nothing is lost, so no
    // backup copy of the database (and the browser content in it) is made.
    version: 4,
    breaking: false,
    apply: (db) => {
      db.exec(`
        CREATE TABLE actions_v4 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          kind TEXT NOT NULL CHECK (kind IN ('open_tab','configure_group')),
          url TEXT,
          binding TEXT,
          browser_session_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('previewed','approved','rejected','executed','partial','stale','failed')),
          previewed_at INTEGER NOT NULL,
          decided_at INTEGER,
          completed_at INTEGER,
          result TEXT,
          CHECK (
            (kind = 'open_tab' AND url IS NOT NULL AND binding IS NULL) OR
            (kind = 'configure_group' AND url IS NULL AND binding IS NOT NULL)
          )
        );
        INSERT INTO actions_v4 (id, kind, url, browser_session_id, state, previewed_at, decided_at, completed_at, result)
          SELECT id, kind, url, browser_session_id, state, previewed_at, decided_at, completed_at, result FROM actions;
        DELETE FROM sqlite_sequence WHERE name = 'actions_v4';
        INSERT INTO sqlite_sequence (name, seq) SELECT 'actions_v4', seq FROM sqlite_sequence WHERE name = 'actions';
        DROP TABLE actions;
        ALTER TABLE actions_v4 RENAME TO actions;
        CREATE INDEX idx_actions_state ON actions(state);

        CREATE TRIGGER actions_bound_fields_immutable
        BEFORE UPDATE OF kind, url, binding, browser_session_id, previewed_at ON actions
        BEGIN
          SELECT RAISE(ABORT, 'a previewed action''s kind, url, binding, session, and timestamp are immutable');
        END;
        CREATE TRIGGER actions_terminal_state_immutable
        BEFORE UPDATE OF state ON actions
        WHEN OLD.state NOT IN ('previewed','approved')
        BEGIN
          SELECT RAISE(ABORT, 'a terminal action state cannot change');
        END;
      `);
    },
  },
];

// Copies the database file aside before an incompatible migration is
// applied to an already-migrated database (project.md Stage 3: "back up the
// database before incompatible migrations"). Exported so it can also be
// tested directly, independent of the migration path that triggers it in
// practice (runMigrations, below, for migration v2).
export function backupDatabase(dbPath) {
  const backupPath = `${dbPath}.bak-${nowMs()}`;
  copyFileSync(dbPath, backupPath);
  return backupPath;
}

// Exported so a test can apply a *subset* of MIGRATIONS directly (e.g. only
// v1) to set up a database that genuinely predates a later migration,
// without this module needing any other test-only API — the real
// `openStore` path always calls this with the full, real `MIGRATIONS` list
// (the default), so production behavior is unaffected by this parameter
// existing.
export function runMigrations(db, dbPath, log, migrations = MIGRATIONS) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get();
  // Captured once, before this call touches anything: whether a breaking
  // migration needs to back up the database depends on whether *this
  // database* already existed (with at least one migration applied)
  // *before this openStore() call*, not on how many migrations this one
  // call ends up applying. Using the mutated `currentVersion` below for
  // that check instead would wrongly back up a brand-new database that
  // simply happens to need two migrations (v1, then a breaking v2) to
  // reach its very first schema — there is nothing to protect yet in that
  // case, since nothing could have written data between v1 and v2 within
  // the same call.
  const startingVersion = row?.version ?? 0;
  let currentVersion = startingVersion;

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;

    if (startingVersion > 0 && migration.breaking) {
      const backupPath = backupDatabase(dbPath);
      log(`backed up database to ${backupPath} before applying migration v${migration.version}`);
    }

    runInTransaction(db, () => {
      migration.apply(db, { startingVersion });
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(migration.version, nowMs());
    });
    currentVersion = migration.version;
    log(`applied migration v${migration.version}`);
  }
}

function toBool(value) {
  return value === null || value === undefined ? null : Boolean(value);
}

function rowToCapture(row) {
  return {
    id: row.id,
    browserSessionId: row.browser_session_id,
    sourceOperation: row.source_operation,
    schemaVersion: row.schema_version,
    windowId: row.window_id,
    tabId: row.tab_id,
    url: row.url,
    title: row.title,
    documentReadyState: row.document_ready_state,
    capturedAt: row.captured_at,
    status: row.status,
    characterCount: row.character_count,
    returnedCharacterCount: row.returned_character_count,
    truncated: toBool(row.truncated),
    text: row.text,
    code: row.code,
    detail: row.detail,
    createdAt: row.created_at,
  };
}

// The list projection deliberately omits `text` (and includes only its
// length): a single capture can carry up to MAX_CAPTURE_TEXT_LENGTH
// (500,000) characters, so a list of many captures including full text
// could itself approach or exceed the service's response-size bound
// (maxResponseBytes, enforced in service/server.mjs) on an otherwise
// ordinary-sized page. `detail` is bounded small (MAX_DETAIL_LENGTH, 4,000
// characters) and kept in the list view since it is not a comparable risk.
// `createCapture` (above) returns this same bounded projection — a
// mutation's result must be bounded by construction, never rely on the
// final response-size backstop, since the insert has already committed by
// the time that backstop would run (see createCapture's own comment).
// `readCapture` (store.captures.read) is the route for retrieving a
// capture's full text afterward, in bounded chunks — see README.md's
// "Stage 3" section.
function rowToCaptureListItem(row) {
  const { text, ...rest } = rowToCapture(row);
  return { ...rest, textLength: text === null ? null : text.length };
}

function rowToSummary(row) {
  return {
    id: row.id,
    text: row.text,
    creatorType: row.creator_type,
    creatorName: row.creator_name,
    modelMetadata: row.model_metadata === null ? null : JSON.parse(row.model_metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceCaptureIds: [],
  };
}

function rowToTag(row) {
  return { id: row.id, name: row.name, creatorType: row.creator_type, creatorName: row.creator_name, createdAt: row.created_at };
}

function rowToTagAssignment(row) {
  return {
    id: row.id,
    tagId: row.tag_id,
    recordType: row.capture_id !== null ? "capture" : "summary",
    recordId: row.capture_id !== null ? row.capture_id : row.summary_id,
    creatorType: row.creator_type,
    creatorName: row.creator_name,
    createdAt: row.created_at,
  };
}

function rowToCollection(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    creatorType: row.creator_type,
    creatorName: row.creator_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToCollectionItem(row) {
  return {
    id: row.id,
    collectionId: row.collection_id,
    recordType: row.capture_id !== null ? "capture" : "summary",
    recordId: row.capture_id !== null ? row.capture_id : row.summary_id,
    position: row.position,
    creatorType: row.creator_type,
    creatorName: row.creator_name,
    createdAt: row.created_at,
  };
}

function rowToQueueItem(row) {
  return {
    id: row.id,
    recordType: row.record_type,
    recordId: row.capture_id ?? row.summary_id ?? row.proposal_id,
    state: row.state,
    creatorType: row.creator_type,
    creatorName: row.creator_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToProposal(row) {
  return {
    id: row.id,
    kind: row.kind,
    rationale: row.rationale,
    payload: JSON.parse(row.payload),
    creatorType: row.creator_type,
    creatorName: row.creator_name,
    state: row.state,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedByCreatorType: row.decided_by_creator_type,
    decidedByCreatorName: row.decided_by_creator_name,
    sourceCaptureIds: [],
    sourceSummaryIds: [],
  };
}

// A dependency-computation or deletion step that takes an arbitrary number
// of ids must never grow a single `IN (...)` placeholder list without
// bound — SQLite's own per-statement placeholder ceiling varies by build
// (and by the SQLite version Node's `node:sqlite` happens to bundle), so
// relying on "it's probably fine" is not a bound. 500 is a conservative,
// fixed chunk size well under any such ceiling; ids are processed this many
// at a time and the discovered sets are accumulated across chunks (see
// computeCaptureDependents below), so correctness does not depend on how
// many ids are involved. Overridable on openStore (below) only so a test
// can exercise the chunk-boundary behavior itself without needing
// thousands of rows — the same test-only-override pattern already used by
// runMigrations' `migrations` parameter; every real caller gets this exact
// value.
const CAPTURE_DEPENDENT_CHUNK_SIZE = 500;

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function buildWhere(conditions) {
  const clauses = [];
  const params = [];
  for (const [column, value] of conditions) {
    if (value === undefined) continue;
    clauses.push(`${column} = ?`);
    params.push(value);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

// Opens (creating on first run) the Stage 3 derived store at
// `<dataDir>/browser-tabs.db`. `dataDir` is expected to already exist with
// restrictive permissions (service/cli.mjs ensures this the same way it
// does for the pairing credential); this function also enforces it
// defensively for any other caller (e.g. tests).
export async function openStore({ dataDir, log = () => {}, captureDependentChunkSize = CAPTURE_DEPENDENT_CHUNK_SIZE }) {
  const DatabaseSync = await loadDatabaseSync();
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = join(dataDir, DATABASE_FILE_NAME);
  const isNewDatabase = !existsSync(dbPath);

  const db = new DatabaseSync(dbPath);
  // Enforced on every connection (project.md Stage 3: "Enforce foreign
  // keys and reject references to missing sources") — SQLite does not
  // persist this pragma in the database file itself, so it must be set
  // every time a connection is opened, not only at creation. Verified by
  // reading the pragma back, not merely assumed to have taken effect: a
  // silently-ignored PRAGMA (e.g. because it was set mid-transaction, which
  // SQLite ignores for foreign_keys specifically) must surface as an
  // explicit startup failure, never a store that is quietly less safe than
  // its own documentation claims.
  db.exec("PRAGMA foreign_keys = ON");
  const foreignKeysOn = db.prepare("PRAGMA foreign_keys").get().foreign_keys;
  if (!foreignKeysOn) {
    throw new StoreError(STORE_ERROR_CODES.DB_ERROR, "failed to enable PRAGMA foreign_keys on the derived store connection");
  }

  // Explicitly set (not merely left at whatever SQLite's compiled-in
  // default happens to be) and verified, for two independent reasons:
  //
  // 1. journal_mode = DELETE, not WAL: WAL defers recently committed data
  //    into a separate `-wal` file until a checkpoint, so a plain file
  //    copy of the main database file (backupDatabase, above) could
  //    silently miss recent commits. DELETE mode keeps the main file
  //    itself always consistent at every commit boundary (its rollback
  //    journal is removed once a transaction commits), which a file-copy
  //    backup depends on. This service is single-process/single-writer
  //    (project.md's trust model), so WAL's main benefit — concurrent
  //    readers during a writer — is not needed here. See
  //    test/store.test.mjs's WAL-origin backup regression.
  // 2. secure_delete = ON: without it, SQLite's default behavior leaves a
  //    deleted row's bytes sitting in now-unused pages of the database
  //    file until some future write happens to reuse that page — so
  //    `store.clear` (or any delete) would not actually erase previously
  //    retained browser content from the live file, only make it
  //    unreachable through SQL. With it, SQLite overwrites that content
  //    with zeros as part of the same delete. This only governs *this
  //    connection's own future deletes*, though — it cannot retroactively
  //    scrub a page already freed by an earlier connection that ran with
  //    secure_delete OFF, which is why `clearAll` (below) also runs
  //    `VACUUM`. See test/store.test.mjs's "secure delete" and "VACUUM"
  //    regressions.
  db.exec("PRAGMA journal_mode = DELETE");
  const journalMode = String(db.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (journalMode !== "delete") {
    throw new StoreError(STORE_ERROR_CODES.DB_ERROR, `expected PRAGMA journal_mode = DELETE for file-copy backup safety, got "${journalMode}"`);
  }
  db.exec("PRAGMA secure_delete = ON");
  const secureDeleteOn = db.prepare("PRAGMA secure_delete").get().secure_delete;
  if (!secureDeleteOn) {
    throw new StoreError(STORE_ERROR_CODES.DB_ERROR, "failed to enable PRAGMA secure_delete on the derived store connection");
  }

  runMigrations(db, dbPath, log);
  log(isNewDatabase ? `created new derived store at ${dbPath}` : `opened existing derived store at ${dbPath}`);

  // ---- captures ----

  // Returns the bounded list-item projection (rowToCaptureListItem), never
  // the full row with its raw `text`: a capture's text can be up to
  // MAX_CAPTURE_TEXT_LENGTH (500,000) characters, which can itself exceed
  // maxResponseBytes once JSON-escaped, and the insert below has already
  // committed by the time any response-size check would run. Returning an
  // unbounded result here would risk exactly the outcome this must never
  // produce: a write that commits and then fails to report success because
  // its own response was too large. The response is bounded by
  // construction instead — see store.captures.read (readCapture, below)
  // for retrieving the full text afterward, in bounded chunks.
  function createCapture(input) {
    const data = validateCaptureInput(input);
    return runInTransaction(db, () => {
      const result = db
        .prepare(
          `INSERT INTO captures
            (browser_session_id, source_operation, schema_version, window_id, tab_id, url, title,
             document_ready_state, captured_at, status, character_count, returned_character_count, truncated,
             text, code, detail, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          data.browserSessionId,
          data.sourceOperation,
          data.schemaVersion,
          data.windowId,
          data.tabId,
          data.url,
          data.title,
          data.documentReadyState,
          data.capturedAt,
          data.status,
          data.characterCount,
          data.returnedCharacterCount,
          data.truncated === null ? null : data.truncated ? 1 : 0,
          data.text,
          data.code,
          data.detail,
          nowMs(),
        );
      return rowToCaptureListItem(db.prepare("SELECT * FROM captures WHERE id = ?").get(Number(result.lastInsertRowid)));
    });
  }

  // store.captures.read: a bounded, offset-addressable slice of one
  // capture's full text, plus the same metadata the list/create views
  // return. Lets a caller inspect previously retained text (e.g. after a
  // restart, once the one-time create response is long gone) without ever
  // requesting more than one bounded chunk of it — see
  // validateCaptureReadInput for the offset/maxChars bounds.
  function readCapture(input) {
    const data = validateCaptureReadInput(input);
    const row = db.prepare("SELECT * FROM captures WHERE id = ?").get(data.id);
    if (!row) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `capture ${data.id} not found`);
    const { text, ...metadata } = rowToCapture(row);
    const chunk = text === null ? "" : text.slice(data.offset, data.offset + data.maxChars);
    return {
      ...metadata,
      textLength: text === null ? null : text.length,
      offset: data.offset,
      maxChars: data.maxChars,
      chunk,
      chunkLength: chunk.length,
    };
  }

  function listCaptures({ limit, offset, windowId, tabId, status, id } = {}) {
    const bounds = validateLimitOffset({ limit, offset });
    const { where, params } = buildWhere([
      ["id", optionalFilterPositiveInteger(id, "id")],
      ["window_id", optionalFilterNonNegativeInteger(windowId, "windowId")],
      ["tab_id", optionalFilterNonNegativeInteger(tabId, "tabId")],
      ["status", optionalFilterEnum(status, ALLOWED_RESULT_STATUSES, "status")],
    ]);
    const items = db
      .prepare(`SELECT * FROM captures ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, bounds.limit, bounds.offset)
      .map(rowToCaptureListItem);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM captures ${where}`).get(...params).count;
    return { items, total };
  }

  // Computes the full, deduplicated set of summaries/proposals that must be
  // deleted before any of `captureIds` can be deleted — the dependency
  // graph has exactly two RESTRICT chains (capture <- summary <- proposal,
  // and capture <- proposal directly; nothing restricts deleting a
  // proposal, and summaries never cite other summaries), so this is the
  // complete transitive closure, not merely "one level": a proposal that
  // cites a *summary* which in turn cites one of `captureIds` is included
  // here via `proposalIdsViaSummary`, not only a proposal that cites a
  // capture directly. Deduping across overlapping citations (the same
  // summary or proposal cited by more than one of `captureIds`, as happens
  // when a retention sweep expires several captures at once) means each
  // dependent is only ever targeted for deletion once.
  // Chunked so neither the capture-id nor the (intermediate) summary-id
  // dimension ever builds an unbounded `IN (...)` placeholder list — see
  // CAPTURE_DEPENDENT_CHUNK_SIZE above. Sets are accumulated across chunks,
  // not per-chunk, so dedup behavior is identical to the unchunked version
  // regardless of how `captureIds` happens to be split.
  function computeCaptureDependents(captureIds) {
    if (captureIds.length === 0) return { summaryIds: [], proposalIds: [] };
    const summaryIdSet = new Set();
    const proposalIdSet = new Set();

    for (const idsChunk of chunkArray(captureIds, captureDependentChunkSize)) {
      const placeholders = idsChunk.map(() => "?").join(",");
      for (const row of db.prepare(`SELECT DISTINCT summary_id FROM summary_sources WHERE capture_id IN (${placeholders})`).all(...idsChunk)) {
        summaryIdSet.add(row.summary_id);
      }
      for (const row of db.prepare(`SELECT DISTINCT proposal_id FROM proposal_sources WHERE capture_id IN (${placeholders})`).all(...idsChunk)) {
        proposalIdSet.add(row.proposal_id);
      }
    }

    const summaryIds = [...summaryIdSet];
    for (const idsChunk of chunkArray(summaryIds, captureDependentChunkSize)) {
      const placeholders = idsChunk.map(() => "?").join(",");
      for (const row of db.prepare(`SELECT DISTINCT proposal_id FROM proposal_sources WHERE summary_id IN (${placeholders})`).all(...idsChunk)) {
        proposalIdSet.add(row.proposal_id);
      }
    }

    return { summaryIds, proposalIds: [...proposalIdSet] };
  }

  // Deletes a capture. By default (`cascade: false`), refuses with
  // HAS_DEPENDENTS if any summary or proposal still cites it — directly, or
  // (for a proposal) transitively via a summary that cites it — as a
  // source. With `cascade: true`, every such summary/proposal (computed by
  // computeCaptureDependents above) is deleted first, **proposals before
  // summaries**: a proposal cites a summary with ON DELETE RESTRICT, so a
  // proposal citing a to-be-deleted summary must be gone before that
  // summary is deleted, or the summary's own delete would fail. Anything
  // that only *links* to a deleted summary/proposal (tags, collection
  // membership, queue items) cascades automatically via its own
  // ON DELETE CASCADE foreign key, regardless of order.
  //
  // The result reports `cascadedSummaryCount`/`cascadedProposalCount` —
  // bounded counts, never the id lists themselves. A cascading delete
  // against a capture with an unbounded number of dependents (a pathological
  // but real possibility — nothing limits how many summaries/proposals may
  // cite one capture) must still produce a small, bounded response: the
  // delete has already committed by the time any response is built, so an
  // unbounded id-array response risks the exact outcome every mutation here
  // must avoid — a write that commits and then fails to report success
  // because its own response was too large (see service/server.mjs's
  // maxResponseBytes check, and the adversarial regression in
  // test/store-routes.test.mjs that proves this with a deliberately tiny
  // maxResponseBytes and many dependents).
  function deleteCapture(id, { cascade = false } = {}) {
    return runInTransaction(
      db,
      () => {
        const exists = db.prepare("SELECT id FROM captures WHERE id = ?").get(id);
        if (!exists) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `capture ${id} not found`);

        const { summaryIds, proposalIds } = computeCaptureDependents([id]);

        if (!cascade && (summaryIds.length > 0 || proposalIds.length > 0)) {
          throw new StoreError(
            STORE_ERROR_CODES.HAS_DEPENDENTS,
            `capture ${id} is cited (directly or via a cited summary) by ${summaryIds.length} summary(ies) and ${proposalIds.length} proposal(s); pass cascade=true to delete them too`,
          );
        }

        if (cascade) {
          const delProposal = db.prepare("DELETE FROM proposals WHERE id = ?");
          for (const proposalId of proposalIds) delProposal.run(proposalId);
          const delSummary = db.prepare("DELETE FROM summaries WHERE id = ?");
          for (const summaryId of summaryIds) delSummary.run(summaryId);
        }

        db.prepare("DELETE FROM captures WHERE id = ?").run(id);
        return { deletedCaptureId: id, cascadedSummaryCount: cascade ? summaryIds.length : 0, cascadedProposalCount: cascade ? proposalIds.length : 0 };
      },
      { onForeignKeyViolation: () => new StoreError(STORE_ERROR_CODES.HAS_DEPENDENTS, `capture ${id} still has dependents that block deletion`) },
    );
  }

  // ---- summaries ----

  function attachSummarySources(rows) {
    if (rows.length === 0) return rows;
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const sourceRows = db.prepare(`SELECT summary_id, capture_id FROM summary_sources WHERE summary_id IN (${placeholders}) ORDER BY capture_id`).all(...ids);
    const bySummary = new Map();
    for (const { summary_id, capture_id } of sourceRows) {
      if (!bySummary.has(summary_id)) bySummary.set(summary_id, []);
      bySummary.get(summary_id).push(capture_id);
    }
    for (const row of rows) row.sourceCaptureIds = bySummary.get(row.id) ?? [];
    return rows;
  }

  function createSummary(input) {
    const data = validateSummaryCreateInput(input);
    return runInTransaction(db, () => {
      const result = db
        .prepare("INSERT INTO summaries (text, creator_type, creator_name, model_metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(data.text, data.creatorType, data.creatorName, data.modelMetadata, nowMs(), nowMs());
      const summaryId = Number(result.lastInsertRowid);
      const insertSource = db.prepare("INSERT INTO summary_sources (summary_id, capture_id) VALUES (?, ?)");
      for (const captureId of data.sourceCaptureIds) insertSource.run(summaryId, captureId);
      const row = rowToSummary(db.prepare("SELECT * FROM summaries WHERE id = ?").get(summaryId));
      return attachSummarySources([row])[0];
    });
  }

  function listSummaries({ limit, offset, id, creatorType } = {}) {
    const bounds = validateLimitOffset({ limit, offset });
    const { where, params } = buildWhere([
      ["id", optionalFilterPositiveInteger(id, "id")],
      ["creator_type", optionalFilterEnum(creatorType, CREATOR_TYPES, "creatorType")],
    ]);
    const items = db
      .prepare(`SELECT * FROM summaries ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, bounds.limit, bounds.offset)
      .map(rowToSummary);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM summaries ${where}`).get(...params).count;
    return { items: attachSummarySources(items), total };
  }

  function updateSummary(id, input) {
    const data = validateSummaryUpdateInput(input);
    return runInTransaction(db, () => {
      const existing = db.prepare("SELECT id FROM summaries WHERE id = ?").get(id);
      if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `summary ${id} not found`);
      const sets = [];
      const params = [];
      if (data.text !== undefined) {
        sets.push("text = ?");
        params.push(data.text);
      }
      if (data.modelMetadata !== undefined) {
        sets.push("model_metadata = ?");
        params.push(data.modelMetadata);
      }
      sets.push("updated_at = ?");
      params.push(nowMs());
      db.prepare(`UPDATE summaries SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
      const row = rowToSummary(db.prepare("SELECT * FROM summaries WHERE id = ?").get(id));
      return attachSummarySources([row])[0];
    });
  }

  // A summary can only be cited by a proposal (never by another summary),
  // so — unlike deleteCapture above — there is only ever one level to
  // cascade through here: the proposals citing this summary directly.
  function deleteSummary(id, { cascade = false } = {}) {
    return runInTransaction(
      db,
      () => {
        const exists = db.prepare("SELECT id FROM summaries WHERE id = ?").get(id);
        if (!exists) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `summary ${id} not found`);

        const proposalIds = db.prepare("SELECT DISTINCT proposal_id FROM proposal_sources WHERE summary_id = ?").all(id).map((r) => r.proposal_id);
        if (!cascade && proposalIds.length > 0) {
          throw new StoreError(STORE_ERROR_CODES.HAS_DEPENDENTS, `summary ${id} is cited by ${proposalIds.length} proposal(s); pass cascade=true to delete them too`);
        }
        if (cascade) {
          const delProposal = db.prepare("DELETE FROM proposals WHERE id = ?");
          for (const proposalId of proposalIds) delProposal.run(proposalId);
        }
        db.prepare("DELETE FROM summaries WHERE id = ?").run(id);
        return { deletedSummaryId: id, cascadedProposalCount: cascade ? proposalIds.length : 0 };
      },
      { onForeignKeyViolation: () => new StoreError(STORE_ERROR_CODES.HAS_DEPENDENTS, `summary ${id} still has dependents that block deletion`) },
    );
  }

  // ---- tags ----

  function createTag(input) {
    const data = validateTagCreateInput(input);
    return runInTransaction(db, () => {
      const result = db
        .prepare("INSERT INTO tags (name, creator_type, creator_name, created_at) VALUES (?, ?, ?, ?)")
        .run(data.name, data.creatorType, data.creatorName, nowMs());
      return rowToTag(db.prepare("SELECT * FROM tags WHERE id = ?").get(Number(result.lastInsertRowid)));
    });
  }

  function listTags({ limit, offset, id } = {}) {
    const bounds = validateLimitOffset({ limit, offset });
    const { where, params } = buildWhere([["id", optionalFilterPositiveInteger(id, "id")]]);
    const items = db.prepare(`SELECT * FROM tags ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, bounds.limit, bounds.offset).map(rowToTag);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM tags ${where}`).get(...params).count;
    return { items, total };
  }

  function deleteTag(id) {
    return runInTransaction(db, () => {
      const exists = db.prepare("SELECT id FROM tags WHERE id = ?").get(id);
      if (!exists) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `tag ${id} not found`);
      db.prepare("DELETE FROM tags WHERE id = ?").run(id);
      return { deletedTagId: id };
    });
  }

  function assignTag(input) {
    const data = validateTagAssignmentInput(input);
    const captureId = data.recordType === "capture" ? data.recordId : null;
    const summaryId = data.recordType === "summary" ? data.recordId : null;
    return runInTransaction(db, () => {
      const result = db
        .prepare("INSERT INTO tag_assignments (tag_id, capture_id, summary_id, creator_type, creator_name, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(data.tagId, captureId, summaryId, data.creatorType, data.creatorName, nowMs());
      return rowToTagAssignment(db.prepare("SELECT * FROM tag_assignments WHERE id = ?").get(Number(result.lastInsertRowid)));
    });
  }

  function unassignTag(input) {
    const data = validateTagUnassignmentInput(input);
    const captureId = data.recordType === "capture" ? data.recordId : null;
    const summaryId = data.recordType === "summary" ? data.recordId : null;
    return runInTransaction(db, () => {
      const existing = db
        .prepare("SELECT id FROM tag_assignments WHERE tag_id = ? AND capture_id IS ? AND summary_id IS ?")
        .get(data.tagId, captureId, summaryId);
      if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, "tag assignment not found");
      db.prepare("DELETE FROM tag_assignments WHERE id = ?").run(existing.id);
      return { deletedTagAssignmentId: existing.id };
    });
  }

  function listTagAssignments({ tagId, recordType, recordId, limit, offset } = {}) {
    const bounds = validateLimitOffset({ limit, offset });
    // recordType/recordId must be supplied together or not at all — a
    // partial filter (e.g. recordType alone) is rejected explicitly rather
    // than silently widened into "every record of that type" (see
    // requireRecordFilterPairOrNeither).
    const { recordType: validRecordType, recordId: validRecordId } = requireRecordFilterPairOrNeither(
      recordType,
      recordId,
      RECORD_TYPES_CAPTURE_SUMMARY,
    );
    const captureId = validRecordType === "capture" ? validRecordId : undefined;
    const summaryId = validRecordType === "summary" ? validRecordId : undefined;
    const { where, params } = buildWhere([
      ["tag_id", optionalFilterPositiveInteger(tagId, "tagId")],
      ["capture_id", captureId],
      ["summary_id", summaryId],
    ]);
    const items = db
      .prepare(`SELECT * FROM tag_assignments ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, bounds.limit, bounds.offset)
      .map(rowToTagAssignment);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM tag_assignments ${where}`).get(...params).count;
    return { items, total };
  }

  // ---- collections ----

  function createCollection(input) {
    const data = validateCollectionCreateInput(input);
    return runInTransaction(db, () => {
      const result = db
        .prepare("INSERT INTO collections (name, description, creator_type, creator_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(data.name, data.description, data.creatorType, data.creatorName, nowMs(), nowMs());
      return rowToCollection(db.prepare("SELECT * FROM collections WHERE id = ?").get(Number(result.lastInsertRowid)));
    });
  }

  function listCollections({ limit, offset, id } = {}) {
    const bounds = validateLimitOffset({ limit, offset });
    const { where, params } = buildWhere([["id", optionalFilterPositiveInteger(id, "id")]]);
    const items = db.prepare(`SELECT * FROM collections ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, bounds.limit, bounds.offset).map(rowToCollection);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM collections ${where}`).get(...params).count;
    return { items, total };
  }

  function updateCollection(id, input) {
    const data = validateCollectionUpdateInput(input);
    return runInTransaction(db, () => {
      const existing = db.prepare("SELECT id FROM collections WHERE id = ?").get(id);
      if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `collection ${id} not found`);
      const sets = [];
      const params = [];
      if (data.name !== undefined) {
        sets.push("name = ?");
        params.push(data.name);
      }
      if (data.description !== undefined) {
        sets.push("description = ?");
        params.push(data.description);
      }
      sets.push("updated_at = ?");
      params.push(nowMs());
      db.prepare(`UPDATE collections SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
      return rowToCollection(db.prepare("SELECT * FROM collections WHERE id = ?").get(id));
    });
  }

  function deleteCollection(id) {
    return runInTransaction(db, () => {
      const exists = db.prepare("SELECT id FROM collections WHERE id = ?").get(id);
      if (!exists) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `collection ${id} not found`);
      db.prepare("DELETE FROM collections WHERE id = ?").run(id);
      return { deletedCollectionId: id };
    });
  }

  function addCollectionItem(input) {
    const data = validateCollectionItemInput(input);
    const captureId = data.recordType === "capture" ? data.recordId : null;
    const summaryId = data.recordType === "summary" ? data.recordId : null;
    return runInTransaction(db, () => {
      let position = data.position;
      if (position === null) {
        const row = db.prepare("SELECT COALESCE(MAX(position), -1) AS maxPosition FROM collection_items WHERE collection_id = ?").get(data.collectionId);
        position = row.maxPosition + 1;
      }
      const result = db
        .prepare(
          "INSERT INTO collection_items (collection_id, capture_id, summary_id, position, creator_type, creator_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(data.collectionId, captureId, summaryId, position, data.creatorType, data.creatorName, nowMs());
      return rowToCollectionItem(db.prepare("SELECT * FROM collection_items WHERE id = ?").get(Number(result.lastInsertRowid)));
    });
  }

  function removeCollectionItem(id) {
    return runInTransaction(db, () => {
      const existing = db.prepare("SELECT id FROM collection_items WHERE id = ?").get(id);
      if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `collection item ${id} not found`);
      db.prepare("DELETE FROM collection_items WHERE id = ?").run(id);
      return { deletedCollectionItemId: id };
    });
  }

  function listCollectionItems({ collectionId, limit, offset }) {
    const bounds = validateLimitOffset({ limit, offset });
    if (!Number.isSafeInteger(collectionId) || collectionId <= 0) {
      throw new StoreError(STORE_ERROR_CODES.VALIDATION_ERROR, "collectionId: must be a positive integer");
    }
    const items = db
      .prepare("SELECT * FROM collection_items WHERE collection_id = ? ORDER BY position ASC LIMIT ? OFFSET ?")
      .all(collectionId, bounds.limit, bounds.offset)
      .map(rowToCollectionItem);
    const total = db.prepare("SELECT COUNT(*) AS count FROM collection_items WHERE collection_id = ?").get(collectionId).count;
    return { items, total };
  }

  // Re-orders a collection's existing items to exactly the given sequence
  // of item ids (`orderedItemIds` must be the current item-id set,
  // reordered — not additions or removals; use addCollectionItem/
  // removeCollectionItem for those). Updated in two phases so the
  // per-collection UNIQUE(collection_id, position) index never transiently
  // collides partway through: first every item's position is set to the
  // *negation of its own row id* (`-id`), then final positions (0..N-1)
  // are assigned. This temporary range is guaranteed disjoint from every
  // other position any row in this table can ever hold — `position` is
  // schema-level NOT NULL with non-negative values enforced at the
  // validation layer (optionalNullableNonNegativeInteger), so no real
  // position is ever negative, and `-id` is itself unique across rows
  // because `id` is. An earlier version used a fixed "+1,000,000" offset
  // instead; that was only disjoint from positions that happened to be
  // small, and a caller-supplied explicit `position` on a prior
  // addCollectionItem call (position has no enforced upper bound) could
  // already sit at or above that offset, risking a transient collision
  // mid-statement. Negative-vs-non-negative has no such ceiling to exceed.
  function reorderCollectionItems(input) {
    const data = validateCollectionReorderInput(input);
    return runInTransaction(db, () => {
      const collectionExists = db.prepare("SELECT id FROM collections WHERE id = ?").get(data.collectionId);
      if (!collectionExists) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `collection ${data.collectionId} not found`);

      const existingIds = db.prepare("SELECT id FROM collection_items WHERE collection_id = ?").all(data.collectionId).map((r) => r.id);
      const existingSet = new Set(existingIds);
      const requestedSet = new Set(data.orderedItemIds);
      const sameSet = existingIds.length === data.orderedItemIds.length && data.orderedItemIds.every((id) => existingSet.has(id));
      if (!sameSet || requestedSet.size !== data.orderedItemIds.length) {
        throw new StoreError(
          STORE_ERROR_CODES.VALIDATION_ERROR,
          "orderedItemIds must contain exactly the collection's current item ids, each exactly once",
        );
      }

      db.prepare("UPDATE collection_items SET position = -id WHERE collection_id = ?").run(data.collectionId);
      const setPosition = db.prepare("UPDATE collection_items SET position = ? WHERE id = ?");
      data.orderedItemIds.forEach((itemId, index) => setPosition.run(index, itemId));

      return listCollectionItems({ collectionId: data.collectionId, limit: Math.min(data.orderedItemIds.length, 200), offset: 0 });
    });
  }

  // ---- queue items ----

  function createQueueItem(input) {
    const data = validateQueueCreateInput(input);
    const captureId = data.recordType === "capture" ? data.recordId : null;
    const summaryId = data.recordType === "summary" ? data.recordId : null;
    const proposalId = data.recordType === "proposal" ? data.recordId : null;
    return runInTransaction(db, () => {
      const result = db
        .prepare(
          "INSERT INTO queue_items (record_type, capture_id, summary_id, proposal_id, state, creator_type, creator_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(data.recordType, captureId, summaryId, proposalId, data.state, data.creatorType, data.creatorName, nowMs(), nowMs());
      return rowToQueueItem(db.prepare("SELECT * FROM queue_items WHERE id = ?").get(Number(result.lastInsertRowid)));
    });
  }

  function listQueueItems({ limit, offset, id, state, recordType } = {}) {
    const bounds = validateLimitOffset({ limit, offset });
    const { where, params } = buildWhere([
      ["id", optionalFilterPositiveInteger(id, "id")],
      ["state", optionalFilterString(state, "state", { maxLength: MAX_STATE_LENGTH })],
      ["record_type", optionalFilterEnum(recordType, RECORD_TYPES_QUEUEABLE, "recordType")],
    ]);
    const items = db.prepare(`SELECT * FROM queue_items ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, bounds.limit, bounds.offset).map(rowToQueueItem);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM queue_items ${where}`).get(...params).count;
    return { items, total };
  }

  function updateQueueItem(id, input) {
    const data = validateQueueUpdateInput(input);
    return runInTransaction(db, () => {
      const existing = db.prepare("SELECT id FROM queue_items WHERE id = ?").get(id);
      if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `queue item ${id} not found`);
      db.prepare("UPDATE queue_items SET state = ?, updated_at = ? WHERE id = ?").run(data.state, nowMs(), id);
      return rowToQueueItem(db.prepare("SELECT * FROM queue_items WHERE id = ?").get(id));
    });
  }

  function deleteQueueItem(id) {
    return runInTransaction(db, () => {
      const existing = db.prepare("SELECT id FROM queue_items WHERE id = ?").get(id);
      if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `queue item ${id} not found`);
      db.prepare("DELETE FROM queue_items WHERE id = ?").run(id);
      return { deletedQueueItemId: id };
    });
  }

  // ---- proposals ----

  function attachProposalSources(rows) {
    if (rows.length === 0) return rows;
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const sourceRows = db.prepare(`SELECT proposal_id, capture_id, summary_id FROM proposal_sources WHERE proposal_id IN (${placeholders})`).all(...ids);
    const byProposal = new Map();
    for (const { proposal_id, capture_id, summary_id } of sourceRows) {
      if (!byProposal.has(proposal_id)) byProposal.set(proposal_id, { captures: [], summaries: [] });
      const bucket = byProposal.get(proposal_id);
      if (capture_id !== null) bucket.captures.push(capture_id);
      if (summary_id !== null) bucket.summaries.push(summary_id);
    }
    for (const row of rows) {
      const bucket = byProposal.get(row.id) ?? { captures: [], summaries: [] };
      row.sourceCaptureIds = bucket.captures;
      row.sourceSummaryIds = bucket.summaries;
    }
    return rows;
  }

  function createProposal(input) {
    const data = validateProposalCreateInput(input);
    return runInTransaction(db, () => {
      const result = db
        .prepare("INSERT INTO proposals (kind, rationale, payload, creator_type, creator_name, state, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
        .run(data.kind, data.rationale, data.payload, data.creatorType, data.creatorName, nowMs());
      const proposalId = Number(result.lastInsertRowid);
      const insertSource = db.prepare("INSERT INTO proposal_sources (proposal_id, capture_id, summary_id) VALUES (?, ?, ?)");
      for (const captureId of data.sourceCaptureIds) insertSource.run(proposalId, captureId, null);
      for (const summaryId of data.sourceSummaryIds) insertSource.run(proposalId, null, summaryId);
      const row = rowToProposal(db.prepare("SELECT * FROM proposals WHERE id = ?").get(proposalId));
      return attachProposalSources([row])[0];
    });
  }

  function listProposals({ limit, offset, id, state, kind } = {}) {
    const bounds = validateLimitOffset({ limit, offset });
    const { where, params } = buildWhere([
      ["id", optionalFilterPositiveInteger(id, "id")],
      ["state", optionalFilterEnum(state, PROPOSAL_STATES, "state")],
      ["kind", optionalFilterEnum(kind, PROPOSAL_KINDS, "kind")],
    ]);
    const items = db.prepare(`SELECT * FROM proposals ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, bounds.limit, bounds.offset).map(rowToProposal);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM proposals ${where}`).get(...params).count;
    return { items: attachProposalSources(items), total };
  }

  // Only a pending->accepted or pending->rejected transition is allowed;
  // this only ever records the decision (project.md Stage 3/5: proposals
  // are reviewed, not auto-applied) — it never itself performs the
  // proposed tag/collection/queue change, which stays a separate, explicit
  // operation for whoever (or whatever) acts on the decision. The decider's
  // creatorType/creatorName is required and persisted alongside the
  // decision, the same provenance every other derived value carries — see
  // validateProposalUpdateInput's doc comment on what that identity does
  // and does not prove under this project's single-shared-credential trust
  // model.
  function updateProposalState(id, input) {
    const data = validateProposalUpdateInput(input);
    return runInTransaction(db, () => {
      const existing = db.prepare("SELECT id, state FROM proposals WHERE id = ?").get(id);
      if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `proposal ${id} not found`);
      if (existing.state !== "pending") {
        throw new StoreError(STORE_ERROR_CODES.CONFLICT, `proposal ${id} has already been decided (state: ${existing.state})`);
      }
      db.prepare("UPDATE proposals SET state = ?, decided_at = ?, decided_by_creator_type = ?, decided_by_creator_name = ? WHERE id = ?").run(
        data.state,
        nowMs(),
        data.decidedByCreatorType,
        data.decidedByCreatorName,
        id,
      );
      const row = rowToProposal(db.prepare("SELECT * FROM proposals WHERE id = ?").get(id));
      return attachProposalSources([row])[0];
    });
  }

  function deleteProposal(id) {
    return runInTransaction(db, () => {
      const existing = db.prepare("SELECT id FROM proposals WHERE id = ?").get(id);
      if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `proposal ${id} not found`);
      db.prepare("DELETE FROM proposals WHERE id = ?").run(id);
      return { deletedProposalId: id };
    });
  }

  // ---- actions (Phase 2 Action 1) ----

  function rowToAction(row) {
    return {
      id: row.id,
      kind: row.kind,
      url: row.url,
      binding: row.binding === null ? null : JSON.parse(row.binding),
      browserSessionId: row.browser_session_id,
      state: row.state,
      previewedAt: row.previewed_at,
      decidedAt: row.decided_at,
      completedAt: row.completed_at,
      result: row.result === null ? null : JSON.parse(row.result),
    };
  }

  // The audit log's only writer. Every event is written in the same
  // transaction as the state change it records, so the log and the action
  // can never disagree about whether something happened. An event carries
  // the action id, an event name, a timestamp, and server-controlled enum
  // values only (the action kind, the decision, the result state and
  // mutation) — each chosen or validated against a fixed set by this
  // service. Nothing the extension (or any caller) supplies is ever copied
  // into it: not the URL or a hash of it, not a session id, title, handle,
  // code, or detail. The action record holds those, clipped, and is cleared
  // by `store.clear`; the audit log is not.
  function appendActionAudit(actionId, event, occurredAt, detail) {
    db.prepare("INSERT INTO action_audit (action_id, event, occurred_at, detail) VALUES (?, ?, ?, ?)").run(
      actionId,
      event,
      occurredAt,
      JSON.stringify(detail),
    );
  }

  // Records a preview: the exact normalized URL, the browser session it was
  // taken in, and the time. Nothing is executed. Refused (never by evicting
  // anything) when too many previews already await a decision or the audit
  // log is full.
  function createAction(input) {
    const data = validateActionPreviewInput(input);
    return runInTransaction(db, () => {
      const pending = db.prepare("SELECT COUNT(*) AS count FROM actions WHERE state = 'previewed'").get().count;
      if (pending >= MAX_PENDING_ACTIONS) {
        throw new StoreError(STORE_ERROR_CODES.LIMIT_REACHED, `${pending} previews already await a decision; approve or reject some first`);
      }
      const auditCount = db.prepare("SELECT COUNT(*) AS count FROM action_audit").get().count;
      if (auditCount >= MAX_ACTION_AUDIT_EVENTS) {
        throw new StoreError(STORE_ERROR_CODES.LIMIT_REACHED, "the action audit log is full; no new action can be previewed");
      }
      const now = nowMs();
      const result = db
        .prepare("INSERT INTO actions (kind, url, binding, browser_session_id, state, previewed_at) VALUES (?, ?, ?, ?, 'previewed', ?)")
        .run(data.kind, data.url, data.binding === null ? null : JSON.stringify(data.binding), data.browserSessionId, now);
      const id = Number(result.lastInsertRowid);
      appendActionAudit(id, "preview", now, { kind: data.kind });
      return rowToAction(db.prepare("SELECT * FROM actions WHERE id = ?").get(id));
    });
  }

  // The single terminal decision on a preview. `decision` is "approve" or
  // "reject"; it is made by id alone — nothing about the operation can be
  // supplied here, so what is approved is exactly what was previewed. The
  // transition is one conditional UPDATE (`... AND state = 'previewed'`)
  // inside an immediate transaction, so of any number of concurrent or
  // repeated decisions exactly one changes a row; every other gets CONFLICT
  // and must not execute anything. The returned record is what the caller
  // executes from.
  function decideAction(id, decision) {
    if (decision !== "approve" && decision !== "reject") {
      throw new StoreError(STORE_ERROR_CODES.VALIDATION_ERROR, 'decision: must be "approve" or "reject"');
    }
    if (!Number.isSafeInteger(id) || id <= 0) throw new StoreError(STORE_ERROR_CODES.VALIDATION_ERROR, "id: must be a positive integer");
    return runInTransaction(db, () => {
      const now = nowMs();
      const toState = decision === "approve" ? "approved" : "rejected";
      const { changes } = db.prepare("UPDATE actions SET state = ?, decided_at = ? WHERE id = ? AND state = 'previewed'").run(toState, now, id);
      if (changes !== 1) {
        const existing = db.prepare("SELECT state FROM actions WHERE id = ?").get(id);
        if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `action ${id} not found`);
        throw new StoreError(STORE_ERROR_CODES.CONFLICT, `action ${id} has already been decided (state: ${existing.state})`);
      }
      appendActionAudit(id, decision, now, { decision });
      return rowToAction(db.prepare("SELECT * FROM actions WHERE id = ?").get(id));
    });
  }

  // Completes an approved action with its outcome. Only an "approved" action
  // can be completed, and only once (the same conditional-UPDATE pattern as
  // decideAction); the result and its audit event commit together.
  function recordActionResult(id, input) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new StoreError(STORE_ERROR_CODES.VALIDATION_ERROR, "id: must be a positive integer");
    // The result's shape depends on the action's kind (immutable once previewed).
    // An unknown id is validated as the default kind and then reported as not
    // found by the completion itself.
    const kind = db.prepare("SELECT kind FROM actions WHERE id = ?").get(id)?.kind;
    const data = validateActionResultInput(input, kind);
    return runInTransaction(db, () => completeApprovedAction(id, data));
  }

  // The one place an approved action becomes terminal: the conditional
  // UPDATE and its audit event. Must run inside a transaction. Shared by
  // recordActionResult and reconcileInterruptedActions below.
  function completeApprovedAction(id, data) {
    const now = nowMs();
    const stored = JSON.stringify({
      mutation: data.mutation,
      code: data.code,
      detail: data.detail,
      tabId: data.tabId,
      // Only a group action's result carries a group handle.
      ...(data.groupId === undefined ? {} : { groupId: data.groupId }),
      windowId: data.windowId,
      observed: data.observed,
    });
    const { changes } = db
      .prepare("UPDATE actions SET state = ?, completed_at = ?, result = ? WHERE id = ? AND state = 'approved'")
      .run(data.state, now, stored, id);
    if (changes !== 1) {
      const existing = db.prepare("SELECT state FROM actions WHERE id = ?").get(id);
      if (!existing) throw new StoreError(STORE_ERROR_CODES.NOT_FOUND, `action ${id} not found`);
      throw new StoreError(STORE_ERROR_CODES.CONFLICT, `action ${id} is not awaiting a result (state: ${existing.state})`);
    }
    appendActionAudit(id, "result", now, { state: data.state, mutation: data.mutation });
    return rowToAction(db.prepare("SELECT * FROM actions WHERE id = ?").get(id));
  }

  // Crash/restart reconciliation. An action is "approved" only between the
  // committed decision and its recorded result, so one found in that state
  // when the service starts was interrupted: the request may or may not have
  // reached the browser. Each becomes terminal `failed`, mutation "unknown",
  // with a stable code and an audit result event — never left approved
  // forever, which would also block `store.clear`.
  //
  // MUST only be called by the one service that owns this database — the one
  // holding the data-directory lock (service/cli.mjs's service.lock) — before
  // it serves any request. It cannot tell an interrupted action from one
  // another process is executing right now, and opening a store deliberately
  // does not call it; the lock is what makes "no other process" true.
  function reconcileInterruptedActions() {
    return runInTransaction(db, () => {
      const rows = db.prepare("SELECT id, kind FROM actions WHERE state = 'approved' ORDER BY id").all();
      for (const { id, kind } of rows) {
        completeApprovedAction(
          id,
          validateActionResultInput(
            {
              state: "failed",
              mutation: "unknown",
              code: ACTION_INTERRUPTED_CODE,
              detail: ACTION_INTERRUPTED_DETAIL,
            },
            kind,
          ),
        );
      }
      return { reconciledCount: rows.length };
    });
  }

  function listActions({ limit, offset, id, state } = {}) {
    const bounds = validateLimitOffset({ limit, offset });
    const { where, params } = buildWhere([
      ["id", optionalFilterPositiveInteger(id, "id")],
      ["state", optionalFilterEnum(state, ACTION_STATES, "state")],
    ]);
    const items = db.prepare(`SELECT * FROM actions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, bounds.limit, bounds.offset).map(rowToAction);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM actions ${where}`).get(...params).count;
    return { items, total };
  }

  function listActionAudit({ limit, offset, actionId } = {}) {
    const bounds = validateLimitOffset({ limit, offset });
    const { where, params } = buildWhere([["action_id", optionalFilterPositiveInteger(actionId, "actionId")]]);
    const items = db
      .prepare(`SELECT * FROM action_audit ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, bounds.limit, bounds.offset)
      .map((row) => ({ id: row.id, actionId: row.action_id, event: row.event, occurredAt: row.occurred_at, detail: JSON.parse(row.detail) }));
    const total = db.prepare(`SELECT COUNT(*) AS count FROM action_audit ${where}`).get(...params).count;
    return { items, total };
  }

  // ---- retention ----

  function getRetentionSettingsRaw() {
    const row = db.prepare("SELECT capture_retention_days, updated_at FROM retention_settings WHERE id = 1").get();
    return { captureRetentionDays: row.capture_retention_days, updatedAt: row.updated_at };
  }

  function getRetentionSettings() {
    return getRetentionSettingsRaw();
  }

  function updateRetentionSettings(input) {
    const data = validateRetentionUpdateInput(input);
    return runInTransaction(db, () => {
      db.prepare("UPDATE retention_settings SET capture_retention_days = ?, updated_at = ? WHERE id = 1").run(data.captureRetentionDays, nowMs());
      return getRetentionSettingsRaw();
    });
  }

  // Deletes every capture older than the configured retention window (by
  // `capturedAt`), cascading to any summary/proposal that cites one of
  // them — directly, or (for a proposal) transitively via a cited summary
  // — using the same computeCaptureDependents helper and proposals-before-
  // summaries ordering as deleteCapture's cascade (project.md Stage 3: "a
  // simple documented retention cleanup path"). Computed once across the
  // *whole batch* of expired captures, not once per capture, so a summary
  // or proposal cited by more than one expiring capture is only ever
  // targeted for deletion once — deleting it twice would otherwise be
  // harmless (a second DELETE by id simply affects zero rows) but the
  // per-capture counts would double-count it. A no-op, returning all-zero
  // counts, when retention is disabled (the default: `captureRetentionDays`
  // is null). Runs as a single transaction: if any part fails, nothing is
  // deleted. Invoked automatically once at each service start
  // (service/cli.mjs) and may also be triggered on demand via the
  // store.retention.cleanup route.
  function runRetentionCleanup() {
    const settings = getRetentionSettingsRaw();
    if (settings.captureRetentionDays === null) {
      return { ranAt: nowMs(), enabled: false, deletedCaptures: 0, deletedSummaries: 0, deletedProposals: 0 };
    }
    const cutoff = nowMs() - settings.captureRetentionDays * 24 * 60 * 60 * 1000;
    return runInTransaction(db, () => {
      const expiredIds = db.prepare("SELECT id FROM captures WHERE captured_at < ?").all(cutoff).map((r) => r.id);
      const { summaryIds, proposalIds } = computeCaptureDependents(expiredIds);

      const delProposal = db.prepare("DELETE FROM proposals WHERE id = ?");
      for (const proposalId of proposalIds) delProposal.run(proposalId);
      const delSummary = db.prepare("DELETE FROM summaries WHERE id = ?");
      for (const summaryId of summaryIds) delSummary.run(summaryId);
      const delCapture = db.prepare("DELETE FROM captures WHERE id = ?");
      for (const captureId of expiredIds) delCapture.run(captureId);

      return { ranAt: nowMs(), enabled: true, deletedCaptures: expiredIds.length, deletedSummaries: summaryIds.length, deletedProposals: proposalIds.length };
    });
  }

  // Deletes every application-managed backup file this store ever created
  // (backupDatabase, above: `<dbPath>.bak-<timestamp>`) from the database's
  // own directory. Run *after* clearAll's own transaction has already
  // committed (see clearAll below), not inside it: a backup file is a
  // filesystem side effect, not something SQLite's transaction can roll
  // back, so ordering it after the durable, transactional part of the
  // clear means the primary guarantee — live retained content is actually
  // erased — holds regardless of whether this filesystem step succeeds.
  // A failure here is still raised explicitly (never silently swallowed),
  // just understood as "the data clear itself already happened; removing
  // old backups did not."
  function deleteBackupFiles(path) {
    const dir = dirname(path);
    const prefix = `${DATABASE_FILE_NAME}.bak-`;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch (error) {
      throw new StoreError(STORE_ERROR_CODES.DB_ERROR, `failed to list the store directory for backup cleanup: ${error instanceof Error ? error.message : String(error)}`);
    }
    const deleted = [];
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) continue;
      try {
        unlinkSync(join(dir, entry));
        deleted.push(entry);
      } catch (error) {
        throw new StoreError(STORE_ERROR_CODES.DB_ERROR, `failed to remove backup file "${entry}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return deleted;
  }

  // Clears every retained captured and derived record (project.md Stage 3:
  // "a single operation to clear captured and derived data"), runs
  // `VACUUM`, and removes every backup file this store has ever created —
  // so a user can make retained browser content unrecoverable from this
  // store's own database file and its own backup files, not merely
  // unreachable through the API. (This is scoped to this application's
  // own managed files, not a guarantee against disk-level forensic
  // recovery of the underlying machine — see README.md's "What this does
  // and does not erase.") `secure_delete = ON` (see openStore above) means
  // the DELETEs below overwrite the freed content with zeros in the live
  // database file rather than leaving it sitting in reusable free pages,
  // and `VACUUM` additionally purges anything freed by an *earlier*
  // connection that ran with secure_delete OFF, which the DELETEs alone
  // cannot reach. Retention settings and migration history are service
  // configuration, not retained browser content or derived data, and are
  // left untouched. Child/join rows are deleted before their parents so no
  // RESTRICT foreign key is ever violated along the way; the table clears
  // are one transaction (see the VACUUM/deleteBackupFiles calls below for
  // why those two are separate, non-transactional steps after it).
  // Returns only `removedBackupCount` (below), never the list of deleted
  // filenames: a store that has accumulated many backup files over its
  // lifetime (nothing caps how many `.bak-*` files can exist on disk) must
  // not turn `store.clear`'s response into an unbounded array — the same
  // "committed, then risked an oversized response" failure mode documented
  // on deleteCapture above.
  function clearAll() {
    const deletedCounts = runInTransaction(db, () => {
      // Refused, with nothing deleted, while any action is approved but not
      // yet completed: its request may be in flight to the browser, and
      // deleting its record would orphan the result that is about to be
      // recorded. Both orderings are safe: a clear that commits first deletes
      // the preview, so a later approve is NOT_FOUND and mutates nothing; an
      // approve that commits first makes this clear a CONFLICT until the
      // result is terminal. (This runs under BEGIN IMMEDIATE, so it and
      // decideAction/recordActionResult cannot interleave.)
      const inFlight = db.prepare("SELECT COUNT(*) AS count FROM actions WHERE state = 'approved'").get().count;
      if (inFlight > 0) {
        throw new StoreError(
          STORE_ERROR_CODES.CONFLICT,
          `${inFlight} browser action(s) are approved and still awaiting their result; nothing was cleared. Try again once they complete.`,
        );
      }
      const order = [
        "queue_items",
        "tag_assignments",
        "collection_items",
        "proposal_sources",
        "summary_sources",
        "proposals",
        "summaries",
        "tags",
        "collections",
        "captures",
        // Phase 2: action records hold the observed tab's untrusted title/
        // URL, so they are cleared with the rest. The audit log
        // (action_audit) is append-only and holds no browser content, so it
        // is deliberately not here.
        "actions",
      ];
      const counts = {};
      for (const table of order) {
        const result = db.prepare(`DELETE FROM ${table}`).run();
        counts[table] = result.changes;
      }
      return counts;
    });
    // VACUUM must run outside any transaction (SQLite refuses it inside
    // one) — run here, after the delete transaction above has already
    // committed. This is more than tidying up: secure_delete only zeroes a
    // row's bytes at the moment *that connection* deletes it, so content
    // deleted earlier under a connection that had secure_delete OFF (e.g.
    // a pre-remediation run of this store, before secure_delete = ON was
    // introduced) can still be sitting unzeroed in a now-unused page that
    // no delete since has ever touched. VACUUM rebuilds the database file
    // from only its current, live data, so stale bytes like that — from
    // any point in this file's history, not only this clear's own deletes
    // — are not carried into the rebuilt file at all. See
    // test/store.test.mjs's dedicated regression for this exact scenario.
    db.exec("VACUUM");
    const removedBackupCount = deleteBackupFiles(dbPath).length;
    return { clearedAt: nowMs(), deletedCounts, removedBackupCount };
  }

  function close() {
    db.close();
  }

  return {
    dbPath,
    createCapture,
    listCaptures,
    readCapture,
    deleteCapture,
    createSummary,
    listSummaries,
    updateSummary,
    deleteSummary,
    createTag,
    listTags,
    deleteTag,
    assignTag,
    unassignTag,
    listTagAssignments,
    createCollection,
    listCollections,
    updateCollection,
    deleteCollection,
    addCollectionItem,
    removeCollectionItem,
    listCollectionItems,
    reorderCollectionItems,
    createQueueItem,
    listQueueItems,
    updateQueueItem,
    deleteQueueItem,
    createProposal,
    listProposals,
    updateProposalState,
    deleteProposal,
    createAction,
    decideAction,
    recordActionResult,
    reconcileInterruptedActions,
    listActions,
    listActionAudit,
    getRetentionSettings,
    updateRetentionSettings,
    runRetentionCleanup,
    clearAll,
    close,
  };
}
