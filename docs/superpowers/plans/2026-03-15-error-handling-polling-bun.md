# Error Handling, Polling Optimization & Bun Migration — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix error swallowing in wrapHandler, optimize unified inbox from 5+2N to 3 queries, make handler wrapping consistent, and migrate runtime from Node.js to Bun.

**Architecture:** Introduce `BrokerError` typed error class so `wrapHandler` can distinguish known errors from bugs. Rewrite unified inbox polling as a single UNION ALL query. Switch from `better-sqlite3` to `bun:sqlite` built-in.

**Tech Stack:** Bun, bun:sqlite, @modelcontextprotocol/sdk, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-03-15-error-handling-and-polling-optimization-design.md`

**Breaking change:** All error responses change from varied field names (`suggestion`, `role`, `channel`, `name`, `before_date`) to a uniform `{ error: string, message: string }` shape. This is intentional — callers should parse `error` for the code and `message` for context. No known external consumers depend on the old field names.

**Note on bun:sqlite pragmas:** The spec's API table shows `db.run('PRAGMA ...')` but bun:sqlite has no top-level `.run()`. The correct method is `db.exec('PRAGMA ...')`. For reading pragma values, use `db.prepare('PRAGMA ...').get()`.

---

## Task 1: BrokerError Class

**Files:**
- Create: `src/errors.ts`
- Modify: `src/state.ts`

- [ ] **Step 1: Create `src/errors.ts`**

```typescript
export class BrokerError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
```

- [ ] **Step 2: Update `src/state.ts` to use BrokerError**

Replace:
```typescript
throw new Error('not_registered');
```
With:
```typescript
import { BrokerError } from './errors.js';
// ...
throw new BrokerError('not_registered', 'Agent not registered');
```

- [ ] **Step 3: Run tests to verify nothing breaks**

Run: `npx vitest run`
Expected: All existing tests PASS (BrokerError extends Error, so `catch` blocks still catch it)

- [ ] **Step 4: Commit**

```bash
git add src/errors.ts src/state.ts
git commit -m "feat: add BrokerError class, use in requireAgent()"
```

---

## Task 2: Fix wrapHandler + Consistent Wrapping

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update wrapHandler in `src/index.ts`**

Add import at top:
```typescript
import { BrokerError } from './errors.js';
```

Replace the `wrapHandler` function (lines 26-33):
```typescript
function wrapHandler(fn: () => Record<string, unknown>) {
  try {
    const result = fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (e) {
    if (e instanceof BrokerError) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message }) }] };
    }
    throw e;
  }
}
```

- [ ] **Step 2: Wrap `register` handler (lines 48-51)**

Replace:
```typescript
  async ({ name, role, metadata }) => {
    const result = handleRegister(db, config, { name, role, metadata });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
```
With:
```typescript
  async ({ name, role, metadata }) => wrapHandler(() => handleRegister(db, config, { name, role, metadata })),
```

- [ ] **Step 3: Wrap `list_peers` handler (lines 165-168)**

Replace:
```typescript
  async ({ role }) => {
    const result = handleListPeers(db, config, { role });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
```
With:
```typescript
  async ({ role }) => wrapHandler(() => handleListPeers(db, config, { role })),
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "fix: wrapHandler re-throws unknown errors, wrap register + list_peers consistently"
```

---

## Task 3: Convert Handler Error Returns to BrokerError Throws

**Files:**
- Modify: `src/tools/register.ts`
- Modify: `src/tools/messaging.ts` (error returns only — inbox rewrite is Task 4)
- Modify: `src/tools/channels.ts`
- Modify: `src/tools/history.ts`
- Modify: `tests/register.test.ts`
- Modify: `tests/messaging.test.ts`
- Modify: `tests/channels.test.ts`
- Modify: `tests/history.test.ts`

### Step-by-step for each handler file:

- [ ] **Step 1: Convert `src/tools/register.ts`**

Add import:
```typescript
import { BrokerError } from '../errors.js';
```

Replace each error return with throw:

Line 21 — `return { error: 'validation_error', message: nameErr };`
→ `throw new BrokerError('validation_error', nameErr);`

Line 25 — `return { error: 'validation_error', message: roleErr };`
→ `throw new BrokerError('validation_error', roleErr);`

Line 38 — `return { error: 'limit_exceeded', message: \`Max ${config.maxAgents} agents\` };`
→ `throw new BrokerError('limit_exceeded', \`Max ${config.maxAgents} agents\`);`

Line 45 — `return { error: 'name_taken', suggestion: \`${params.name}-${suffix}\` };`
→ `throw new BrokerError('name_taken', \`${params.name}-${suffix}\`);`

Line 87 — `return { error: 'validation_error', message: 'Status must be idle, busy, or blocked' };`
→ `throw new BrokerError('validation_error', 'Status must be idle, busy, or blocked');`

- [ ] **Step 2: Update `tests/register.test.ts`**

Tests that assert error returns now need to catch BrokerError. Since handlers throw instead of return, tests wrap in `expect(() => ...).toThrow()`:

Replace duplicate name test (line 41-47):
```typescript
  it('rejects duplicate online name', () => {
    handleRegister(db, config, { name: 'worker-1' });
    clearAgent();
    expect(() => handleRegister(db, config, { name: 'worker-1' })).toThrow(BrokerError);
    try {
      handleRegister(db, config, { name: 'worker-1' });
    } catch (e) {
      expect((e as BrokerError).code).toBe('name_taken');
      expect((e as BrokerError).message).toBe('worker-1-2');
    }
  });
```

Replace invalid name test (line 49-52):
```typescript
  it('rejects invalid name', () => {
    expect(() => handleRegister(db, config, { name: 'bad name!' })).toThrow(BrokerError);
  });
```

Add test for invalid heartbeat status:
```typescript
  it('rejects invalid heartbeat status', () => {
    handleRegister(db, config, { name: 'agent-1' });
    expect(() => handleHeartbeat(db, config, { status: 'dancing' })).toThrow(BrokerError);
  });
```

Add import at top:
```typescript
import { BrokerError } from '../src/errors.js';
```

- [ ] **Step 3: Run register tests**

Run: `npx vitest run tests/register.test.ts`
Expected: All PASS

- [ ] **Step 4: Convert `src/tools/messaging.ts` (error returns only)**

Add import:
```typescript
import { BrokerError } from '../errors.js';
```

Line 24 — `if (contentErr) return { error: 'validation_error', message: contentErr };`
→ `if (contentErr) throw new BrokerError('validation_error', contentErr);`

Line 36 — `if (!ch) return { error: 'channel_not_found', channel: channelName };`
→ `if (!ch) throw new BrokerError('channel_not_found', channelName);`

Line 63 — `if (targets.length === 0) return { error: 'no_agents_with_role', role };`
→ `if (targets.length === 0) throw new BrokerError('no_agents_with_role', role);`

Line 75 — `if (!recipient) return { error: 'agent_not_found', name: to };`
→ `if (!recipient) throw new BrokerError('agent_not_found', to);`

Line 101 — `if (!ch) return { error: 'channel_not_found', channel: params.channel };`
→ `if (!ch) throw new BrokerError('channel_not_found', params.channel);`

- [ ] **Step 5: Update `tests/messaging.test.ts`**

Add import:
```typescript
import { BrokerError } from '../src/errors.js';
```

Replace unknown agent test (line 59-64):
```typescript
  it('rejects message to unknown agent', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleSendMessage(db, config, { to: 'nobody', content: 'hello' })).toThrow(BrokerError);
  });
```

Replace empty content test (line 66-71):
```typescript
  it('rejects empty content', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleSendMessage(db, config, { to: 'all', content: '' })).toThrow(BrokerError);
  });
```

Add test for polling non-existent channel (import `handlePollMessages` if not already imported):
```typescript
  it('rejects polling non-existent channel', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handlePollMessages(db, config, { channel: '#nonexistent' })).toThrow(BrokerError);
  });
```

- [ ] **Step 6: Run messaging tests**

Run: `npx vitest run tests/messaging.test.ts`
Expected: All PASS

- [ ] **Step 7: Convert `src/tools/channels.ts`**

Add import:
```typescript
import { BrokerError } from '../errors.js';
```

Line 21 — `if (err) return { error: 'validation_error', message: err };`
→ `if (err) throw new BrokerError('validation_error', err);`

Line 24 — `return { error: 'limit_exceeded', message: \`Max ${config.maxChannels} channels\` };`
→ `throw new BrokerError('limit_exceeded', \`Max ${config.maxChannels} channels\`);`

Line 27 — `if (existing) return { error: 'channel_exists', channel: params.name };`
→ `if (existing) throw new BrokerError('channel_exists', params.name);`

Line 41 — `if (!ch) return { error: 'channel_not_found', channel: params.channel };`
→ `if (!ch) throw new BrokerError('channel_not_found', params.channel);`

Line 52 — `if (!ch) return { error: 'channel_not_found', channel: params.channel };`
→ `if (!ch) throw new BrokerError('channel_not_found', params.channel);`

- [ ] **Step 8: Update `tests/channels.test.ts`**

Add import:
```typescript
import { BrokerError } from '../src/errors.js';
```

Replace invalid name test (line 29-34):
```typescript
  it('rejects invalid channel name', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleCreateChannel(db, config, { name: 'no-hash' })).toThrow(BrokerError);
  });
```

Replace duplicate name test (line 36-42):
```typescript
  it('rejects duplicate channel name', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    handleCreateChannel(db, config, { name: '#general' });
    expect(() => handleCreateChannel(db, config, { name: '#general' })).toThrow(BrokerError);
  });
```

Add tests for join/leave non-existent channel:
```typescript
  it('rejects joining non-existent channel', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleJoinChannel(db, { channel: '#ghost' })).toThrow(BrokerError);
  });

  it('rejects leaving non-existent channel', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleLeaveChannel(db, { channel: '#ghost' })).toThrow(BrokerError);
  });
```

- [ ] **Step 9: Run channels tests**

Run: `npx vitest run tests/channels.test.ts`
Expected: All PASS

- [ ] **Step 10: Convert `src/tools/history.ts`**

Add import:
```typescript
import { BrokerError } from '../errors.js';
```

Line 26 — `if (!peer) return { error: 'agent_not_found', name: params.peer };`
→ `if (!peer) throw new BrokerError('agent_not_found', params.peer);`

Line 33 — `if (!ch) return { error: 'channel_not_found', channel: params.channel };`
→ `if (!ch) throw new BrokerError('channel_not_found', params.channel);`

Line 63 — `if (isNaN(cutoff)) return { error: 'invalid_date', before_date: params.before_date };`
→ `if (isNaN(cutoff)) throw new BrokerError('invalid_date', params.before_date);`

- [ ] **Step 11: Add missing history error tests in `tests/history.test.ts`**

Add import:
```typescript
import { BrokerError } from '../src/errors.js';
```

Add tests:
```typescript
  it('rejects unknown peer in history', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleGetHistory(db, config, { peer: 'ghost' })).toThrow(BrokerError);
  });

  it('rejects unknown channel in history', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleGetHistory(db, config, { channel: '#ghost' })).toThrow(BrokerError);
  });

  it('rejects invalid purge date', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handlePurgeHistory(db, { before_date: 'not-a-date' })).toThrow(BrokerError);
  });
```

- [ ] **Step 12: Add wrapHandler propagation test**

Create `tests/wrapHandler.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { BrokerError } from '../src/errors.js';

// Recreate wrapHandler locally since it's not exported
function wrapHandler(fn: () => Record<string, unknown>) {
  try {
    const result = fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (e) {
    if (e instanceof BrokerError) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message }) }] };
    }
    throw e;
  }
}

describe('wrapHandler', () => {
  it('returns JSON content for success', () => {
    const result = wrapHandler(() => ({ status: 'ok' }));
    expect(JSON.parse(result.content[0].text)).toEqual({ status: 'ok' });
  });

  it('catches BrokerError and returns error JSON', () => {
    const result = wrapHandler(() => { throw new BrokerError('test_error', 'test message'); });
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'test_error', message: 'test message' });
  });

  it('re-throws non-BrokerError exceptions', () => {
    expect(() => wrapHandler(() => { throw new TypeError('unexpected bug'); })).toThrow(TypeError);
  });
});
```

- [ ] **Step 13: Run all tests**

Run: `npx vitest run`
Expected: All PASS

- [ ] **Step 14: Commit**

```bash
git add src/tools/ tests/
git commit -m "refactor: convert all handler error returns to BrokerError throws"
```

---

## Task 4: Unified Inbox UNION ALL Optimization

**Files:**
- Modify: `src/tools/messaging.ts` (unified inbox path only, lines 128-200)
- Modify: `tests/messaging.test.ts`

- [ ] **Step 1: Add multi-channel poll test in `tests/messaging.test.ts`**

Add at the end of the `poll_messages` describe block:

```typescript
  it('returns unified inbox across DMs, broadcasts, and multiple channels', () => {
    const a = registerAgent(db, config, 'alice');
    const b = registerAgent(db, config, 'bob');

    // Create 3 channels and join bob to all
    for (const ch of ['#ch1', '#ch2', '#ch3']) {
      const chId = ch.replace('#', '');
      db.prepare('INSERT INTO channels (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
        chId, ch, a.id, Date.now()
      );
      db.prepare('INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)').run(chId, a.id, Date.now());
      db.prepare('INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)').run(chId, b.id, Date.now());
    }

    // Alice sends: 1 DM to bob, 1 broadcast, 1 msg per channel = 5 messages
    setAgent(a);
    handleSendMessage(db, config, { to: 'bob', content: 'dm-msg' });
    handleSendMessage(db, config, { to: 'all', content: 'broadcast-msg' });
    handleSendMessage(db, config, { to: 'channel:#ch1', content: 'ch1-msg' });
    handleSendMessage(db, config, { to: 'channel:#ch2', content: 'ch2-msg' });
    handleSendMessage(db, config, { to: 'channel:#ch3', content: 'ch3-msg' });

    // Bob polls unified inbox
    setAgent(b);
    const result = handlePollMessages(db, config, {});
    const msgs = result.messages as Array<{ content: string; message_type: string }>;
    expect(msgs).toHaveLength(5);
    expect(msgs.map(m => m.content).sort()).toEqual([
      'broadcast-msg', 'ch1-msg', 'ch2-msg', 'ch3-msg', 'dm-msg'
    ]);

    // Second poll should return empty (cursors updated)
    const result2 = handlePollMessages(db, config, {});
    expect(result2.messages).toHaveLength(0);
  });
```

- [ ] **Step 2: Run new test to verify it passes with current implementation**

Run: `npx vitest run tests/messaging.test.ts`
Expected: All PASS (current N+1 implementation is correct, just slow)

- [ ] **Step 3: Rewrite unified inbox in `src/tools/messaging.ts`**

Replace the entire unified inbox section (lines 128-200) — from `// Unified inbox` comment to end of function — with:

```typescript
  // Unified inbox: DMs + broadcasts + all joined channels
  const joinedChannels = db
    .prepare('SELECT channel_id FROM channel_members WHERE agent_id = ?')
    .all(agent.id) as { channel_id: string }[];

  // Batch fetch all cursors in one query
  const sources = ['dm', 'broadcast', ...joinedChannels.map(c => `channel:${c.channel_id}`)];
  const placeholders = sources.map(() => '?').join(', ');
  const cursorRows = db
    .prepare(`SELECT source, last_read_seq FROM read_cursors WHERE agent_id = ? AND source IN (${placeholders})`)
    .all(agent.id, ...sources) as { source: string; last_read_seq: number }[];
  const cursorMap = new Map(cursorRows.map(r => [r.source, r.last_read_seq]));
  const getCursor = (source: string): number => cursorMap.get(source) ?? 0;

  // Build UNION ALL query
  const parts: string[] = [];
  const params: (string | number)[] = [];

  // DMs branch
  parts.push(`SELECT * FROM (
    SELECT m.*, a.name as from_name FROM messages m
    LEFT JOIN agents a ON m.from_agent = a.id
    WHERE m.to_agent = ? AND m.message_type = 'dm' AND m.seq > ?
    ORDER BY m.seq ASC LIMIT ?
  )`);
  params.push(agent.id, getCursor('dm'), limit);

  // Broadcasts branch
  parts.push(`SELECT * FROM (
    SELECT m.*, a.name as from_name FROM messages m
    LEFT JOIN agents a ON m.from_agent = a.id
    WHERE m.to_agent = ? AND m.message_type = 'broadcast' AND m.seq > ?
    ORDER BY m.seq ASC LIMIT ?
  )`);
  params.push(agent.id, getCursor('broadcast'), limit);

  // Channel branches
  for (const { channel_id } of joinedChannels) {
    parts.push(`SELECT * FROM (
      SELECT m.*, a.name as from_name FROM messages m
      LEFT JOIN agents a ON m.from_agent = a.id
      WHERE m.channel_id = ? AND m.seq > ?
      ORDER BY m.seq ASC LIMIT ?
    )`);
    params.push(channel_id, getCursor(`channel:${channel_id}`), limit);
  }

  const sql = parts.join(' UNION ALL ') + ' ORDER BY seq ASC LIMIT ?';
  params.push(limit);

  const limited = db.prepare(sql).all(...params) as MessageRow[];

  // Update cursors
  const updateCursor = db.prepare(
    'INSERT OR REPLACE INTO read_cursors (agent_id, source, last_read_seq) VALUES (?, ?, ?)'
  );

  db.transaction(() => {
    const returnedDMs = limited.filter((m) => m.message_type === 'dm');
    if (returnedDMs.length > 0) {
      updateCursor.run(agent.id, 'dm', returnedDMs[returnedDMs.length - 1].seq);
    }
    const returnedBroadcasts = limited.filter((m) => m.message_type === 'broadcast');
    if (returnedBroadcasts.length > 0) {
      updateCursor.run(agent.id, 'broadcast', returnedBroadcasts[returnedBroadcasts.length - 1].seq);
    }
    for (const { channel_id } of joinedChannels) {
      const chMsgs = limited.filter((m) => m.channel_id === channel_id);
      if (chMsgs.length > 0) {
        updateCursor.run(agent.id, `channel:${channel_id}`, chMsgs[chMsgs.length - 1].seq);
      }
    }
  })();

  return { messages: limited, unread_count: limited.length };
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`
Expected: All PASS (including the new multi-channel test)

- [ ] **Step 5: Commit**

```bash
git add src/tools/messaging.ts tests/messaging.test.ts
git commit -m "perf: replace N+1 unified inbox with single UNION ALL query"
```

---

## Task 5: Bun Migration

**Files:**
- Modify: `src/db.ts`
- Modify: `src/presence.ts`
- Modify: `src/tools/register.ts`
- Modify: `src/tools/messaging.ts`
- Modify: `src/tools/channels.ts`
- Modify: `src/tools/history.ts`
- Modify: `src/tools/peers.ts`
- Modify: `tests/helpers.ts`
- Modify: `tests/db.test.ts`
- Modify: `tests/register.test.ts`
- Modify: `tests/messaging.test.ts`
- Modify: `tests/channels.test.ts`
- Modify: `tests/history.test.ts`
- Modify: `tests/peers.test.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Update `src/db.ts` — switch to bun:sqlite**

Replace entire file:
```typescript
import { Database } from 'bun:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  role TEXT DEFAULT 'peer' CHECK (role IN ('supervisor', 'worker', 'peer')),
  status TEXT DEFAULT 'idle' CHECK (status IN ('idle', 'busy', 'blocked')),
  metadata TEXT,
  last_heartbeat INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  purpose TEXT,
  created_by TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (channel_id, agent_id)
);

CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  from_agent TEXT REFERENCES agents(id) ON DELETE SET NULL,
  to_agent TEXT REFERENCES agents(id) ON DELETE SET NULL,
  channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('dm', 'channel', 'broadcast')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, seq);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_from_agent ON messages(from_agent, seq);

CREATE TABLE IF NOT EXISTS read_cursors (
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, source)
);
`;

export function initDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
```

