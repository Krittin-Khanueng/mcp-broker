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

## Prerequisites

- [**Bun**](https://bun.sh/) v1.0+ — runtime (ใช้รัน TypeScript ตรง ไม่ต้อง build)
- [**Claude Code**](https://claude.com/code) — CLI agent ของ Anthropic (ต้องรองรับ plugin system)

```bash
# ติดตั้ง Bun (macOS / Linux)
curl -fsSL https://bun.sh/install | bash

# ตรวจสอบ version
bun --version
```

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

## Usage Guide

### Basic: Register and Chat

เปิด 2 Claude Code sessions ในเครื่องเดียวกัน:

**Session A:**
```
> "Register as 'alice' and send a message to bob saying 'ready to start'"

# Claude calls: register(name: "alice", role: "peer")
# Claude calls: send_message(to: "bob", content: "ready to start")
```

**Session B:**
```
> "Register as 'bob' and check for messages"

# Claude calls: register(name: "bob", role: "peer")
# Claude calls: poll_messages()
# → receives: {from: "alice", content: "ready to start"}
```

### Channels: Group Communication

```
> "Create a channel #code-review for the team"
# Claude calls: create_channel(name: "#code-review", purpose: "PR reviews")

> "Send to #code-review: PR #42 needs review"
# Claude calls: send_message(to: "channel:#code-review", content: "PR #42 needs review")
```

ทุก agent ที่ join channel จะเห็นข้อความเมื่อ poll.

### Broadcast: Announce to Everyone

```
> "Broadcast to all agents: deployment starting in 5 minutes"
# Claude calls: send_message(to: "all", content: "deployment starting in 5 minutes")
```

ทุก agent ที่ online จะได้รับข้อความ.

### Role-Targeted Messaging

```
> "Send to all workers: new tasks available in #task-queue"
# Claude calls: send_message(to: "role:worker", content: "new tasks available in #task-queue")
```

เฉพาะ agents ที่ register ด้วย role `worker` เท่านั้นที่จะได้รับ.

### Coordinator: Parallel Task Execution

ใช้ `broker-coordinator` agent สำหรับงานที่ต้อง fan-out:

```
> "Use broker-coordinator to review these 3 files in parallel:
   src/auth.ts, src/api.ts, src/db.ts"
```

Coordinator จะ:
1. Register ตัวเองเป็น supervisor
2. Spawn 3 worker agents
3. แจก 1 file ให้แต่ละ worker review
4. รวมผล review กลับมาเป็น summary

### Discovery: Who's Online?

```
> "List all online agents"
# Claude calls: list_peers()
# → [{name: "alice", role: "peer", status: "idle", online: true}, ...]

> "List only workers"
# Claude calls: list_peers(role: "worker")
```

`list_peers` ไม่ต้อง register ก่อนก็ใช้ได้ — เหมาะสำหรับ monitoring.

---

## Use Cases

### 1. Parallel Code Review

**สถานการณ์:** มี PR ใหญ่ ต้อง review หลายไฟล์

```
> "Use broker-coordinator to review PR #123. Split by directory:
   - src/api/ (REST endpoints)
   - src/services/ (business logic)
   - src/models/ (data layer)"
```

Coordinator spawn 3 workers, แต่ละตัว focus คนละ layer, รวมผลกลับเป็น unified review.

### 2. Long-Running Pipeline

**สถานการณ์:** งานที่ใช้เวลานาน ต้องส่งต่อระหว่าง sessions

**Session 1 (Producer):**
```
> "Register as 'pipeline' and post these tasks to #jobs:
   1. Migrate database schema
   2. Update API endpoints
   3. Write integration tests"
```

**Session 2 (Consumer — อาจเปิดทีหลัง):**
```
> "Register as 'worker-1', join #jobs, and pick up the next task"
# Worker polls #jobs, เห็น task, เริ่มทำงาน
# ทำเสร็จแล้ว post ผลกลับไป #jobs
```

Messages persist ใน SQLite — ไม่หายแม้ session เดิมปิดไปแล้ว.

### 3. Cross-Project Coordination

**สถานการณ์:** ทำงาน 2 projects ที่เกี่ยวข้องกัน (เช่น frontend + backend)

**Terminal 1 (`~/frontend`):**
```
> "Register as 'frontend-dev'. When the API contract changes,
   send me a message with the new endpoints."
```

**Terminal 2 (`~/backend`):**
```
> "Register as 'backend-dev'. I just added POST /api/tasks.
   Send to frontend-dev: 'new endpoint POST /api/tasks added,
   request body: {title: string, priority: number}'"
```

ทั้ง 2 projects ใช้ broker.db เดียวกัน — คุยกันข้ามโปรเจกต์ได้.

### 4. Supervisor + Workers Pattern

**สถานการณ์:** ต้องการ 1 agent คอย monitor และ manage workers หลายตัว

```
> "Register as 'supervisor' with role supervisor.
   Create channel #status.
   Poll #status every time you get a chance —
   if any worker reports 'failed', re-assign their task."
```

Workers report สถานะเข้า `#status`:
```
> "Register as 'worker-1' with role worker.
   Join #status. Post status updates as you work.
   When done, send to supervisor: 'task-A complete'."
```

### 5. Multi-Agent Brainstorm

**สถานการณ์:** ต้องการหลาย perspectives สำหรับ design decision

```
> "Use broker-coordinator to brainstorm database design.
   Spawn 3 agents with different perspectives:
   - Agent 1: optimize for read performance
   - Agent 2: optimize for write throughput
   - Agent 3: optimize for simplicity and maintainability
   Collect all proposals and synthesize the best approach."
```

### 6. Test Matrix Runner

**สถานการณ์:** run tests หลาย environments พร้อมกัน

```
> "Use broker-coordinator to run the test suite across configurations:
   - Node 20 + PostgreSQL 15
   - Node 22 + PostgreSQL 16
   - Bun + SQLite
   Report which combinations pass/fail."
```

---

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

## Development

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- Git

### Setup

```bash
git clone https://github.com/krittinkhaneung/mcp-broker.git
cd mcp-broker
bun install
```

### Commands

```bash
bun test              # run all tests (in-memory SQLite)
bun test --watch      # run tests in watch mode
bun run build         # compile TypeScript to dist/
bun run dev           # compile with --watch
bun src/index.ts      # start MCP server directly (stdio)
```

### Running Tests

Tests ใช้ in-memory SQLite — ไม่ต้องตั้งค่า database:

```bash
$ bun test
bun test v1.x.x

 ✓ tests/db.test.ts
 ✓ tests/register.test.ts
 ✓ tests/messaging.test.ts
 ✓ tests/channels.test.ts
 ✓ tests/peers.test.ts
 ✓ tests/history.test.ts
 ✓ tests/wrapHandler.test.ts
```

### Adding a New Tool

1. สร้าง handler ใน `src/tools/` (ดูตัวอย่างจาก `peers.ts`)
2. เพิ่ม test ใน `tests/`
3. Wire tool เข้า `src/index.ts` ด้วย `server.registerTool()`
4. อัพเดต README tools table

### Project Architecture

```
MCP Client (Claude) ──stdio──▶ index.ts (MCP Server)
                                  │
                                  ├─ tools/register.ts   ──▶ state.ts (session singleton)
                                  ├─ tools/messaging.ts  ──▶ presence.ts (heartbeat)
                                  ├─ tools/channels.ts   ──▶ validators.ts (input checks)
                                  ├─ tools/peers.ts      ──▶ errors.ts (BrokerError)
                                  └─ tools/history.ts    ──▶ db.ts (SQLite)
                                                              │
                                                              ▼
                                                          broker.db
```

### Tech Stack

| Component | Technology |
|-----------|------------|
| Runtime | [Bun](https://bun.sh/) — runs TypeScript directly, no build step |
| Database | `bun:sqlite` — built-in SQLite with WAL mode |
| MCP Framework | `@modelcontextprotocol/sdk` — stdio transport |
| Validation | [Zod](https://zod.dev/) — input schema validation |
| Testing | `bun:test` — built-in test runner with in-memory SQLite |

### Dependencies

**Runtime:**
- `@modelcontextprotocol/sdk` — MCP server framework
- `uuid` — unique ID generation
- `zod` — schema validation

**Dev:**
- `typescript` — type checking and compilation
- `bun-types` — Bun API type definitions
- `@types/uuid` — UUID type definitions

## License

MIT
