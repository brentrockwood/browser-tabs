// Stage 5 remediation: small, pure, DOM-free helpers factored out of
// ui/app.js specifically so the race-prevention logic they implement can
// be unit tested deterministically (see test/ui-lib.test.mjs) without a
// browser or any mocked DOM. Nothing in this file touches `document`,
// `window`, or `fetch` — it is plain state-machine/counter logic, loaded
// by ui/app.js as a native ES module (no bundler, no framework: this is a
// language feature both Node and every current browser support natively).

// A monotonically increasing generation counter. `bump()` invalidates
// every previously issued snapshot; `isStale(snapshot)` tells a caller
// whether anything has bumped the generation since that snapshot was
// taken. Used for two independent lifecycles in ui/app.js: the owner-auth
// "generation" (bumped on Disconnect, so a Connect attempt or any other
// in-flight request cannot complete and mutate the page after the user
// disconnects) and the browser-session "generation" (bumped on Disconnect,
// on every fresh "Load windows" click, and whenever a stale browser
// session is detected — see createDecisionTracker's header comment for
// why this must never be conflated with the derived-store-side state
// below).
export function createGenerationCounter() {
  let generation = 0;
  return {
    get current() {
      return generation;
    },
    bump() {
      generation += 1;
      return generation;
    },
    snapshot() {
      return generation;
    },
    isStale(snapshot) {
      return snapshot !== generation;
    },
  };
}

// Guards a sequence of list-refresh requests so that an older request
// resolving *after* a newer one has already started (or already applied)
// can never overwrite the newer result — "generation/version list
// requests so older refresh cannot overwrite newer." `start()` is called
// synchronously before issuing a request and returns that request's own
// token; `canApply(token)` must be checked after the request resolves but
// before any rendering; `apply(token)` both performs that same check and
// (if it passes) commits the token as the latest applied one, atomically,
// so two concurrent callers can never both believe they "won."
export function createListVersionGuard() {
  let latestStarted = 0;
  let latestApplied = 0;
  return {
    start() {
      latestStarted += 1;
      return latestStarted;
    },
    canApply(token) {
      return token === latestStarted && token > latestApplied;
    },
    apply(token) {
      if (token !== latestStarted || token <= latestApplied) return false;
      latestApplied = token;
      return true;
    },
  };
}

// True only when a fresh result names a browser session different from the
// previous *known* one — i.e. the browser session was replaced, so handles
// chosen under the old one (e.g. the tab-group form's target) must not be
// carried over. The first session ever learned, a missing/invalid value, and
// the same session seen again are all not a replacement.
export function isReplacedSession(previous, next) {
  return typeof previous === "string" && previous.length > 0 && typeof next === "string" && next.length > 0 && previous !== next;
}

export const DECISION_STATES = Object.freeze({
  IDLE: "idle",
  SUBMITTING: "submitting",
  COMMITTED: "committed",
  FAILED: "failed",
});

// Tracks a proposal decision's own lifecycle (idle -> submitting ->
// committed | failed) *outside* any one rendered row, keyed by proposal
// id, so a row that gets destroyed and re-created by a list re-render
// (which happens on every successful refresh) never loses track of
// whether a decision for that id is in flight or already committed.
// This is deliberately a separate concept from createGenerationCounter
// above: a decision's "committed" state must survive an owner-auth
// generation bump just as poorly as it must survive anything else — once
// the server has recorded a decision, this tracker's job is only to make
// sure the UI layer never asks it to submit (or re-submit) that same
// decision again, never to decide whether a given render is still
// "current" (that is the generation counter's job, checked separately by
// the caller).
export function createDecisionTracker() {
  const byId = new Map();

  function begin(id) {
    const existing = byId.get(id);
    if (existing && (existing.state === DECISION_STATES.SUBMITTING || existing.state === DECISION_STATES.COMMITTED)) {
      return false;
    }
    byId.set(id, { state: DECISION_STATES.SUBMITTING });
    return true;
  }

  function commit(id) {
    byId.set(id, { state: DECISION_STATES.COMMITTED });
  }

  function fail(id) {
    byId.set(id, { state: DECISION_STATES.FAILED });
  }

  function stateFor(id) {
    return byId.get(id)?.state ?? DECISION_STATES.IDLE;
  }

  function isCommitted(id) {
    return stateFor(id) === DECISION_STATES.COMMITTED;
  }

  function isSubmitting(id) {
    return stateFor(id) === DECISION_STATES.SUBMITTING;
  }

  function reset(id) {
    byId.delete(id);
  }

  return { begin, commit, fail, stateFor, isCommitted, isSubmitting, reset };
}
