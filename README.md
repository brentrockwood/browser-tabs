# Browser Tabs

Browser Tabs is a small local interface to your browser. A WebExtension talks to a Node.js service on `127.0.0.1`, and local programs call that service over HTTP to list windows, tabs, and tab groups, read a tab's rendered text, query history, and make three kinds of tab-group change: create a group, rename or recolor one, and move tabs into or out of groups.

Everything stays on your machine. There is one pairing token, no database, and no model integration.

## Requirements

- Node.js 24 or newer, and npm
- Chrome, Chromium, or Firefox (Firefox supports the reads; tab-group changes report `unsupported`)
- macOS or Linux for the service

## Install

```sh
git clone <this repository> browser-tabs
cd browser-tabs
npm install
npm run build:extension
```

Load the extension:

- **Chrome or Chromium:** open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `dist/extension/chrome/` (or `extension/` directly during development).
- **Firefox:** open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on…**, and select `dist/extension/firefox/manifest.json`. Firefox removes temporary add-ons when it quits.

Start the service and pair the extension:

```sh
npm run service -- start
```

The first start prints a pairing token. Paste it into the extension's options page and save. The extension then connects to `ws://127.0.0.1:8743/extension`. The same token authenticates every API request; there are no other credentials or permission levels.

The token is printed only when it is created. Show it again with:

```sh
npm run service -- show-token
```

## Run the service

```sh
npm run service -- start    # foreground
npm run service -- status
npm run service -- stop
```

The service listens on `http://127.0.0.1:8743`. The extension can only reach that port, so `BROWSER_TABS_PORT` is useful only for tests. Local state lives in `~/.browser-tabs/` unless `BROWSER_TABS_DATA_DIR` is set:

- `credential` — the pairing token (user-only permissions)
- `service.port`, `service.pid` — written while the service runs, removed on stop

`status` and `stop` find the service by probing the recorded port; `stop` asks the service to shut itself down through the authenticated `POST /control/stop`.

### Files left by earlier versions

Earlier versions kept a SQLite database (`browser-tabs.db`, its `-wal`/`-shm` files, and pre-migration backups), a second `agent-token`, and a `service.lock` file in the same directory. The current service never reads, changes, or deletes them. Remove them yourself if you no longer need them:

```sh
npm run service -- stop
rm -f ~/.browser-tabs/browser-tabs.db* ~/.browser-tabs/agent-token ~/.browser-tabs/service.lock
```

Look at `~/.browser-tabs/` first if you kept backups there under other names.

## Call the API

Every `/api/*` request needs:

```http
Authorization: Bearer <token>
X-Protocol-Version: 7
```

`X-Request-Id` (up to 200 characters) is optional and echoed back. Every response has `protocolVersion`, `requestId`, and exactly one of `result` or `error`.

```sh
TOKEN="$(npm run --silent service -- show-token)"

curl -H "Authorization: Bearer $TOKEN" -H "X-Protocol-Version: 7" \
  http://127.0.0.1:8743/api/browser.list_windows
```

The API has exactly eight methods. Reads use `GET /api/<method>` with query parameters; changes use `POST /api/<method>` with a JSON body. Any other path, or the wrong HTTP method for a name, is `404 not_found`.

| Method | Request |
| --- | --- |
| `browser.list_windows` | `GET`, no parameters |
| `browser.list_tabs` | `GET ?windowId=&browserSessionId=` |
| `browser.list_tab_groups` | `GET ?windowId=&browserSessionId=` |
| `browser.read_tab` | `GET ?tabId=&browserSessionId=` |
| `browser.query_history` | `GET ?startTime=&endTime=` plus optional `maxResults`, `cursor` |
| `browser.create_tab_group` | `POST {"browserSessionId", "tabIds", "title"?, "color"?}` |
| `browser.update_tab_group` | `POST {"browserSessionId", "groupId", "title"?, "color"?}` |
| `browser.move_tabs` | `POST {"browserSessionId", "tabIds", "groupId"}` |

