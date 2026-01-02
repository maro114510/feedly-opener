# Contributing

Thanks for your interest in contributing.

## How to contribute

1. Open an issue to discuss the change.
2. Fork the repository and create a feature branch.
3. Make changes with clear, focused commits.
4. Open a Pull Request with:
   - What changed and why
   - How you tested it
   - Any relevant screenshots or HTML snippets (for DOM-related changes)

## Development

This is a browser extension with no build step.

### Local testing

- Chrome: `chrome://extensions` → Developer mode → Load unpacked
- Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on

Reload the extension after changes.

## Coding guidelines

- Prefer small, focused functions.
- Avoid external dependencies.
- Keep DOM selectors and heuristics conservative to avoid toggling the wrong UI.

## Reporting issues

For issues related to Feedly UI changes, include:

- URL you are on (redact user id if needed)
- HTML snippet of the affected element
- Steps to reproduce

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
