// Stage 5 remediation: deterministic unit tests for the pure, DOM-free
// race-prevention primitives ui/app.js is built on (ui/lib.mjs). No
// browser, no mocked DOM — these are plain functions/closures, imported
// directly the same way a Node test imports any other module.
import assert from "node:assert/strict";
import test from "node:test";

import { createDecisionTracker, createGenerationCounter, createListVersionGuard, DECISION_STATES, isReplacedSession } from "../ui/lib.mjs";

test("isReplacedSession: only a different session than a previously known one is a replacement", () => {
  assert.equal(isReplacedSession("s1", "s2"), true);
  assert.equal(isReplacedSession("s1", "s1"), false, "the same session leaves a chosen target alone");
  assert.equal(isReplacedSession(null, "s1"), false, "the first session learned is not a replacement");
  assert.equal(isReplacedSession(undefined, "s1"), false);
  assert.equal(isReplacedSession("", "s1"), false);
  for (const next of [null, undefined, "", 5, {}]) assert.equal(isReplacedSession("s1", next), false, String(next));
});

test("createGenerationCounter: bump invalidates every prior snapshot", () => {
  const gen = createGenerationCounter();
  const snapshot = gen.snapshot();
  assert.equal(gen.isStale(snapshot), false);
  const next = gen.bump();
  assert.equal(next, snapshot + 1);
  assert.equal(gen.isStale(snapshot), true);
  assert.equal(gen.isStale(gen.snapshot()), false);
});

test("createGenerationCounter: multiple bumps compound and `current` reflects the latest value", () => {
  const gen = createGenerationCounter();
  gen.bump();
  gen.bump();
  const snapshot = gen.snapshot();
  assert.equal(gen.current, 2);
  gen.bump();
  assert.equal(gen.isStale(snapshot), true);
  assert.equal(gen.current, 3);
});

test("createListVersionGuard: a newer start() always wins over an older one, regardless of apply order", () => {
  const guard = createListVersionGuard();
  const older = guard.start();
  const newer = guard.start();

  // The newer request's own result applies first (e.g. it happened to
  // resolve faster than the older, now-superseded one).
  assert.equal(guard.canApply(newer), true);
  assert.equal(guard.apply(newer), true);

  // The older request's result must never be allowed to overwrite it,
  // even though it has never itself been applied before.
  assert.equal(guard.canApply(older), false);
  assert.equal(guard.apply(older), false);
});

test("createListVersionGuard: the same token can only ever be applied once", () => {
  const guard = createListVersionGuard();
  const token = guard.start();
  assert.equal(guard.apply(token), true);
  assert.equal(guard.apply(token), false);
  assert.equal(guard.canApply(token), false);
});

test("createListVersionGuard: sequential refreshes each apply cleanly in order", () => {
  const guard = createListVersionGuard();
  const first = guard.start();
  assert.equal(guard.apply(first), true);
  const second = guard.start();
  assert.equal(guard.apply(second), true);
  const third = guard.start();
  assert.equal(guard.apply(third), true);
});

test("createDecisionTracker: begin() succeeds once, refuses while submitting", () => {
  const tracker = createDecisionTracker();
  assert.equal(tracker.stateFor(1), DECISION_STATES.IDLE);
  assert.equal(tracker.begin(1), true);
  assert.equal(tracker.stateFor(1), DECISION_STATES.SUBMITTING);
  // A second, concurrent attempt (e.g. a double click that slipped past a
  // disabled-button race) must be refused outright.
  assert.equal(tracker.begin(1), false);
});

test("createDecisionTracker: commit() is permanent — begin() can never restart a committed decision", () => {
  const tracker = createDecisionTracker();
  tracker.begin(7);
  tracker.commit(7);
  assert.equal(tracker.isCommitted(7), true);
  assert.equal(tracker.begin(7), false);
  assert.equal(tracker.isCommitted(7), true);
});

test("createDecisionTracker: fail() allows a fresh retry (PATCH itself never reached/succeeded)", () => {
  const tracker = createDecisionTracker();
  tracker.begin(3);
  tracker.fail(3);
  assert.equal(tracker.stateFor(3), DECISION_STATES.FAILED);
  assert.equal(tracker.isCommitted(3), false);
  assert.equal(tracker.begin(3), true);
});

test("createDecisionTracker: tracks independent ids independently", () => {
  const tracker = createDecisionTracker();
  tracker.begin(1);
  tracker.commit(1);
  assert.equal(tracker.begin(2), true);
  assert.equal(tracker.isSubmitting(2), true);
  assert.equal(tracker.isCommitted(1), true);
  assert.equal(tracker.isCommitted(2), false);
});

test("createDecisionTracker: reset() clears tracked state for an id", () => {
  const tracker = createDecisionTracker();
  tracker.begin(5);
  tracker.commit(5);
  tracker.reset(5);
  assert.equal(tracker.stateFor(5), DECISION_STATES.IDLE);
  assert.equal(tracker.begin(5), true);
});
