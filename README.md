# Browser Tabs

A deterministic, local-first browser adapter for inspecting open browser windows, tabs, and page-content snapshots. Model integration is deliberately out of scope.

## Phase-one contract

- Enumerate extension-visible browser windows.
- Enumerate extension-visible tabs in a window.
- Read a versioned, bounded text snapshot from a tab that permits script injection.

The extension never rearranges, closes, creates, or navigates tabs in this phase.

## Support boundary

The code targets Manifest V3 WebExtensions: Chrome, Edge, Brave, Opera, and Firefox. Browsers may refuse content access to internal pages, extension-store pages, or other protected contexts. Those cases are returned as explicit outcomes, never as empty or invented page content.

## Local development

Load `extension/` as an unpacked extension in a Chromium browser. The prototype uses no network and has no external service.

Run the deterministic unit tests with:

```sh
npm test
```
