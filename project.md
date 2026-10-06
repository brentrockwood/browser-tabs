# Browser Tabs

Browser Tabs makes a person's own browser available to local programs as a small, typed interface. A WebExtension exposes browser state; a service running as the same user on loopback authenticates callers and validates everything that crosses between them. The browser stays the place where the person browses, and any reasoning about what to do with that state happens outside the project.

The project started larger: a SQLite store of captures and derived records, a review UI, a second scoped token for agents, and preview-then-approve browser actions. In practice that machinery was more than any consumer needed. The [refocus](docs/refocus-plan.md) reduced it to what a caller actually uses: read the browser, and organize tabs into groups directly. The earlier design and its verification record are kept, as history only, in [docs/implementation-history.md](docs/implementation-history.md).

## Scope

Eight browser methods, one pairing token, and the operational `health`, `status`, and `stop`:

```text
browser.list_windows        browser.create_tab_group
browser.list_tabs           browser.update_tab_group
browser.read_tab            browser.move_tabs
browser.list_tab_groups
browser.query_history
```

The [README](README.md) documents each request and result. Chrome and Chromium support all eight; Firefox supports the reads and reports tab-group methods unsupported.

## Trust model

The local service is a trusted, same-user component. It binds only to loopback and keeps its token with user-only permissions. Loopback alone is not authentication — browser pages can reach localhost — so every API request carries the token, the `Host` header must be the exact loopback address, and the extension's WebSocket must come from an extension origin.

The browser is different. Every title, URL, page body, and history entry is untrusted input, returned as data and never treated as instructions. The extension's responses are validated at the service boundary like any other untrusted input.

## Protocol rules

- Every request carries a protocol version; incompatible changes require a new one.
- Every named request gets a request ID and either a typed result or a stable error code.
- Browser results carry a browser-session ID, capture time, source operation, and status.
- Window, tab, and group IDs are browser-session handles, never durable identities. Stale sessions and handles are rejected, not retargeted.
- Lists, text, history, and request bodies are bounded.
- Unsupported, not-ready, stale, partial, failed, unknown, disconnected, and internal outcomes stay distinguishable.
- A change is attempted at most once and reports what the browser shows afterwards, including whether anything changed.
- No API accepts page JavaScript, cookies, or debugger commands.

## Status

The refocus is complete; see the plan for what was verified. Deferred until a concrete request defines its browser-state contract:

- moving tabs between windows;
- moving a whole group between windows;
- ordering tabs within a window or group;
- changing a group's collapsed state.
