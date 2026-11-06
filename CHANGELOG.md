# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to
Semantic Versioning.

## [0.4.0] - 2026-11-06

### Changed

- Remove the `tabs` permission and declare `webNavigation`; update the privacy policy accordingly
- Harden validation of external input
- Bump GitHub Actions `actions/checkout` and `softprops/action-gh-release`

### Fixed

- Validate the URL scheme in the API path so only `http:` and `https:` URLs are opened
- Unsave only items whose tabs were verified as loaded; failed or closed tabs stay in Read Later
- Register tab-load listeners before creating tabs so fast-loading tabs are not missed
- Verify tabs on main-frame `DOMContentLoaded` (or `complete`) and wait up to 30 seconds, so slow pages are no longer marked Failed

## [0.3.1] - 2026-02-22

### Changed

- Improve error handling with structured `FeedlyError` and user-facing messages
- Add token cache metadata with TTL and localStorage change detection
- Add message sender validation and settings sanitization in content script
- Respect `settings.reload` in successful operation flow
- Bump GitHub Action `actions/checkout` from `6.0.1` to `6.0.2`

### Fixed

- Handle JSON parse failures from Feedly API responses
- Classify 4xx API errors as client errors
- Prioritize actionable `WRONG_PAGE` message when API and DOM flows both fail

## [0.3.0] - 2026-01-14

### Changed

- Use Feedly API for fetching and unsaving entries (DOM as fallback)
- Always reload page after successful operation
- Save settings immediately on change (including real-time input)
- Remove reload checkbox option (now automatic)
- Use pagination for "all" mode to fetch entries beyond 100-item limit
- Parallel batch DELETE requests for improved performance

### Removed

- Optional reload setting (now always enabled)
- Unused `ct`/`cv` API parameters

### Fixed

- Token cache invalidation on authentication errors
- Consistent use of `normalizeCount()` for count validation
- Settings saved on input (not just on blur)

## [0.2.0] - 2026-01-06

### Changed

- Updated manifest version

## [0.1.0] - 2025-01-02

### Added

- Initial release of Feedly Read Later Opener
