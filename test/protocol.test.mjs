import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTab, normalizeWindow, unsupportedSnapshot } from "../extension/protocol.js";

test("normalizes a window without leaking browser-specific fields", () => {
  assert.deepEqual(normalizeWindow({ id: 7, focused: 1, type: "normal", state: "maximized", tabs: [{}, {}] }), {
    windowId: 7,
    focused: true,
    type: "normal",
    state: "maximized",
    tabCount: 2,
  });
});

test("normalizes tab metadata with explicit nulls for absent sensitive fields", () => {
  assert.deepEqual(normalizeTab({ id: 4, windowId: 7, index: 1, active: false, pinned: false, audible: false, discarded: false }), {
    tabId: 4,
    windowId: 7,
    index: 1,
    active: false,
    pinned: false,
    audible: false,
    discarded: false,
    status: "unknown",
    title: null,
    url: null,
  });
});

test("represents unavailable content as an explicit unsupported result", () => {
  assert.deepEqual(unsupportedSnapshot(9, "Cannot access contents"), {
    schemaVersion: 1,
    tabId: 9,
    status: "unsupported",
    reason: "Cannot access contents",
  });
});
