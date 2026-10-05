// Stable error codes for the Stage 3 derived store, kept separate from
// extension/protocol.js's ERROR_CODES: those identify browser-bridge
// transport/read-API outcomes, these identify local-store outcomes. Both are
// surfaced to an HTTP caller the same way (an explicit `code`), but they are
// different namespaces by design — a store error is never a browser-bridge
// outcome and vice versa.
export const STORE_ERROR_CODES = Object.freeze({
  // Caller-supplied input failed validation before any database statement
  // was attempted (shape, type, bounds, or an enum outside its allowed set).
  VALIDATION_ERROR: "validation_error",
  // A record addressed by id (get/update/delete, or a named singleton like
  // retention settings) does not exist.
  NOT_FOUND: "not_found",
  // A write referenced a source/parent record that does not exist — caught
  // via a SQLite "FOREIGN KEY constraint failed" error, never guessed at in
  // application code ahead of the database's own check.
  SOURCE_NOT_FOUND: "source_not_found",
  // A delete was refused because dependent derived records still reference
  // the target and the caller did not opt into cascading the delete.
  HAS_DEPENDENTS: "has_dependents",
  // A uniqueness constraint (tag name, collection name, ordered-membership
  // position) was violated.
  CONFLICT: "conflict",
  // The request body exceeded the store's bounded-request-size limit.
  PAYLOAD_TOO_LARGE: "payload_too_large",
  // The request body was not valid JSON, or was valid JSON but not a plain
  // object where one was required.
  MALFORMED_BODY: "malformed_body",
  // An unexpected database-layer failure (not a validation, FK, or
  // uniqueness outcome above). The transaction that produced it is always
  // rolled back before this is raised; never partially applied.
  DB_ERROR: "db_error",
});

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export function isForeignKeyViolation(error) {
  return typeof error?.message === "string" && error.message.includes("FOREIGN KEY constraint failed");
}

export function isUniqueViolation(error) {
  return typeof error?.message === "string" && error.message.includes("UNIQUE constraint failed");
}

// Normalizes anything thrown from inside a transaction into a StoreError:
// a StoreError raised deliberately (validation already done in JS) passes
// through unchanged; a raw SQLite foreign-key or uniqueness failure is
// translated into the corresponding stable code; anything else becomes an
// explicit DB_ERROR rather than an unstable, implementation-specific message
// reaching a caller.
export function toStoreError(error, { onForeignKeyViolation, onUniqueViolation } = {}) {
  if (error instanceof StoreError) return error;
  if (isForeignKeyViolation(error)) {
    return onForeignKeyViolation
      ? onForeignKeyViolation(error)
      : new StoreError(STORE_ERROR_CODES.SOURCE_NOT_FOUND, "a referenced source record does not exist");
  }
  if (isUniqueViolation(error)) {
    return onUniqueViolation
      ? onUniqueViolation(error)
      : new StoreError(STORE_ERROR_CODES.CONFLICT, "a uniqueness constraint was violated");
  }
  return new StoreError(STORE_ERROR_CODES.DB_ERROR, error instanceof Error ? error.message : String(error));
}
