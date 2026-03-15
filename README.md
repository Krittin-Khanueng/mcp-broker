# mcp-broker

Multi-agent communication broker exposed as an [MCP](https://modelcontextprotocol.io/) server. Allows multiple AI agents (e.g. Claude instances) to discover each other, exchange messages, and coordinate via shared channels — all persisted in SQLite.

## How It Works

```
Agent A ──stdio──▶ ┌─────────────┐ ◀──stdio── Agent B
                   │  mcp-broker │
Agent C ──stdio──▶ │  (SQLite)   │ ◀──stdio── Agent D
                   └─────────────┘
```

Each agent connects via stdio and uses MCP tools to:

1. **Register** itself with a name and role
2. **Discover** other online agents
3. **Send messages** — direct, broadcast, role-targeted, or channel-based
4. **Poll** for new messages (cursor-based, no duplicates)
5. **Manage channels** for topic-based communication

## Quick Start

```bash
# Install dependencies
bun install

# Run tests
bun test

# Start server
bun src/index.ts
```

### Add to Claude Code

Add to your MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "broker": {
      "command": "bun",
      "args": ["/path/to/mcp-broker/src/index.ts"]
    }
  }
}
```

## Tools

### Registration & Presence

| Tool | Description |
|------|-------------|
| `register` | Register an agent with `name`, optional `role` (supervisor/worker/peer), and `metadata` |
| `heartbeat` | Update presence; optionally set status (idle/busy/blocked). Returns online peer count |
| `unregister` | Disconnect the current agent |

### Messaging

| Tool | Description |
|------|-------------|
| `send_message` | Send to an agent name (DM), `"all"` (broadcast), `"role:<role>"` (role-targeted), or `"channel:#name"` |
| `poll_messages` | Fetch unread messages across all sources, or filter by channel. Cursor-based — no duplicates |

### Channels

| Tool | Description |
|------|-------------|
| `create_channel` | Create a channel (name must start with `#`) with optional purpose |
| `join_channel` | Join a channel |
| `leave_channel` | Leave a channel |
| `list_channels` | List all channels with member counts |

### Discovery & History

| Tool | Description |
|------|-------------|
| `list_peers` | List all agents with online status. Optional role filter. Works without registration |
| `get_history` | Query message history with peer, channel, sequence, and limit filters |
| `purge_history` | Delete messages before a given ISO 8601 date |

## Configuration

All settings are configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BROKER_DB_PATH` | `~/.claude/mcp-broker/broker.db` | SQLite database path |
| `BROKER_HEARTBEAT_TTL` | `60000` | Milliseconds before an agent is considered offline |
| `BROKER_MAX_MESSAGE_LENGTH` | `10000` | Max message content length (chars) |
| `BROKER_PRUNE_AFTER_DAYS` | `7` | Auto-prune stale agents after this many days |
| `BROKER_MAX_AGENTS` | `100` | Maximum registered agents |
| `BROKER_MAX_CHANNELS` | `50` | Maximum channels |

## Project Structure

```
src/
  index.ts          MCP server entry point — registers all 12 tools
  config.ts         Environment-based configuration with defaults
  errors.ts         BrokerError typed error class
  db.ts             SQLite schema initialization (WAL mode, FK constraints)
  state.ts          In-process session state (current agent singleton)
  presence.ts       Heartbeat, online detection, stale agent pruning
  types.ts          Core interfaces (Agent, Channel, Message, SessionAgent)
  validators.ts     Input validation (name, channel, role, content)
  tools/
    register.ts     register, heartbeat, unregister
    messaging.ts    send_message, poll_messages
    channels.ts     create_channel, join_channel, leave_channel, list_channels
    peers.ts        list_peers
    history.ts      get_history, purge_history

tests/
  helpers.ts        In-memory SQLite test utilities
  *.test.ts         Full test coverage per module
```

## Tech Stack

- **Bun** — runtime (runs TypeScript directly, no build step)
- **bun:sqlite** — built-in SQLite with WAL mode
- **MCP SDK** (`@modelcontextprotocol/sdk`) — server framework with stdio transport
- **Zod** — input schema validation
- **bun:test** — test runner

## License

MIT