`GET /health` (protocol header, no token) reports whether the service is up and the extension connected. `POST /control/stop` (token) shuts the service down.

### Sessions and handles

Window, tab, and group IDs are handles that are only meaningful within one browser session. Every result carries the current `browserSessionId`; take it from a `browser.list_windows` result and pass it back with every handle. A browser restart rotates the session, and any request with an old or missing session gets `stale_session` instead of being applied to whatever the old number now means. A handle that no longer exists gets `stale_handle`.

### Results

A browser result is an envelope plus method-specific fields:

```json
{
  "protocolVersion": 7,
  "requestId": "…",
  "result": {
    "schemaVersion": 1,
    "browserSessionId": "…",
    "sourceOperation": "browser.list_windows",
    "capturedAt": 1735900000000,
    "status": "ok",
    "windows": [{ "windowId": 1, "focused": true, "type": "normal", "state": "normal", "tabCount": 3 }],
    "returnedCount": 1,
    "totalCount": 1,
    "truncated": false
  }
}
```

`status` is one of `ok`, `error`, `unsupported`, `not_ready`, or `incomplete`. Anything but `ok` carries a stable `code` and often a `detail`. These outcomes still use HTTP 200: the request reached the browser, and the result says what happened. The service validates every extension result before returning it, so a malformed answer becomes `502 invalid_extension_response` rather than a 200.

Titles, URLs, page text, and history entries are untrusted browser content, returned as data.

### Reads

- `browser.list_windows` → `windows[]` of `{windowId, focused, type, state, tabCount}`, at most 500.
- `browser.list_tabs` → `windowId`, `tabs[]` of `{tabId, windowId, index, active, pinned, audible, discarded, groupId, status, title, url}`, at most 2,000. `groupId` is the tab's group, or `-1` when it is in none (always `-1` on browsers without tab groups); filter on it to find the `tabIds` in a group before calling `browser.move_tabs`.
- `browser.list_tab_groups` → `windowId`, `groups[]` of `{groupId, windowId, title, color, collapsed}`, at most 500. A browser without tab groups answers `unsupported` / `unsupported_feature`.
- Lists also report `returnedCount`, `totalCount`, and `truncated`.
- `browser.read_tab` → `tabId`, `windowId`, `url`, `title`, `documentReadyState`, and the rendered body `text` (not HTML), capped at 500,000 characters, with `characterCount`, `returnedCharacterCount`, and `truncated`. A tab still loading is `not_ready` / `tab_loading`; a page the browser will not let the extension script (internal pages, extension stores) is `unsupported` / `injection_rejected`.
- `browser.query_history` → `entries[]` of `{id, url, title, lastVisitTime, visitCount, typedCount}`, most recent first. `startTime` and `endTime` (milliseconds since the epoch) are required; `maxResults` is 1–500 (default 100); `cursor` is the `nextCursor` of the previous page. Pages are cut from one sorted scan of at most 5,000 entries; when that ceiling prevents a reliable page the result is `incomplete` / `pagination_limit_reached`. Pages are deterministic only while history itself is unchanged.

### Changes

The three change methods act directly: no preview, approval, or stored record. Each one validates the body (at most 16 KiB; unknown fields are refused, so an option the API does not have can never be silently ignored), forwards it to the extension once, and returns what the browser reports afterwards. Before changing anything the extension checks the session, re-reads the tabs and group involved, and applies these rules:

- `tabIds` lists 1–100 distinct tabs. All must be in one window and none may be pinned.
- `color` is one of `grey`, `blue`, `red`, `yellow`, `green`, `pink`, `purple`, `cyan`, `orange`. `title` is plain text up to 100 characters.

**`browser.create_tab_group`** makes one group around the tabs, in their window. Title and color are optional; a new group's title may not be empty (omit it instead). The tabs may already be in other groups. The result is the new `group` and the `tabs` as observed in it.

