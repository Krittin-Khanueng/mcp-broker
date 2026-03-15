# Changelog

All notable changes to mcp-broker are documented here.

## [0.1.0] - 2026-03-15

### Added

- **Claude Code Plugin** — install via `/plugin marketplace add krittinkhaneung/mcp-broker` + `/plugin install broker`
- **Skills**: `/broker:status` (dashboard), `/broker:reset` (cleanup), `/broker:setup` (onboarding)
- **Coordinator agent** (`broker-coordinator`) — multi-agent orchestration with fan-out/fan-in, task queue, retry, and progress tracking
- **Session hooks** — auto-register on session start, auto-unregister on session end
- **GitHub marketplace** config (`.claude-plugin/marketplace.json`)

### Core (pre-plugin)

- MCP server with 12 tools: register, heartbeat, unregister, send_message, poll_messages, create_channel, join_channel, leave_channel, list_channels, list_peers, get_history, purge_history
- SQLite persistence (WAL mode, foreign keys)
- Cursor-based polling with UNION ALL unified inbox (no N+1)
- BrokerError typed error handling across all handlers
- Environment-based configuration with safe defaults
- Migrated from Node.js + better-sqlite3 to Bun + bun:sqlite
