# mcp-broker

Multi-agent communication broker exposed as an [MCP](https://modelcontextprotocol.io/) server. Allows multiple AI agents (e.g. Claude instances) to discover each other, exchange messages, and coordinate via shared channels — all persisted in SQLite.

## Why mcp-broker?

Claude Code มี Agent tool, subagents, และ teams อยู่แล้ว — แล้วทำไมต้องมี broker อีก?

### The Problem

Built-in multi-agent ของ Claude Code มีข้อจำกัด:

- **Agent/Subagent** — parent spawn child, child ทำงานเสร็จแล้ว return ผลกลับ จบ ไม่มี ongoing communication ระหว่าง agents
- **Teams (SendMessage)** — agents คุยกันได้ แต่เป็น synchronous, ไม่มี message history, ไม่มี channels, ไม่มี presence tracking
- **ทุก session เป็น island** — agent A ไม่รู้ว่า agent B มีอยู่ ถ้าไม่ได้ถูก spawn จาก parent เดียวกัน

### What mcp-broker Adds

| Capability | Agent/Subagent | Teams | mcp-broker |
|------------|:-:|:-:|:-:|
| Agent discovery (ใครออนไลน์อยู่?) | - | - | ✓ |
| Async messaging (ส่งข้อความไว้ อีกฝั่งมาอ่านทีหลัง) | - | - | ✓ |
| Channels (group communication) | - | - | ✓ |
| Message history & persistence | - | - | ✓ |
| Role-based targeting (ส่งถึง workers ทั้งหมด) | - | - | ✓ |
| Broadcast (ประกาศทุกคน) | - | ✓ | ✓ |
| Cross-session communication | - | - | ✓ |
| Presence & heartbeat | - | - | ✓ |

### Use Cases

- **Parallel code review** — coordinator แจก PR ให้ workers หลายตัว review พร้อมกัน รวมผลกลับ
- **Long-running pipelines** — agent ส่งงานเข้า queue ปิด session ไป agent ตัวใหม่มารับงานต่อได้
- **Cross-project coordination** — agents จากหลาย project directories คุยกันผ่าน broker
- **Supervisor pattern** — supervisor คอย monitor workers, re-assign งานที่ fail, track progress

ถ้าแค่ต้องการ spawn task แล้วรอผล → ใช้ Agent/Subagent ของ Claude Code เลย
ถ้าต้องการ agents หลายตัวคุยกัน, discover กัน, ส่งงานแบบ async, หรือ persist messages → ใช้ mcp-broker

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

## Install as Claude Code Plugin

```bash
# Add the marketplace
/plugin marketplace add krittinkhaneung/mcp-broker

# Install the plugin
/plugin install broker
```

This gives you the MCP server (12 tools), slash commands, a coordinator agent, and session hooks — all configured automatically.

### Manual Setup (alternative)

```bash
# Clone and install
git clone https://github.com/krittinkhaneung/mcp-broker.git
bun install

# Add to Claude Code
claude mcp add --transport stdio broker -- bun /path/to/mcp-broker/src/index.ts

# Run tests
bun test
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

## Plugin Features

### Skills (Slash Commands)

| Command | Description |
|---------|-------------|
| `/broker:status` | Dashboard — online agents, channels, message stats |
| `/broker:reset` | Clean up old messages, prune stale agents, or full reset |
| `/broker:setup` | First-time health check and onboarding guide |

### Coordinator Agent

Use `broker-coordinator` for multi-agent orchestration:
- Fan-out tasks across N worker agents
- Task queue with automatic retry on failure
- Progress tracking and result aggregation

### Session Hooks

- **SessionStart** — auto-registers your Claude session with the broker
- **SessionEnd** — auto-unregisters on disconnect

## Project Structure

```
.claude-plugin/
  plugin.json       Plugin manifest
  marketplace.json  GitHub marketplace listing
.mcp.json           MCP server config (auto-configured by plugin)
skills/
  status/SKILL.md   /broker:status
  reset/SKILL.md    /broker:reset
  setup/SKILL.md    /broker:setup
agents/
  broker-coordinator.md   Multi-agent orchestration agent
hooks/
  hooks.json        Session start/end auto-registration
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
