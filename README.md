# Feedly Read Later Opener

Browser extension to open saved items from Feedly Read Later in background tabs and remove them from Read Later. Works on both Chrome and Firefox.

## Features

- Runs only on the Feedly Read Later page
- Open all saved items or open a specified number
- Auto-reload after opening to reflect changes
- Settings stored in browser storage
- API-first approach with DOM fallback
- No external libraries

## Requirements

- Chrome (Manifest V3)
- Firefox (Manifest V3)

## Install (local)

### Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click "Load unpacked" and select this repository folder

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on" and select `manifest.json` in this repository

## Usage

1. Open the Feedly Read Later page
2. Click the extension icon
3. Choose "Open all saved items" or "Open only this many"
4. Click "Open and unsave"
5. Tabs open in background, page reloads automatically

## Notes

- Feedly is a SPA, so content scripts may not be injected immediately after navigation. The extension attempts a fallback injection.
- Read Later toggling depends on Feedly DOM structure and may break if the UI changes.
- If the same article keeps opening, the saved-state detection may not match the current DOM.

## Development

Key files:

- `manifest.json`
- `popup.html`, `popup.css`, `popup.js`
- `content.js`

Reload the extension in Chrome/Firefox after changes.

## Contributing

1. Open an issue to propose a change
2. Fork and create a feature branch
3. Submit a Pull Request with changes and verification steps

For DOM-related fixes, include relevant HTML snippets or reproduction steps.

## License

MIT License. See `LICENSE`.