**`browser.update_tab_group`** renames and/or recolors one group. At least one of `title` or `color` is required, and `"title": ""` removes the title. Only fields that differ from the group's current state are sent to the browser; a request that would change nothing is refused as `no_change`. The result is the `group` as observed afterwards.

**`browser.move_tabs`** has an explicit destination. With a `groupId`, the tabs move into that existing group, which must be in their window. With `"groupId": null`, they leave their groups. Tabs may come from several groups, and a group left with no tabs is removed by the browser itself — there is no separate delete. If every tab is already where it would go, the request is refused as `no_change`. The result is `group` (`null` for an ungroup) and the `tabs` as observed afterwards.

```json
{ "browserSessionId": "…", "tabIds": [12, 13], "title": "Reading", "color": "blue" }
{ "browserSessionId": "…", "groupId": 7, "title": "Research", "color": "red" }
{ "browserSessionId": "…", "tabIds": [12, 13], "groupId": 7 }
{ "browserSessionId": "…", "tabIds": [12, 13], "groupId": null }
```

Every change response states `changed`, in the result or in the error:

| `changed` | Meaning | Typical status / code |
| --- | --- | --- |
| `true` | The browser was changed. `ok` means fully observed. | `ok`, or `incomplete` with `group_update_failed` (a new group exists without its title/color) or `observe_failed` (the read-back failed or disagreed) |
| `false` | Nothing was changed. | `stale_session`, `stale_handle`, `pinned_tab`, `window_mismatch`, `no_change`, `invalid_params`, `unsupported_feature`; also every HTTP error before the request reached the extension |
| `null` | The one browser call was attempted, but whether it took effect is unknown. | `group_failed`, `ungroup_failed`, `group_update_failed` (update), or a lost answer: `504 request_timeout`, `503 disconnected`, `502 invalid_extension_response` |

An `incomplete` result also carries `groupId`, `windowId`, and `tabIds` — `null`, or the requested tabs that were actually observed where they were sent, in request order. Nothing is ever retried automatically: re-read the browser before deciding to send the request again. The browser has no atomic read-and-change, so a change made by hand between the extension's re-read and its call is not detected.

Not supported: moving tabs between windows, moving a whole group to another window, ordering tabs, and changing a group's collapsed state (it is reported, never changed).

### HTTP errors

| Status | Codes |
| --- | --- |
| 400 | `unsupported_protocol_version`, `invalid_request` (malformed target or JSON body), `invalid_params` (body shape) |
| 401 | `missing_credential`, `invalid_credential` |
| 404 | `not_found` |
| 413 | `payload_too_large` |
| 421 | `invalid_host` — only `Host: 127.0.0.1:<port>` is accepted |
| 429 | `rate_limited` — 30 requests per second across all callers |
| 502 | `invalid_extension_response`, `response_too_large` (over 2 MiB), `internal_error` |
| 503 | `disconnected`, `service_shutting_down` |
| 504 | `request_timeout` (10 seconds) |

## Browser support

| | Chrome / Chromium | Firefox |
| --- | --- | --- |
| Reads | Yes | Yes |
| `browser.list_tab_groups` | Yes | `unsupported` |
| Tab-group changes | Yes | `unsupported`, `changed: false` |

Support is detected from the APIs the browser exposes, not from its name.

## Upgrade and uninstall

```sh
git pull
npm install
npm run build:extension
npm run service -- stop
npm run service -- start
```

Reload the extension after rebuilding. The pairing token survives upgrades. An extension and service on different protocol versions refuse to pair, so rebuild and reload both together.

To uninstall, stop the service, remove the extension, and delete `~/.browser-tabs/`.

## Documentation

- [Architecture and security](docs/architecture.md)
- [Development, testing, and releases](docs/development.md)
- [Project scope](docs/project.md)
- [Refocus plan](docs/refocus-plan.md) — how the project reached this shape