- [ ] **Step 2: Update all source file imports**

In each of these files, replace the Database import:

`src/presence.ts` — replace `import type Database from 'better-sqlite3';` with `import type { Database } from 'bun:sqlite';` and change `Database.Database` → `Database` in all function signatures.

`src/tools/register.ts` — same import change, `Database.Database` → `Database`.

`src/tools/messaging.ts` — same import change, `Database.Database` → `Database`.

`src/tools/channels.ts` — same import change, `Database.Database` → `Database`.

`src/tools/history.ts` — same import change, `Database.Database` → `Database`.

`src/tools/peers.ts` — same import change, `Database.Database` → `Database`.

`src/index.ts` — no Database import exists here (it uses `initDb` return type). No change needed.

- [ ] **Step 3: Fix `.run()` return type in `src/presence.ts`**

`pruneStaleAgents` uses `result.changes`. In bun:sqlite, `stmt.run()` returns `void`.

Replace lines 27-34:
```typescript
export function pruneStaleAgents(db: Database, pruneAfterDays: number): number {
  const cutoff = Date.now() - pruneAfterDays * 24 * 60 * 60 * 1000;
  db.prepare(
    `DELETE FROM agents WHERE
      (last_heartbeat IS NOT NULL AND last_heartbeat < ?) OR
      (last_heartbeat IS NULL AND updated_at < ?)`
  ).run(cutoff, cutoff);
  return (db.prepare('SELECT changes() as cnt').get() as { cnt: number }).cnt;
}
```

