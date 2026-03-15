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

## Transport Architecture

Each Claude Code session that connects to broker gets **its own broker MCP server process** via stdio (1:1). All broker processes share the same SQLite DB file. This means:

- Spawned agents do NOT need to connect back to the spawner's broker process
- Each spawned `claude` CLI process gets its own broker connection via `--mcp-config`
- Communication between agents happens through the shared DB (messages, channels, presence)
- No transport change needed — the existing stdio architecture works

```
Coordinator Session          Spawned Agent Session
  ┌──────────┐                 ┌──────────┐
  │ Claude   │                 │ Claude   │
  │ CLI      │                 │ CLI      │
  └────┬─────┘                 └────┬─────┘
       │ stdio                      │ stdio
  ┌────┴─────┐                 ┌────┴─────┐
  │ Broker   │                 │ Broker   │
  │ Process A│                 │ Process B│
  └────┬─────┘                 └────┬─────┘
       │                            │
       └──────── broker.db ─────────┘
                (shared SQLite)
```

### Cross-Process Implications

Since each broker runs in its own process:
- `spawnedProcesses` in-memory map only tracks agents spawned by THIS broker process
- `stop_agent` can only stop agents spawned by the same broker process (same coordinator session)
- `list_profiles` uses DB `profile` column + OS pid alive check for `is_running` (works cross-process)
- This is acceptable: the coordinator that spawns agents is the one that manages them

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
  <name>:                           # YAML key = profile identifier (used in spawn_agent)
    system_prompt: string           # 1-10000 chars, required
    model: enum                     # "opus" | "sonnet" | "haiku", required
    max_budget_usd: number          # optional, max dollar spend (works with -p mode)
    auto_register: boolean          # default true — spawner injects register instruction
    allowed_tools: string[]         # optional — omit = all tools. Controls built-in tools only.
    additional_instructions: string # optional — appended via --append-system-prompt
    role: enum                      # optional, default "worker" — "peer" | "worker" | "supervisor"
    working_directory: string       # optional — explicit cwd + --add-dir for spawned process
    permission_mode: enum           # optional — "default" | "auto" | "bypassPermissions", default: "auto"
```

**Note:** The YAML key IS the profile name and agent name. There is no separate `name` field inside the profile. This eliminates the key-vs-name ambiguity. The YAML key must match `^[a-zA-Z0-9_-]{1,32}$`.

### `auto_register` Behavior

When `auto_register: true` (default), the spawner **prepends** the following instruction to the system prompt before passing it to `--system-prompt`:

```
[BROKER REGISTRATION]
On startup, immediately call the broker's "register" tool with:
  name: "<profile_key>"
  role: "<profile_role>"
Before exiting, call the broker's "unregister" tool.
[END BROKER REGISTRATION]
```

When `auto_register: false`, no registration instruction is injected. The profile author is responsible for including registration logic in `system_prompt` if needed.

### `allowed_tools` and Broker MCP Tools

The `allowed_tools` field controls **built-in Claude Code tools only** (Read, Write, Edit, Bash, etc.) via the `--allowed-tools` CLI flag. MCP tools provided via `--mcp-config` are in a separate namespace and are always available regardless of `--allowed-tools`. Therefore, broker MCP tools (register, send_message, etc.) are always accessible to spawned agents.

### Example

```yaml
profiles:
  reviewer:
    system_prompt: |
      You are an expert code reviewer.
      Check for code quality, security, and performance issues.
    model: sonnet
    max_budget_usd: 1.00
    auto_register: true
    allowed_tools:
      - Read
      - Grep
      - Glob
      - Bash
    additional_instructions: |
      ## Review Guidelines
      - Check OWASP Top 10
      - Report only, do not modify code
    role: worker
    permission_mode: auto

  tester:
    system_prompt: |
      You are a test engineer.
      Write comprehensive tests covering edge cases.
    model: haiku
    max_budget_usd: 2.00
    auto_register: true
    allowed_tools:
      - Read
      - Write
      - Edit
      - Bash
    additional_instructions: |
      ## Testing Standards
      - 80%+ coverage target
      - Use pytest + factory_boy
    role: worker
    working_directory: /path/to/project
    permission_mode: auto
