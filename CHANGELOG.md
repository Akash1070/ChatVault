# Change Log

All notable changes to the "ChatVault" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-07-14
### Fixed
- **Critical:** DB init crash `no such module: fts5` — removed FTS5 virtual table dependency.
  The `sql.js` WASM binary (npm package) is compiled without FTS5; search now uses
  portable SQL `LIKE` queries instead. Fixes `chatVault.searchConversations not found`
  and `chatVault.newConversation not found` errors caused by early activation bail-out.
- Added migration v5 to clean up FTS5 table/triggers from any existing database files.

## [0.1.0] - Initial Release
- Initial release of ChatVault.
- Local-first SQLite database with WAL mode.
- Auto-capture for VS Code Chat Participants.
- Two-tier hybrid search engine (Fuse.js + SQLite FTS5).
- BYOB Supabase Cloud Sync implementation.
- Premium Licensing logic via Dodo Payments.