- [ ] **Step 4: Fix `.run()` return type in `src/tools/history.ts`**

`handlePurgeHistory` uses `result.changes`. Replace line 64-65:
```typescript
  db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
  const deleted = (db.prepare('SELECT changes() as cnt').get() as { cnt: number }).cnt;
  return { deleted_count: deleted };
```

- [ ] **Step 5: Update test imports**

`tests/helpers.ts` — full replacement:
```typescript
import { Database } from 'bun:sqlite';
import { initDb } from '../src/db.js';
import { handleRegister } from '../src/tools/register.js';
import { clearAgent } from '../src/state.js';
import type { BrokerConfig } from '../src/config.js';
import type { SessionAgent } from '../src/types.js';

export function createTestDb(): Database {
  return initDb(':memory:');
}

export function registerAgent(
  db: Database,
  config: BrokerConfig,
  name: string,
  role: string = 'peer'
): SessionAgent {
  clearAgent();
  const result = handleRegister(db, config, { name, role });
  return { id: result.agent_id as string, name, role: role as SessionAgent['role'] };
}
```

All test files (`tests/register.test.ts`, `tests/messaging.test.ts`, `tests/channels.test.ts`, `tests/history.test.ts`, `tests/peers.test.ts`, `tests/db.test.ts`) — replace `import type Database from 'better-sqlite3';` with `import type { Database } from 'bun:sqlite';`. The type is `Database` directly (not `Database.Database`).

