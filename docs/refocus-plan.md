# Browser Tabs refocus plan

## Goal

Reduce Browser Tabs to a small local browser interface that can:

```text
browser.list_windows
browser.list_tabs
browser.read_tab
browser.list_tab_groups
browser.query_history

browser.create_tab_group
browser.update_tab_group
browser.move_tabs
```

The service will use one local pairing token with one permission level. Browser mutations will execute directly after validation rather than passing through proposals, previews, approvals, or an action store.

## Product boundaries

Keep:

- one local pairing token;
- service health, status, and stop operations;
- browser-session IDs and stale-handle protection;
- protocol and result-schema validation;
- bounded requests, responses, lists, history queries, and page text;
- explicit unsupported outcomes for browsers without tab-group APIs;
- Chrome/Chromium and Firefox packaging and read support.

Remove:

- separate owner and agent tokens;
- permission scopes and allowlists;
- SQLite and all persisted captures or derived records;
- summaries, tags, collections, queues, proposals, and retention;
- proposal decisions;
- the review UI;
- action previews, approvals, results, and audit records;
- open-tab and archive-tab operations;
- the agent-specific client and CLI;
- tests, migrations, release inputs, and documentation used only by removed features.

Existing database and obsolete token files must not be deleted automatically. After the refocus, the service simply stops using them. Documentation should explain that users may remove them manually.

## Mutation contract

All mutation methods will:

- require the single pairing token;
- validate request shape, browser session, and handles;
- re-read relevant browser state immediately before mutation;
- attempt the browser mutation once;
- return observed browser state rather than merely echoing the request;
- report stale, unsupported, partial, failed, and unknown outcomes explicitly;
- never retry automatically when the first attempt may have changed the browser.

The first implementation will not move tabs between windows, control tab ordering, or change a group's collapsed state.

## Phase 1 — Reduce to the read-only core

Remove the unnecessary vertical slices while preserving the low-level group and move implementations that can support later phases.

The public browser API at the end of this phase is:

```text
browser.list_windows
browser.list_tabs
browser.read_tab
browser.list_tab_groups
browser.query_history
```

Work:

1. Remove the review UI and its service routes, assets, helpers, and tests.
2. Remove captures, derived records, retention, SQLite initialization, migrations, and store tests.
3. Remove the agent credential, permission scopes, scoped allowlists, agent client, and client CLI.
4. Collapse authentication to the existing owner/pairing credential.
5. Remove the action store, preview/approval routes, audit log, reconciliation, and service-lock behavior needed only by persisted actions.
6. Remove open-tab and archive-tab browser operations.
7. Keep reusable group configuration and tab movement logic internal and temporarily unexposed.
8. Remove obsolete package scripts, release allowlist entries, tests, and documentation.
9. Update the service lifecycle check for the store-free service.

Prefer several small deletion changes over one undifferentiated rewrite so test failures remain attributable.

Exit criteria:

