# Privacy Policy

This extension does not operate analytics, sell personal data, or send data to a server operated by the extension developer. It does process your Feedly data in the browser and communicates with Feedly when you use the extension, as described below.

## Data Access and Feedly communication

The extension runs on Feedly Read Later pages under `https://feedly.com/`. It uses the Feedly web session already present in that page:

- It reads the `feedlyToken` value from Feedly's `localStorage["feedly.session"]` entry when available.
- It keeps the access token only in the content script's memory, with a short-lived cache. The token is not written to the extension's browser storage.
- It sends authenticated requests to `https://api.feedly.com/` using the token. Depending on the selected mode, requests retrieve the current user profile, retrieve saved entries, and remove verified entries from the Read Later tag.
- If the API path is unavailable, the extension can use the Feedly page's DOM as a fallback.

The extension also opens the selected saved-item URLs in background tabs. Those navigations are normal browser requests to the destination websites and may be subject to those websites' own privacy policies. The extension does not collect or upload browsing history from those tabs.

## Data storage

The extension stores the following settings under `feedlyOpenerSettings`:

- Open mode (`all` or `count`)
- Count value
- Reload preference

Settings use the browser's sync storage when it is available and otherwise use local extension storage. The current unsave operation, including selected entry IDs and URLs, is held in memory only and is cleared after the operation. The extension does not persist an article snapshot, browsing history, or API response data in extension storage.

## Permissions

Each declared permission is used for the following purpose:

- `storage`: save the extension settings in sync or local browser storage.
- `scripting`: re-inject `content.js` into the active Feedly tab when a single-page-app navigation has left the content script unavailable.
- `webNavigation`: observe top-level navigation errors for newly opened article tabs, so an article is not removed from Read Later when its destination failed to load.

The extension also requests these host permissions:

- `https://feedly.com/*`: run the Read Later content script, perform the fallback injection on Feedly pages, and access the Feedly web session needed for the API-first operation.
- `https://api.feedly.com/*`: make the authenticated Feedly API requests described above.

The extension uses the browser Tabs API to query the active tab, create background tabs, send messages, and observe tab state. It does not request the `tabs` permission because it does not access sensitive tab properties such as URLs, titles, or favicons through that permission.

## Changes

If this policy changes, the updated version will be published in this repository.