```

### Validation (Zod)

- YAML key (profile name) — regex `^[a-zA-Z0-9_-]{1,32}$` (same as agent name)
- `system_prompt` — required, 1-10000 chars
- `model` — enum `opus | sonnet | haiku`
- `max_budget_usd` — optional positive number
- `auto_register` — boolean, default true
- `allowed_tools` — optional string array (validated at spawn time, not load time)
- `additional_instructions` — optional string
- `role` — optional enum `peer | worker | supervisor`, default `worker`
- `working_directory` — optional string, must be valid directory if provided
- `permission_mode` — optional enum `default | auto | bypassPermissions`, default `auto`
- Duplicate YAML keys are inherently impossible in YAML (last one wins)

## MCP Config for Spawned Agents

The spawner generates a temporary MCP config file for each spawned agent:

### Config Generation

```typescript
// spawner.ts
function generateMcpConfig(agentName: string, brokerDbPath: string): string {
  const config = {
    mcpServers: {
      broker: {
        command: "bun",
        args: [path.resolve(__dirname, "index.ts")],
        env: {
          BROKER_DB_PATH: brokerDbPath
        }
      }
    }
  };
  const tmpPath = path.join(os.tmpdir(), `broker-mcp-${agentName}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(config));
  return tmpPath;
}
```

### Cleanup

- Temp MCP config files are deleted when the spawned process exits (in `process.on('exit')` handler)
- On broker shutdown, all temp files in `spawnedProcesses` map are cleaned up

## New MCP Tools

### `spawn_agent`

**Input:**
```typescript
{
  profile: string    // profile key from profiles.yml
  task?: string      // optional — the prompt/task for the agent (passed as CLI argument)
  cwd?: string       // optional — override working_directory from profile
}
```

**Flow:**
1. Load & validate `profiles.yml`
2. Find profile by key
3. Singleton guard — begin transaction:
   - `SELECT id, last_heartbeat FROM agents WHERE name = ?` (using profile key as name)
   - If exists AND `isOnline(last_heartbeat, config)` → error `agent_already_running`
   - If exists but offline → update row: set `profile = key`, `spawned_by = currentAgent.name`, `updated_at = Date.now()` (keep `last_heartbeat = NULL`)
   - If not exists → insert new row with `id = uuidv4()`, `name = key`, `role`, `status = 'idle'`, `last_heartbeat = NULL`, `updated_at = Date.now()`, `profile = key`, `spawned_by = currentAgent.name`
   - Commit transaction
4. Generate temp MCP config file pointing to same `broker.db`
5. Resolve working directory:
   - If `cwd` param provided → use it (also pass as `--add-dir`)
   - Else if profile has `working_directory` → use it (also pass as `--add-dir`)
   - Else → use broker's `process.cwd()` as subprocess cwd, do NOT pass `--add-dir`
6. Build spawn command with all CLI flags
7. Spawn `claude` CLI as subprocess with `cwd` option set
8. Update agent row with `pid`: `UPDATE agents SET pid = ? WHERE name = ?`
9. Store process in `spawnedProcesses` map (in-memory, this broker process only)
10. Listen for `process.on('exit')` for lifecycle management
11. Return `{ name, pid, status: "spawned" }`

**Pre-insert and register interaction:**

The pre-inserted row has `last_heartbeat = NULL`, which means:
- `isOnline(NULL, config)` returns `false` (see `presence.ts:13-14`)
- When spawned agent calls `register`, `handleRegister` finds the existing row, sees it's offline → takes the **reconnect path** (register.ts:48-59): updates `last_heartbeat`, `status`, `role`
- The row is safe from pruning because `pruneStaleAgents` only deletes rows where `last_heartbeat IS NULL AND updated_at < 7 days` — our pre-insert sets `updated_at = Date.now()`
- No changes to `handleRegister` code are needed

**Spawn command:**
```bash
claude -p \
       --model <model> \
       --system-prompt "<auto_register_prefix + system_prompt>" \
       --allowed-tools "<tools joined by space>" \
       --append-system-prompt "<additional_instructions>" \
       --max-budget-usd <max_budget_usd> \
       --output-format stream-json \
       --permission-mode <permission_mode> \
       --mcp-config <temp_mcp_config_path> \
       [--add-dir <working_directory>] \
       "<task>"
```

Notes:
- `-p` (print mode) — runs non-interactively, exits when done
- `--output-format stream-json` — enables broker to monitor progress
- `--mcp-config` — points to generated temp config with same `BROKER_DB_PATH`
- `--allowed-tools` — space-separated list of built-in tools only (MCP tools always available)
- `--add-dir` — only included when `cwd` param or profile `working_directory` is explicitly set
- `cwd` of subprocess is set via `child_process.spawn()` options
- `task` is passed as the positional prompt argument
- Optional flags (`--max-budget-usd`, `--allowed-tools`, `--add-dir`, `--append-system-prompt`) are omitted from the command when not configured in the profile

**Errors:**
| Case | Code | Message |
|------|------|---------|
| Profile not found | `profile_not_found` | `"reviewer" not in profiles.yml` |
| Already running | `agent_already_running` | `"reviewer" is online (pid: 12345)` |
| Invalid YAML | `invalid_config` | `profiles.yml parse error at line 15` |
| Invalid profile | `invalid_profile` | `"reviewer" model must be opus/sonnet/haiku` |
| Profiles file missing | `config_not_found` | `profiles.yml not found at <path>` |
| Invalid working directory | `invalid_directory` | `working_directory "/bad/path" does not exist` |
| Not registered | `not_registered` | `Must register before spawning agents` |

### `stop_agent`

**Input:**
```typescript
{
  name: string  // agent name to stop
}
```

**Flow:**
1. Check agent exists in `spawnedProcesses` map (in-memory, this broker process only)
2. SIGTERM the process → wait 10s for graceful exit
3. If still running → SIGKILL
4. Cleanup: set agent `last_heartbeat = NULL` in DB, remove from map, delete temp MCP config
5. Return `{ name, stopped: true }`

Notes:
- Can only stop agents spawned by the same broker process (same coordinator session)
- SIGTERM is the primary graceful shutdown mechanism (Claude CLI handles it)
- SIGKILL is the fallback after timeout

**Errors:**
| Case | Code | Message |
|------|------|---------|
| Agent not found | `agent_not_found` | `"reviewer" is not registered` |
| Not spawned by this broker | `not_managed` | `"reviewer" was not spawned by this session` |

### `list_profiles`

**Input:** none

**Output:**
```typescript
{
  profiles: Array<{
    name: string
    model: string
    role: string
    max_budget_usd: number | null
    is_running: boolean
  }>
}
```

`is_running` determination:
1. Query `SELECT pid, last_heartbeat FROM agents WHERE profile = ? ORDER BY updated_at DESC LIMIT 1`
2. If row found with `pid` AND `isOnline(last_heartbeat, config)` → check `process.kill(pid, 0)` (signal 0 = alive check)
3. If process is alive → `true`, otherwise → `false` (and set `last_heartbeat = NULL` to clean up)
4. If no row found or no pid → `false`

## Process Management

### In-Memory Tracking (per broker process)

```typescript
// state.ts
spawnedProcesses: Map<string, {
  pid: number
  profile: string
  startedAt: Date
  process: ChildProcess
  mcpConfigPath: string  // temp file path for cleanup
}>
```

### DB Schema Changes

Add columns to existing `agents` table via ALTER. The existing schema is NOT modified:

```sql
-- Migration (applied on startup if columns don't exist)
ALTER TABLE agents ADD COLUMN pid INTEGER;
ALTER TABLE agents ADD COLUMN profile TEXT;
ALTER TABLE agents ADD COLUMN spawned_by TEXT;
```

Existing schema (unchanged, for reference):
```sql
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,                                                    -- UUID
  name TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'peer' CHECK (role IN ('supervisor', 'worker', 'peer')),
  status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'busy', 'blocked')),
  metadata TEXT,
  last_heartbeat INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Notes:
- Primary key is `id TEXT` (UUID) — matches existing FK references in messages, channel_members, read_cursors
- Status CHECK constraint is NOT modified — no new status values needed
- Pre-inserted rows use `status = 'idle'` and `last_heartbeat = NULL`

### Migration Logic

```typescript
// db.ts — after db.exec(SCHEMA)
const cols = db.prepare(
  "SELECT name FROM pragma_table_info('agents')"
).all().map((r: any) => r.name);

if (!cols.includes('profile')) {
  db.exec("ALTER TABLE agents ADD COLUMN pid INTEGER");
  db.exec("ALTER TABLE agents ADD COLUMN profile TEXT");
  db.exec("ALTER TABLE agents ADD COLUMN spawned_by TEXT");
}
```

### Lifecycle Scenarios

**Normal completion:**
1. Agent finishes work in `-p` mode → calls `unregister` (sets `last_heartbeat = NULL`) → process exits with code 0
2. Broker detects exit via `process.on('exit')` → removes from `spawnedProcesses` map
3. Deletes temp MCP config file
4. If agent didn't unregister, broker sets `last_heartbeat = NULL` in DB

**Coordinator stops agent:**
1. Coordinator calls `stop_agent("reviewer")`
2. Broker sends SIGTERM to process
3. Wait 10s → if still running → SIGKILL
4. Cleanup: set `last_heartbeat = NULL` in DB + remove from map + delete temp MCP config

**Process crash:**
1. Broker detects exit code != 0 via `process.on('exit')`
2. Set agent `last_heartbeat = NULL` in DB (marks offline)
3. Look up `spawned_by` → resolve both agent IDs via DB:
   ```typescript
   const crashedAgent = db.prepare("SELECT id FROM agents WHERE name = ?").get(agentName);
   const spawnerAgent = db.prepare("SELECT id FROM agents WHERE name = ?").get(spawned_by);
   if (spawnerAgent && crashedAgent) {
     db.prepare(`
       INSERT INTO messages (seq, id, from_agent, to_agent, message_type, content, created_at)
       VALUES (NULL, ?, ?, ?, 'dm', ?, ?)
     `).run(uuidv4(), crashedAgent.id, spawnerAgent.id,
            `Agent "${agentName}" crashed (exit code ${code})`, Date.now());
   }
   ```
4. Coordinator picks up the notification on next `poll_messages`
5. No auto-respawn — coordinator decides

**Hang detection:**
- `--max-budget-usd` provides a hard spending cap — Claude CLI exits when exceeded
- `stream-json` output allows broker to detect if agent has stopped producing output
- Future enhancement: configurable process-level timeout per profile

**Broker shutdown:**
1. On broker process exit signal → SIGTERM all spawned agents in `spawnedProcesses` map
2. Wait 5s → SIGKILL remaining
3. Delete all temp MCP config files
4. Prevents orphan processes

## Architecture

### New Files

```
src/
  profiles.ts        # YAML loading, Zod schema, validation
  spawner.ts         # spawn/stop claude CLI, process tracking, crash handling, MCP config generation
  tools/
    spawn.ts         # spawn_agent, stop_agent, list_profiles MCP handlers
```

### Modified Files

```
src/types.ts         # Add Profile, SpawnedProcess interfaces
src/db.ts            # Add migration logic for new columns
src/state.ts         # Add spawnedProcesses map
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