- [x] The service starts and stops without opening SQLite.
- [x] Pairing and API access use one token.
- [x] Only the five read methods above are publicly reachable. *(Superseded: Phases 1–3 landed together, so no read-only build was published; the final eight-method surface is verified under Phase 4.)*
- [x] Every retained read route passes unit and HTTP integration tests.
- [x] Chromium and Firefox read smoke tests pass.
- [x] No browser mutation is reachable through the public API. *(Superseded as above. In the final build the extension's `runtime.onMessage` listener still serves reads only; mutations arrive only over the authenticated service connection.)*
- [x] Release artifacts contain no removed UI, client, store, or migration files.
- [x] Existing local databases and obsolete tokens are left untouched.

## Phase 2 — Direct tab-group creation and updates

Expose:

```text
browser.create_tab_group
browser.update_tab_group
```

Proposed requests:

```json
{
  "browserSessionId": "<from a current browser result>",
  "tabIds": [12, 13],
  "title": "Reading",
  "color": "blue"
}
```

```json
{
  "browserSessionId": "<from a current browser result>",
  "groupId": 7,
  "title": "Research",
  "color": "red"
}
```

Rules:

- Creation requires one or more distinct, unpinned tabs in one window.
- A group cannot be created empty.
- Title and color are optional during creation.
- Update requires at least one title or color field and must produce an actual change.
- An empty update title removes the existing title.
- Colors are restricted to the browser's supported tab-group color enum.
- Collapsed state is observed if useful but cannot be requested or changed.
- A tab or group that changes between validation and execution produces an explicit stale outcome.
- Browsers without the required tab-group APIs return an unsupported outcome without mutation.

Implementation guidance:

- Reuse the existing extension-side group normalization, validation, mutation, and observation logic where it matches this contract.
- Replace the preview inspection and approval orchestration with direct authenticated service routes.
- Use the new public method names consistently at the HTTP and extension protocol boundaries.

Exit criteria:

- [x] One authenticated request can create a group.
- [x] One authenticated request can rename or recolor a group.
- [x] Creation and update return the observed final group.
- [x] Stale sessions, stale handles, pinned tabs, and cross-window inputs mutate nothing.
- [x] Unsupported browsers mutate nothing and return a stable result.
- [x] No preview, approval, database, or audit code participates in either operation.
- [x] Unit, HTTP integration, and real-Chromium smoke tests pass.

## Phase 3 — Direct tab movement

Expose:

```text
browser.move_tabs
```

Move tabs into an existing group:

```json
{
  "browserSessionId": "<from a current browser result>",
  "tabIds": [12, 13],
  "groupId": 7
}
```

Move tabs out of their groups:

```json
{
  "browserSessionId": "<from a current browser result>",
  "tabIds": [12, 13],
  "groupId": null
}
```

Rules:

- Accept 1–100 distinct tab IDs.
- One tab uses the same array-based method as several tabs.
- All selected tabs must be in one window.
- A non-null destination group must be in that same window.
- Selected tabs must be unpinned.
- `groupId: null` explicitly ungroups the selected tabs.
- Moving every tab out of a group lets the browser remove the resulting empty group; there is no separate delete-group operation.
- Moving every selected tab to the group it already occupies is rejected as a no-op.
- Tabs may come from multiple source groups.
- The result reports the destination group and selected tabs as observed after the operation.
- Cross-window movement and tab ordering are not part of this phase.

Implementation guidance:

- Reuse the existing extension-side move validation, mutation, and observation logic where it matches this contract.
- Extend it with the explicit `groupId: null` ungroup operation.
- Remove preview-bound state from the request model; instead, inspect and validate current state during the direct operation.

Exit criteria:

- [x] A single tab can move into another group.
- [x] Several tabs can move together using one browser operation where supported.
- [x] Tabs can move from multiple source groups into one destination group.
- [x] `groupId: null` ungroups tabs.
- [x] A group disappears naturally after its final tab is moved out.
- [x] Stale, partial, failed, and unknown outcomes are explicit and tested.
- [x] Unsupported browsers mutate nothing and return a stable result.
- [x] Unit, HTTP integration, and real-Chromium smoke tests pass.

## Phase 4 — Consolidate and publish the reduced contract

Work:

1. Rewrite the README around installation, the single-token model, and the eight-method API.
2. Document exact request and result shapes, bounds, errors, and browser support.
3. Remove historical documentation that describes deleted behavior, preserving only material that still explains the current implementation.
4. Update extension builds, release manifests, release allowlists, and CI checks.
5. Add a small direct-client example only if a concrete consumer needs one; do not recreate a client abstraction speculatively.
6. Run the complete unit, integration, lifecycle, release, and browser-smoke verification set.

Exit criteria:

- [x] User documentation describes only implemented behavior.
- [x] The public API contains exactly the agreed browser methods.
- [x] One token grants access to the complete API.
- [x] Release artifacts contain only required runtime and documentation files.
- [ ] Required macOS and Linux checks pass. *(macOS verified locally — tests, versions, lifecycle, audit, release. Linux runs in CI and has not been observed for this change.)*
- [x] Chromium read and mutation smoke tests pass.
- [x] Firefox read smoke tests pass and group mutations report unsupported cleanly.

## Deferred functionality

Document but do not implement:

- moving tabs among windows;
- moving an entire group between windows while defining whether identity and metadata are preserved;
- reordering tabs within a window or group;
- changing a tab group's collapsed state.

Each deferred feature should begin with a concrete request and an explicit browser-state contract rather than being anticipated in the core API.
