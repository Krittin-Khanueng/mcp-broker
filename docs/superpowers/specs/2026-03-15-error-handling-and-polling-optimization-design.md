# Error Handling & Polling Optimization

**Date:** 2026-03-15
**Scope:** 4 improvements — BrokerError class, unified inbox optimization, consistent handler wrapping, Bun migration

## 1. BrokerError Class + wrapHandler Refactor

### Problem

`wrapHandler` catches all exceptions and returns `{ error: 'not_registered' }` regardless of error type. SQLite failures, validation errors, and bugs all appear as "not_registered" to the caller.

Additionally, some handlers return error objects as success responses (e.g., `{ error: 'validation_error' }`), making it impossible for callers to distinguish success from failure at the protocol level.

### Design

**New file: `src/errors.ts`**

```typescript
export class BrokerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
```

**Changes to `src/state.ts`:**

`requireAgent()` throws `new BrokerError('not_registered', 'Agent not registered')` instead of `new Error('not_registered')`.

**Changes to `src/index.ts` — `wrapHandler`:**

```typescript
function wrapHandler(fn: () => Record<string, unknown>) {
  try {
    const result = fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (e) {
    if (e instanceof BrokerError) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message }) }] };
    }
    throw e; // re-throw unknown errors — MCP SDK returns proper error response
  }
}
```

**Changes to handler files — throw instead of return errors:**

All handlers that currently return `{ error: '<code>', ... }` objects will throw `BrokerError` instead. Error codes are preserved exactly as they exist in the current source:

| File | Handler | Current return | New throw |
|------|---------|---------------|-----------|
| `register.ts` | `handleRegister` | `{ error: 'validation_error', message }` (×2, name + role) | `throw new BrokerError('validation_error', message)` |
| `register.ts` | `handleRegister` | `{ error: 'limit_exceeded', message }` | `throw new BrokerError('limit_exceeded', message)` |
| `register.ts` | `handleRegister` | `{ error: 'name_taken', suggestion }` | `throw new BrokerError('name_taken', suggestion)` |
| `register.ts` | `handleHeartbeat` | `{ error: 'validation_error', message }` | `throw new BrokerError('validation_error', message)` |
| `messaging.ts` | `handleSendMessage` | `{ error: 'validation_error', message }` | `throw new BrokerError('validation_error', message)` |
| `messaging.ts` | `handleSendMessage` | `{ error: 'channel_not_found', channel }` | `throw new BrokerError('channel_not_found', channel)` |
| `messaging.ts` | `handleSendMessage` | `{ error: 'no_agents_with_role', role }` | `throw new BrokerError('no_agents_with_role', role)` |
| `messaging.ts` | `handleSendMessage` | `{ error: 'agent_not_found', name }` | `throw new BrokerError('agent_not_found', name)` |
| `messaging.ts` | `handlePollMessages` | `{ error: 'channel_not_found', channel }` | `throw new BrokerError('channel_not_found', channel)` |
| `channels.ts` | `handleCreateChannel` | `{ error: 'validation_error', message }` | `throw new BrokerError('validation_error', message)` |
| `channels.ts` | `handleCreateChannel` | `{ error: 'limit_exceeded', message }` | `throw new BrokerError('limit_exceeded', message)` |
| `channels.ts` | `handleCreateChannel` | `{ error: 'channel_exists', channel }` | `throw new BrokerError('channel_exists', channel)` |
| `channels.ts` | `handleJoinChannel` | `{ error: 'channel_not_found', channel }` | `throw new BrokerError('channel_not_found', channel)` |
| `channels.ts` | `handleLeaveChannel` | `{ error: 'channel_not_found', channel }` | `throw new BrokerError('channel_not_found', channel)` |
| `history.ts` | `handleGetHistory` | `{ error: 'agent_not_found', name }` | `throw new BrokerError('agent_not_found', name)` |
| `history.ts` | `handleGetHistory` | `{ error: 'channel_not_found', channel }` | `throw new BrokerError('channel_not_found', channel)` |
| `history.ts` | `handlePurgeHistory` | `{ error: 'invalid_date', before_date }` | `throw new BrokerError('invalid_date', before_date)` |

**Note:** `handleJoinChannel` returns `{ status: 'already_joined' }` — this is NOT an error, it is a success response. Left unchanged.

**Error response format** changes from varied shapes to consistent `{ error: string, message: string }`.

## 2. Unified Inbox — Batch Cursors + UNION ALL

### Problem

`handlePollMessages` unified inbox executes **5 + 2N** queries (N = joined channels). Each channel triggers a cursor read + message query. At 20 channels = 45 queries per poll, with in-memory sort/slice afterward.

### Design

Replace the N+1 loop with 3 queries total. The single-channel poll path (when `params.channel` is set) is unchanged — only the unified inbox path is rewritten.

**Query 1: Fetch joined channels** (unchanged)

```sql
SELECT channel_id FROM channel_members WHERE agent_id = ?
```

**Query 2: Batch fetch all cursors** (new — replaces N+2 individual cursor reads)

```sql
SELECT source, last_read_seq FROM read_cursors WHERE agent_id = ? AND source IN (?, ?, ...)
```

Sources list: `'dm'`, `'broadcast'`, `'channel:<id1>'`, `'channel:<id2>'`, ...

**Query 3: Single UNION ALL** (new — replaces N+2 individual message queries)

Each UNION ALL branch includes its own `LIMIT ?` to prevent unbounded row materialization from a single source with a large backlog:

