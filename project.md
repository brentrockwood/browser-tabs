# Browser Tabs

Browser Tabs makes a person's browser available as a standalone automation
target: first to read, summarize, and organize the tabs, pages, and history
that already belong to them. It is local-first. The browser is not an agent
tool in the abstract; it is a source of personal working context.

The core idea is modest. A WebExtension exposes browser state through a
small, typed interface. A lightweight service, running as the same local user,
connects that interface to programs and agents. The service keeps the useful
state outside the browser: summaries, collections, provenance, and proposed
organization. The browser remains the place where the person browses.

## Direction

The project should work on the Mac now and carry cleanly to a future Linux
desktop. That favors standard WebExtension APIs and a replaceable local
bridge over Chromium-only DevTools attachment or a custom browser.

The intended shape is:

```text
local programs and agents
        <-> user service <-> WebSocket <-> WebExtension <-> browser
```

The extension maintains the browser-side connection. Programs make ordinary,
versioned requests to the service. A later remote mode can tunnel or otherwise
authenticate the service without changing the extension protocol. Remote
access is not a phase-one requirement.

## Trust model

The local service is a trusted, same-user component. Its API may be powerful;
early limits are principally for clarity and implementation scope.

The browser is different. Every title, URL, page body, DOM label, history
entry, console message, and network artifact is untrusted input. The system
must carry that provenance through extraction and present it to an LLM as
evidence, never as instructions or authority. Browser content cannot expand
the available API, alter policy, or approve an action.

This is a semantic boundary, not a claim that a local extension or service is
a security sandbox.

## Phase 1

Build a useful local read-and-organize loop.

- Enumerate windows, tabs, and tab groups where the browser permits it.
- Read bounded, versioned page snapshots and surface explicit unsupported or
  not-ready outcomes.
- Query browsing-history metadata separately from open tabs.
- Keep summaries, tags, queues, collections, and source provenance in a
  service-owned derived store.
- Let an agent propose organization from that derived data.
- Provide a transparent user-facing view of what was read, what was inferred,
  and the proposed organization.

The initial API should remain typed and explicit. It should prefer stable
window/tab handles over positions, bounded payloads over raw browser dumps,
and records with URLs, timestamps, capture status, and truncation information
over unlabelled text.

## Browser actions

Reading and organizing derived information are the first job. Browser
mutations can follow, but should be named operations rather than incidental
side effects: create or move a tab group, archive a tab, open a URL, and so
on. Each must report exactly what it changed. Destructive or consequential
operations require an action-time user decision.

Arbitrary page evaluation, direct cookie export, and general browser-debugger
control are not part of the default agent-facing interface. They may be useful
trusted-local capabilities later, but do not belong in the first contract.

## Current starting point

The repository currently contains a deterministic Manifest V3 inspector. It
lists extension-visible windows and tabs, and reads bounded rendered text from
a tab when script injection is permitted. It has no network service and makes
no browser mutations. That is the tested base to extend; it is not yet the
service-and-extension system described above.

## Non-goals for now

- Building a new browser.
- Replacing the browser's history database or normal tab UI.
- Hiding browser automation behind an opaque agent workflow.
- Designing remote access before local use is valuable.
- Treating browser-derived text as trusted because it came from an authenticated
  profile.
