# MCP Broker — Claude Code Plugin Design

**Date:** 2026-03-15
**Status:** Approved

## Overview

Convert mcp-broker from a manually-configured MCP server into a full Claude Code plugin distributed via GitHub marketplace. The plugin bundles: MCP server (12 tools), 3 skills, 1 coordinator agent, and session hooks.

## Plugin Structure

```
mcp-broker/
  .claude-plugin/
    plugin.json               # plugin manifest
    marketplace.json          # GitHub marketplace listing
  .mcp.json                   # MCP server config
  skills/
    status/SKILL.md           # /broker:status
    reset/SKILL.md            # /broker:reset
    setup/SKILL.md            # /broker:setup
  agents/
    broker-coordinator.md     # multi-agent orchestration
  hooks/
    hooks.json                # session start/end hooks
  src/                        # existing MCP server (unchanged)
  tests/                      # existing tests (unchanged)
```

## Components

### 1. Plugin Manifest (`.claude-plugin/plugin.json`)

```json
{
  "name": "broker",
  "version": "0.1.0",
  "description": "Multi-agent communication broker — message bus, presence, and coordination for Claude agents",
  "author": { "name": "krittinkhaneung" },
  "repository": "https://github.com/krittinkhaneung/mcp-broker",
  "license": "MIT",
  "keywords": ["multi-agent", "broker", "communication", "coordination", "mcp"]
}
```

### 2. MCP Server Config (`.mcp.json`)

```json
{
  "mcpServers": {
    "broker": {
      "command": "bun",
      "args": ["${CLAUDE_PLUGIN_ROOT}/src/index.ts"],
      "env": {
        "BROKER_DB_PATH": "${CLAUDE_PLUGIN_ROOT}/broker.db"
      }
    }
  }
}
```

Uses `${CLAUDE_PLUGIN_ROOT}` for portable paths. Bun runs TypeScript directly — no build step needed.

### 3. Marketplace Config (`.claude-plugin/marketplace.json`)

```json
{
  "name": "mcp-broker",
  "owner": { "name": "krittinkhaneung" },
  "plugins": [{
    "name": "broker",
    "source": ".",
    "description": "Multi-agent communication broker — message bus, presence, and coordination for Claude agents",
    "version": "0.1.0",
    "keywords": ["multi-agent", "broker", "communication", "coordination", "mcp"],
    "category": "multi-agent"
  }]
}
```

Users install via:
```bash
/plugin marketplace add krittinkhaneung/mcp-broker
/plugin install broker
```

### 4. Skills

#### `/broker:status`
Dashboard showing:
- Online agents table (name, role, status, last heartbeat)
- Active channels table (name, member count, purpose)
- Message stats (total, unread)

Implementation: prompt that calls `list_peers`, `list_channels`, `poll_messages` and formats results.

#### `/broker:reset`
Cleanup operations with user confirmation:
- Purge messages older than N days (`purge_history`)
- Prune stale agents (offline beyond TTL)
- Full reset (all data)

Implementation: prompt that presents options, confirms, then calls appropriate tools.

#### `/broker:setup`
First-time onboarding:
- Health check: verify broker MCP server is running
- Test: register/unregister cycle
- Quick start guide: register, send message, create channel
- Introduce broker-coordinator agent

Implementation: prompt that runs health checks and displays onboarding flow.

### 5. Broker Coordinator Agent

Subagent for multi-agent orchestration with:

- **Fan-out/Fan-in**: spawn N workers, assign tasks, collect results
- **Task queue**: post tasks to a channel, workers poll and claim
- **Retry**: re-assign tasks if worker doesn't respond within timeout
- **Progress tracking**: track per-task status, report summary to user

Flow:
1. Register as `supervisor` role
2. Create `#tasks-{timestamp}` channel (dynamic naming avoids collisions)
3. Spawn N worker agents via Agent tool
4. Post tasks to channel / DM workers
5. Poll results, retry failures
6. Aggregate and report results

### 6. Hooks

#### SessionStart
Type: `prompt` — injects instruction for Claude to auto-register with broker using a generated agent name (hostname + session ID).

#### SessionEnd
Type: `prompt` — injects instruction for Claude to call `unregister` before the session tears down. Prompt hooks at SessionEnd execute while Claude still has tool access, making this simpler than a command-type hook that would need direct DB access.

## Distribution

GitHub marketplace only:
1. User adds marketplace: `/plugin marketplace add krittinkhaneung/mcp-broker`
2. User installs: `/plugin install broker`
3. Plugin auto-configures MCP server, skills, agent, and hooks

## Dependencies

- **Bun runtime**: must be installed on user's machine
- **No npm publish required**: plugin installs directly from GitHub

## Migration

Existing users with manual config in `~/.claude/settings.json` can:
1. Remove the manual `broker` MCP server entry
2. Install the plugin instead
3. DB location changes from `~/.claude/mcp-broker/broker.db` to `${CLAUDE_PLUGIN_ROOT}/broker.db`