```sql
SELECT * FROM (
  SELECT m.*, a.name as from_name FROM messages m
    LEFT JOIN agents a ON m.from_agent = a.id
    WHERE m.to_agent = ? AND m.message_type = 'dm' AND m.seq > ?
    ORDER BY m.seq ASC LIMIT ?
)
UNION ALL
SELECT * FROM (
  SELECT m.*, a.name as from_name FROM messages m
    LEFT JOIN agents a ON m.from_agent = a.id
    WHERE m.to_agent = ? AND m.message_type = 'broadcast' AND m.seq > ?
    ORDER BY m.seq ASC LIMIT ?
)
UNION ALL
SELECT * FROM (
  SELECT m.*, a.name as from_name FROM messages m
    LEFT JOIN agents a ON m.from_agent = a.id
    WHERE m.channel_id = ? AND m.seq > ?
    ORDER BY m.seq ASC LIMIT ?
)
-- repeated per joined channel
ORDER BY seq ASC
LIMIT ?
```

The SQL is built dynamically — channel UNION ALL clauses are appended per joined channel. Parameters are bound positionally. The per-branch LIMIT matches the outer LIMIT to preserve the current behavior where each source contributes at most `limit` messages before merge.

**Cursor update logic** remains the same: after getting the merged result set, group by message_type/channel_id and update per-source cursors in a transaction.

**Complexity reduction:** 5 + 2N queries → 3 queries (constant, regardless of channel count).

## 3. Consistent Handler Wrapping

### Problem

`register` and `list_peers` manually construct MCP responses without `wrapHandler`, creating two different error-handling paths. `register` and `list_peers` don't catch exceptions — any unexpected throw bubbles up unhandled.

### Design

After fixing `wrapHandler` (section 1), wrap all 12 tools consistently:

```typescript
// register — currently manual
async ({ name, role, metadata }) => wrapHandler(() => handleRegister(db, config, { name, role, metadata })),

// list_peers — currently manual
async ({ role }) => wrapHandler(() => handleListPeers(db, config, { role })),
```

`list_peers` doesn't call `requireAgent()`, so it won't throw `BrokerError('not_registered')` — this is correct and still works with `wrapHandler`.

`register` sets the agent session internally and may throw `BrokerError` for validation/name-taken — all handled cleanly by the new `wrapHandler`.

## 4. Bun Migration

### Problem

The project runs on Node.js with `better-sqlite3` (native C addon requiring node-gyp compilation). Since Bun is already available on the machine, switching to Bun removes the native compilation step and simplifies the runtime dependency.

### Design

**Replace `better-sqlite3` with `bun:sqlite`:**

`bun:sqlite` is built into Bun — no native addon, no `node-gyp`, no `npm install` compilation.

API differences to handle in `src/db.ts`:

| `better-sqlite3` | `bun:sqlite` |
|-------------------|--------------|
| `new Database(path)` | `new Database(path)` (same) |
| `db.pragma('journal_mode = WAL')` | `db.run('PRAGMA journal_mode = WAL')` |
| `db.prepare(sql).run(...)` | `db.prepare(sql).run(...)` (same) |
| `db.prepare(sql).get(...)` | `db.prepare(sql).get(...)` (same) |
| `db.prepare(sql).all(...)` | `db.prepare(sql).all(...)` (same) |
| `db.transaction(fn)` | `db.transaction(fn)` (same) |

Core query/prepare/transaction API is nearly identical. Main change is pragma calls and import path.

**Update `package.json`:**

- Remove `better-sqlite3` and `@types/better-sqlite3` from dependencies
- Change `"test": "vitest run"` → keep vitest (runs fine on Bun via `bun run test`)
- Change `"build": "tsc"` → keep tsc for type checking, runtime uses Bun directly
- Add `"start": "bun src/index.ts"` — Bun runs TypeScript directly, no build step needed for dev
- Entry point for MCP config: `bun src/index.ts` (or `bun dist/index.js` after build)

**Update imports across all files:**

- `import Database from 'better-sqlite3'` → `import { Database } from 'bun:sqlite'`
- Type imports: `import type Database from 'better-sqlite3'` → use Bun's built-in types

**MCP config update:**

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

### Scope

- This is a runtime swap, not an architecture change
- All business logic, tool handlers, and test logic remain unchanged
- Only `db.ts`, imports, and `package.json` are affected

## Files Changed

| File | Change |
|------|--------|
| `src/errors.ts` | **New** — BrokerError class |
| `src/state.ts` | Use BrokerError in requireAgent() |
| `src/index.ts` | Fix wrapHandler, wrap register + list_peers |
| `src/db.ts` | Switch from better-sqlite3 to bun:sqlite, update pragma calls |
| `src/tools/messaging.ts` | Throw BrokerError, rewrite unified inbox |
| `src/tools/register.ts` | Throw BrokerError instead of returning error objects |
| `src/tools/channels.ts` | Throw BrokerError instead of returning error objects |
| `src/tools/history.ts` | Throw BrokerError instead of returning error objects |
| `src/tools/peers.ts` | Update Database import |
| `src/presence.ts` | Update Database import |
| `package.json` | Remove better-sqlite3, add bun start script |
| `tests/helpers.ts` | Switch to bun:sqlite for in-memory test DB |
| `tests/*.test.ts` | Update error assertions, add multi-channel poll test |

## Testing

- Existing tests: update error response format from varied shapes to `{ error, message }`
- New test: handler throws unexpected Error (not BrokerError) → verify it propagates (not swallowed)
- New test: unified inbox with 3+ joined channels → verify messages merged correctly + all cursors updated
- Run full suite: `bun run test`
- Verify MCP server starts: `bun src/index.ts` (should connect via stdio without error)
