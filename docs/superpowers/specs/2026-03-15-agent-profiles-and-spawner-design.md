# Agent Profiles & Spawner Design

## Summary

Extend mcp-broker from a passive message bus to an active agent orchestrator by adding:
1. **Agent Profiles** — YAML-based full agent definitions (name, system prompt, model, tools, etc.)
2. **Process Spawner** — broker spawns Claude Code CLI instances from profiles
3. **Lifecycle Manager** — process tracking, graceful stop, crash detection & notification

## Motivation

Currently, the broker is a message bus only. The coordinator must use Claude Code's built-in Agent tool to spawn workers, manually constructing prompts each time. With agent profiles:
- Pre-defined agent personas are reusable across projects
- Coordinator just calls `spawn_agent("reviewer")` — no prompt construction needed
- Broker manages the full lifecycle (spawn, monitor, stop, crash recovery)
- Singleton enforcement prevents duplicate agents

## Profile Config

### Location

```
~/.claude/mcp-broker/profiles.yml    # default
BROKER_PROFILES_PATH env var         # override
```

Loaded on every `spawn_agent` / `list_profiles` call (no caching — edits take effect immediately).

### Schema

```yaml
profiles:
  <name>:
    name: string            # 1-32 chars, [a-zA-Z0-9_-], required
    system_prompt: string   # 1-10000 chars, required
    model: enum             # "opus" | "sonnet" | "haiku", required
    max_turns: number       # 1-200, default 30
    auto_register: boolean  # default true
    allowed_tools: string[] # optional — omit = all tools allowed
    claude_md: string       # optional — injected as additional CLAUDE.md
    role: enum              # optional, default "worker" — "peer" | "worker" | "supervisor"
```

### Example

```yaml
profiles:
  reviewer:
    name: reviewer
    system_prompt: |
      You are an expert code reviewer.
      Check for code quality, security, and performance issues.
    model: sonnet
    max_turns: 30
    auto_register: true
    allowed_tools:
      - Read
      - Grep
      - Glob
      - Bash
    claude_md: |
      ## Review Guidelines
      - Check OWASP Top 10
      - Report only, do not modify code
    role: worker

  tester:
    name: tester
    system_prompt: |
      You are a test engineer.
      Write comprehensive tests covering edge cases.
    model: haiku
    max_turns: 50
    auto_register: true
    allowed_tools:
      - Read
      - Write
      - Edit
      - Bash
    claude_md: |
      ## Testing Standards
      - 80%+ coverage target
      - Use pytest + factory_boy
    role: worker
```

### Validation (Zod)

- `name` — regex `^[a-zA-Z0-9_-]{1,32}$` (same as agent name)
- `system_prompt` — required, 1-10000 chars
- `model` — enum `opus | sonnet | haiku`
- `max_turns` — integer 1-200, default 30
- `auto_register` — boolean, default true
- `allowed_tools` — optional string array (validated at spawn time, not load time)
- `claude_md` — optional string
- `role` — optional enum `peer | worker | supervisor`, default `worker`
- Duplicate profile names are rejected at load time

## New MCP Tools

### `spawn_agent`

**Input:**
```typescript
{
  profile: string  // profile name from profiles.yml
  task?: string    // optional initial task/message to send after spawn
}
```

**Flow:**
1. Load & validate `profiles.yml`
2. Find profile by name
3. Singleton guard — check if agent with this name is already online → error if so
4. Spawn `claude` CLI as subprocess with profile config
5. Store process in `spawnedProcesses` map
6. Wait for agent to auto-register (if `auto_register: true`)
7. If `task` provided, send DM to the newly spawned agent
8. Return `{ name, pid, status: "online" }`

**Spawn command:**
```bash
claude --model <model> \
       --system-prompt "<system_prompt>" \
       --allowedTools "<tools>" \
       --max-turns <max_turns> \
       --append-system-prompt "<claude_md>"
```

**Errors:**
| Case | Code | Message |
|------|------|---------|
| Profile not found | `profile_not_found` | `"reviewer" not in profiles.yml` |
| Already running | `agent_already_running` | `"reviewer" is online (pid: 12345)` |
| Invalid YAML | `invalid_config` | `profiles.yml parse error at line 15` |
| Invalid profile | `invalid_profile` | `"reviewer" model must be opus/sonnet/haiku` |
| Profiles file missing | `config_not_found` | `profiles.yml not found at <path>` |

