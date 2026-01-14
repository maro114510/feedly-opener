# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project adheres to
Semantic Versioning.

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
