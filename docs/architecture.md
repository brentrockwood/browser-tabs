# Architecture and security

## Components

```text
local programs <-> HTTP service <-> WebSocket <-> WebExtension <-> browser
```

The WebExtension is the browser adapter. It owns every browser API call, session and handle checks, and the state rules for the three tab-group changes. The Node.js service (`service/`) owns the local boundary: authentication, protocol checks, request bounds, and validation of everything the extension sends back. Nothing is persisted except the pairing token. Browser Tabs does not call a model.

The request and result contract lives in `extension/protocol.js` and is shared by both sides: the service applies the same request validators before forwarding a change, and the extension applies them again before acting.

## Local boundary

The service binds to `127.0.0.1` and accepts only the exact `Host: 127.0.0.1:<listening port>`, which defeats DNS rebinding before any route runs. Every `/api/*` request needs the pairing token and the protocol version. The extension's WebSocket must present a Chrome or Firefox extension origin and authenticate with the same token before any request is sent to it.

There is one credential and one permission level. The token is 32 random bytes stored in `~/.browser-tabs/credential` with user-only permissions, created race-safely on first start and reused afterwards. It is never embedded in extension or release artifacts.

The extension's own `runtime.onMessage` listener serves only the five reads. The three changes are dispatched only for requests arriving over the authenticated service connection, so other extension pages and message senders cannot change the browser.

## Untrusted content

Titles, URLs, page text, history entries, and extension responses are untrusted input. Browser results carry a schema version, the browser-session ID, the source operation, a capture timestamp, and an explicit status with a stable code when it is not `ok`. The service checks each result's envelope and method-specific shape before returning it. For a change, it also checks that a reported change belongs to the requested session, tabs, and group; anything else becomes `invalid_extension_response` with an unknown outcome.

## Sessions and bounds

Window, tab, and group IDs are handles within one browser session. The session ID lives in `storage.session`, so a browser restart rotates it. Requests with an old or missing session get `stale_session`; handles that no longer resolve get `stale_handle`. Neither is ever retargeted.

Lists, history scans, page text, request bodies, response sizes, and the request rate are bounded (see the README for the numbers). History pagination is deterministic while history is unchanged, and reports `incomplete` rather than silently omitting entries when its scan ceiling is reached.

## Change model

The three changes share one contract:

1. The service authenticates the request, bounds and validates its body, and forwards it once.
2. The extension checks the session, re-validates the request, and re-reads the tabs and group involved.
3. Current-state rules are applied: one window, no pinned tabs, a destination group in the same window, and a request that would actually change something.
4. The extension makes one browser call (`tabs.group`, `tabs.ungroup`, or `tabGroups.update`), plus at most one `tabGroups.update` for a new group's title and color.
5. It reads the result back and reports what the browser shows.

Every outcome says whether the browser changed: `false` (refused before the call), `true` (the call resolved; `incomplete` if a follow-up step or the read-back did not complete), or `null` (attempted, effect unknown). Nothing is retried, because a lost answer may hide a change that already happened.

## Known limits

- One local user and one connected browser profile.
- No remote access or multi-user hosting.
- Tab-group changes depend on Chromium's tab-group APIs; Firefox reports them unsupported.
- Browser APIs offer no atomic read-and-change. The extension re-reads immediately before its one call, but a change made by hand in between is not detected.
- Tabs cannot be moved between windows or reordered, and a group's collapsed state cannot be changed.