### `stop_agent`

**Input:**
```typescript
{
  name: string  // agent name to stop
}
```

**Flow:**
1. Check agent exists and is online
2. Send DM: `[SYSTEM] please finish and unregister`
3. Wait 10s for graceful exit
4. If still running → SIGTERM → wait 5s → SIGKILL
5. Cleanup: unregister from DB, remove from `spawnedProcesses` map
6. Return `{ name, stopped: true }`

**Errors:**
| Case | Code | Message |
|------|------|---------|
| Agent not found | `agent_not_found` | `"reviewer" is not registered` |
| Not spawned by broker | `not_managed` | `"reviewer" was not spawned by broker` |

### `list_profiles`

**Input:** none

**Output:**
```typescript
{
  profiles: Array<{
    name: string
    model: string
    role: string
    max_turns: number
    is_running: boolean  // cross-reference with online agents
  }>
}
```

## Process Management

### In-Memory Tracking

```typescript
// state.ts
spawnedProcesses: Map<string, {
  pid: number
  profile: string
  startedAt: Date
  process: ChildProcess
}>
```

### DB Schema Changes

Add columns to `agents` table:

```sql
ALTER TABLE agents ADD COLUMN pid INTEGER;
ALTER TABLE agents ADD COLUMN profile TEXT;
ALTER TABLE agents ADD COLUMN spawned_by TEXT;
```

### Lifecycle Scenarios

**Normal completion:**
1. Agent finishes work → calls `unregister`
2. Process exits with code 0
3. Broker detects exit → removes from `spawnedProcesses` map

**Coordinator stops agent:**
1. Coordinator calls `stop_agent("reviewer")`
2. Broker sends graceful shutdown DM
3. Wait 10s → SIGTERM → wait 5s → SIGKILL
4. Cleanup: unregister + remove from map

**Process crash:**
1. Broker detects exit code != 0 via `process.on('exit')`
2. Set agent status to offline in DB
3. DM the `spawned_by` agent: `"reviewer crashed (exit code 1)"`
4. Coordinator decides whether to respawn (no auto-respawn)

**Broker shutdown:**
1. On broker process exit signal → SIGTERM all spawned agents
2. Wait 5s → SIGKILL remaining
3. Prevents orphan processes

## Architecture

### New Files

```
src/
  profiles.ts        # YAML loading, Zod schema, validation
  spawner.ts         # spawn/stop claude CLI, process tracking, crash handling
  tools/
    spawn.ts         # spawn_agent, stop_agent, list_profiles MCP handlers
```

### Modified Files

```
src/types.ts         # Add Profile, SpawnedProcess interfaces
src/db.ts            # Add pid, profile, spawned_by columns to agents
src/index.ts         # Register 3 new tools, shutdown cleanup handler
src/validators.ts    # Add profile name validation
package.json         # Add yaml dependency
```

### New Dependency

```
yaml                 # YAML parser for profiles.yml
```

### Tool Count

Total: 15 tools (12 existing + 3 new)

| Category | Tools |
|----------|-------|
| Registration | register, heartbeat, unregister |
| Messaging | send_message, poll_messages |
| Channels | create_channel, join_channel, leave_channel, list_channels |
| Discovery | list_peers |
| History | get_history, purge_history |
| **Profiles (new)** | **spawn_agent, stop_agent, list_profiles** |

## Config Summary

### New Env Vars

| Variable | Default | Description |
|----------|---------|-------------|
| `BROKER_PROFILES_PATH` | `~/.claude/mcp-broker/profiles.yml` | Path to profiles config |

### Existing Env Vars (unchanged)

| Variable | Default |
|----------|---------|
| `BROKER_DB_PATH` | `~/.claude/mcp-broker/broker.db` |
| `BROKER_HEARTBEAT_TTL` | `60000` ms |
| `BROKER_MAX_MESSAGE_LENGTH` | `10000` |
| `BROKER_PRUNE_AFTER_DAYS` | `7` |
| `BROKER_MAX_AGENTS` | `100` |
| `BROKER_MAX_CHANNELS` | `50` |