- [ ] **Step 6: Update `tests/db.test.ts` pragma assertions**

The WAL mode test uses `db.pragma('journal_mode')` which doesn't exist in bun:sqlite. Replace:

```typescript
  it('enables WAL mode on file-based DB', () => {
    const tmpPath = join(tmpdir(), `broker-test-${Date.now()}.db`);
    const db = initDb(tmpPath);
    const result = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(result.journal_mode).toBe('wal');
    db.close();
    try { unlinkSync(tmpPath); unlinkSync(tmpPath + '-wal'); unlinkSync(tmpPath + '-shm'); } catch {}
  });

  it('enables foreign keys', () => {
    const db = createTestDb();
    const result = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);
  });
```

- [ ] **Step 7: Update `package.json`**

Remove `better-sqlite3` from `dependencies` and `@types/better-sqlite3` from `devDependencies`. Add `start` script:

```json
{
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "bun src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 8: Update `tsconfig.json` — add bun types**

Add `"types": ["bun-types"]` to compilerOptions:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 9: Install bun-types, remove better-sqlite3**

Run:
```bash
bun remove better-sqlite3 @types/better-sqlite3
bun add -d bun-types
```

- [ ] **Step 10: Run all tests**

Run: `bun run test`
Expected: All PASS

- [ ] **Step 11: Verify MCP server starts**

Run: `timeout 3 bun src/index.ts 2>&1 || true`
Expected: No crash, no import errors (will hang on stdio — timeout is expected)

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "chore: migrate from Node.js + better-sqlite3 to Bun + bun:sqlite"
```
