# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this extension does

A browser extension that opens Feedly "Read Later" saved items in background tabs and removes them from Read Later simultaneously. Supports both Chrome and Firefox (Manifest V3).

## Development workflow

No build step. Files are loaded directly by the browser.

**Chrome:**
1. Open `chrome://extensions` → Enable Developer mode → Load unpacked → select this repo folder
2. After any change, click the reload icon next to the extension on `chrome://extensions`

**Firefox:**
1. Open `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → select `manifest.json`
2. After any change, click Reload on the debugging page

There are no automated tests. Verification is manual: open the Feedly Read Later page, trigger the popup, and confirm tabs open and items disappear.

**CI** (`ci.yaml`) only validates that `manifest.json` is valid JSON with `manifest_version: 3` and that required files exist. There is no linter configured.

## Release process

Releases are tag-triggered. Pushing a `v*` tag runs `release.yml`, which auto-generates GitHub Release notes from commits. Update `manifest.json` version and `CHANGELOG.md` before tagging.

## Architecture

The extension has two independent scripts:

**`popup.js` (UI controller)**
Runs in the popup window. Reads settings from `browser.storage.sync` (falls back to `storage.local`). When the user clicks "Open and unsave", it:
1. Queries the active tab
2. Sends a `FEEDLY_OPEN` message to the content script in that tab
3. If the content script isn't loaded (SPA navigation hasn't triggered injection), injects `content.js` via `scripting.executeScript` and retries
4. Receives the list of URLs from the content script and opens each as a background tab

**`content.js` (execution engine)**
Injected into `feedly.com` Read Later pages. Handles the actual fetch-and-unsave logic. Listens for `FEEDLY_OPEN` messages, validates the sender ID and sanitizes settings, then runs `handleOpen()`.

### API-first with DOM fallback

`handleOpen()` always tries the Feedly API first (`handleOpenViaAPI`). If the API call fails for any reason, it falls back to DOM manipulation (`handleOpenViaDOM`).

**Why**: The API is reliable and fast, especially for "all" mode which pages through results. The DOM fallback exists because the token source (`localStorage["feedly.session"].feedlyToken`) is an undocumented internal Feedly detail that may silently become unavailable.

**Token extraction**: The access token is read from `localStorage["feedly.session"]` — a key that Feedly's own web app writes. This is intentionally undocumented and may break if Feedly changes its session storage format. The token is cached in memory with a 10-minute TTL and a hash of the localStorage value for change detection.

### Cross-browser compatibility

Both files start with:
```js
const api = typeof browser !== "undefined" ? browser : chrome;
```

Firefox exposes Promise-based APIs under `browser`; Chrome uses callbacks under `chrome`. `popup.js` wraps every Chrome callback API (`tabs.query`, `tabs.create`, `storage.get`, etc.) in a Promise to use a single async code path for both browsers.

### SPA navigation problem

Feedly is a React SPA. The browser only fires content script injection on full page loads, not on SPA route changes. As a result, the content script may already be loaded from a previous navigation. The extension handles this via:

- A 3-second "recently seen" cache (`READ_LATER_CACHE_MS`): if the script has confirmed the Read Later page within the last 3 seconds, it trusts that state.
- A fallback re-injection via `scripting.executeScript` when the popup can't reach the content script.
- A `window.__feedlyReadLaterOpenerListenerAdded` guard to prevent duplicate `runtime.onMessage` listeners when the script is injected multiple times.

### DOM selector fragility

The DOM fallback detects saved items by heuristics tied to Feedly's current UI:

- SVG `path[d]` values: `BOOKMARK_ICON_SELECTED_PATH = "M13.077 2.5H6.923"` and `BOOKMARK_ICON_UNSELECTED_PATH = "M13 2.357H7"` — these are extracted from observed Feedly UI and will break if Feedly updates their icon set.
- CSS class name fragments: `color--accent`, `color--secondary`, `EntryMetadataReadLater`, `EntryToolbar__button`
- Multi-label support for Read Later text (`READ_LATER_LABELS`) includes Japanese labels (`後で読む`, `あとで読む`) because Feedly localizes button text.

When Feedly pushes a UI update, it is the DOM selectors and SVG paths that break first. Fix by inspecting the Feedly page in DevTools and updating the relevant constants in `content.js`.

`clickElement()` dispatches a full mouse event sequence (`mouseover → pointerdown → mousedown → pointerup → mouseup → click`) rather than just calling `.click()` because Feedly's React event system requires the full event bubbling chain to register the interaction.

## Message protocol

Two-phase design prevents data loss:

1. `FEEDLY_OPEN` — content script fetches entries, stores `pendingUnsave` in memory, returns `{ok, urls}` **without unsaving**
2. Popup opens background tabs
3. `FEEDLY_UNSAVE` — content script reads `pendingUnsave`, performs the actual unsave, triggers page reload

If tab opening fails, articles remain in Read Later (no data loss). If unsave fails after tabs open, the tabs are already open and the popup shows a retry message.

### Undocumented token source

`localStorage["feedly.session"].feedlyToken` has no public API contract. If Feedly changes their session storage format, the API path silently stops working and the extension falls back to DOM mode.

## Constraints

- No external libraries (minimizes attack surface and keeps the extension small)
- DOM selectors must be conservative: prefer specificity over coverage to avoid accidentally toggling the wrong button
- Batch size for parallel DELETE requests (`BATCH_SIZE = 5`) is chosen to balance throughput against Feedly API rate limits — do not increase without testing
- `count` input is clamped to 1–999 in both popup (UI) and content script (`validateSettings`) — keep both in sync if the range changes
