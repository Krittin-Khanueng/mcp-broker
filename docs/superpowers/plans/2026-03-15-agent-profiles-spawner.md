# Agent Profiles & Spawner Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add YAML-based agent profiles and a process spawner to mcp-broker so coordinators can spawn, monitor, and stop Claude Code instances via `spawn_agent`, `stop_agent`, and `list_profiles` MCP tools.

**Architecture:** Three new source files (`profiles.ts`, `spawner.ts`, `tools/spawn.ts`) follow the existing handler pattern. Profile YAML is loaded and validated with Zod, subprocess management uses Bun's `spawn()`, and lifecycle events are tracked in-memory per broker process + shared DB columns.

**Tech Stack:** Bun, TypeScript, bun:sqlite, Zod 4, @modelcontextprotocol/sdk, yaml (new dep)

**Spec:** `docs/superpowers/specs/2026-03-15-agent-profiles-and-spawner-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/profiles.ts` | Create | YAML loading, Zod schema, profile validation |
| `src/spawner.ts` | Create | Spawn/stop claude CLI, process tracking, MCP config generation, crash handling |
| `src/tools/spawn.ts` | Create | `spawn_agent`, `stop_agent`, `list_profiles` MCP tool handlers |
| `src/types.ts` | Modify | Add `Profile`, `SpawnedProcess` interfaces |
| `src/config.ts` | Modify | Add `profilesPath` to `BrokerConfig` |
| `src/db.ts` | Modify | Add migration for `pid`, `profile`, `spawned_by` columns |
| `src/state.ts` | Modify | Add `spawnedProcesses` map |
| `src/index.ts` | Modify | Register 3 new tools, add shutdown cleanup handler |
| `package.json` | Modify | Add `yaml` dependency |
| `tests/profiles.test.ts` | Create | Profile loading and validation tests |
| `tests/spawner.test.ts` | Create | Spawner unit tests (DB logic + buildSpawnArgs, NOT real claude spawn) |
| `tests/spawn-tools.test.ts` | Create | Tool handler integration tests |
| `tests/db.test.ts` | Modify | Add migration test |

> **Note:** `src/validators.ts` is NOT modified. Profile name validation reuses `validateName` from `validators.ts` directly — no duplication needed.
> **Note:** `spawnAgent()` cannot be fully unit-tested without a real `claude` binary. Tests verify the DB pre-insert logic, singleton guard, and arg building. Full spawn integration tests require manual testing or CI with `claude` available.

---

## Chunk 1: Foundation (Types, Config, DB Migration)

### Task 1: Add `yaml` dependency

- [ ] **Step 1: Install yaml package**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun add yaml
```

- [ ] **Step 2: Verify installation**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun run -e "import { parse } from 'yaml'; console.log(typeof parse)"
```

Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add yaml dependency for profile config parsing"
```

---

### Task 2: Add types for Profile and SpawnedProcess

**Files:**
- Modify: `src/types.ts`
- Test: `tests/db.test.ts` (existing, ensure no regression)

- [ ] **Step 1: Write type definitions**

Add to `src/types.ts`:

```typescript
export type PermissionMode = 'default' | 'auto' | 'bypassPermissions';

export interface Profile {
  system_prompt: string;
  model: 'opus' | 'sonnet' | 'haiku';
  max_budget_usd?: number;
  auto_register: boolean;
  allowed_tools?: string[];
  additional_instructions?: string;
  role: AgentRole;
  working_directory?: string;
  permission_mode: PermissionMode;
}

export interface SpawnedProcess {
  pid: number;
  profile: string;
  startedAt: Date;
  process: import('bun').Subprocess;
  mcpConfigPath: string;
}
```

- [ ] **Step 2: Run existing tests to verify no regression**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test
```

Expected: All existing tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add Profile and SpawnedProcess type definitions"
```

---

### Task 3: Add `profilesPath` to BrokerConfig

**Files:**
- Modify: `src/config.ts`

- [ ] **Step 1: Add profilesPath to BrokerConfig interface and loadConfig**

In `src/config.ts`, add `profilesPath: string` to the `BrokerConfig` interface and set it in `loadConfig()`:

```typescript
// Add to BrokerConfig interface:
profilesPath: string;

// Add to loadConfig() return:
profilesPath: process.env.BROKER_PROFILES_PATH || join(home, '.claude', 'mcp-broker', 'profiles.yml'),
```

- [ ] **Step 2: Run existing tests**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test
```

Expected: All pass (loadConfig is called in tests but profilesPath is unused so far).

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add profilesPath to BrokerConfig"
```

---

### Task 4: DB migration for new agent columns

**Files:**
- Modify: `src/db.ts`
- Test: `tests/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/db.test.ts`:

```typescript
it('adds profile columns via migration', () => {
  const db = createTestDb();
  const cols = db
    .prepare("SELECT name FROM pragma_table_info('agents')")
    .all() as { name: string }[];
  const colNames = cols.map((c) => c.name);
  expect(colNames).toContain('pid');
  expect(colNames).toContain('profile');
  expect(colNames).toContain('spawned_by');
});

it('migration is idempotent', () => {
  const db = createTestDb();
  // Call initDb again on same in-memory db shouldn't error
  // We simulate by running the migration check manually
  const cols = db
    .prepare("SELECT name FROM pragma_table_info('agents')")
    .all() as { name: string }[];
  expect(cols.map((c) => c.name)).toContain('profile');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/db.test.ts
```

Expected: FAIL — `pid`, `profile`, `spawned_by` columns don't exist yet.

- [ ] **Step 3: Add migration logic to `initDb`**

In `src/db.ts`, add after `db.exec(SCHEMA)`:

```typescript
// Migrate: add profile columns if not present
const cols = db
  .prepare("SELECT name FROM pragma_table_info('agents')")
  .all() as { name: string }[];
const colNames = cols.map((c) => c.name);

if (!colNames.includes('profile')) {
  db.exec('ALTER TABLE agents ADD COLUMN pid INTEGER');
  db.exec('ALTER TABLE agents ADD COLUMN profile TEXT');
  db.exec('ALTER TABLE agents ADD COLUMN spawned_by TEXT');
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/db.test.ts
```

Expected: All pass.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: add pid, profile, spawned_by columns to agents table with migration"
```

---

### Task 5: Add `spawnedProcesses` map to state

**Files:**
- Modify: `src/state.ts`

- [ ] **Step 1: Add spawnedProcesses map and accessors**

Add to `src/state.ts`:

```typescript
import type { SpawnedProcess } from './types.js';

const spawnedProcesses = new Map<string, SpawnedProcess>();

export function getSpawnedProcesses(): Map<string, SpawnedProcess> {
  return spawnedProcesses;
}

export function addSpawnedProcess(name: string, proc: SpawnedProcess): void {
  spawnedProcesses.set(name, proc);
}

export function removeSpawnedProcess(name: string): SpawnedProcess | undefined {
  const proc = spawnedProcesses.get(name);
  spawnedProcesses.delete(name);
  return proc;
}
```

- [ ] **Step 2: Run existing tests**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test
```

Expected: All pass.

- [ ] **Step 3: Commit**

```bash
git add src/state.ts
git commit -m "feat: add spawnedProcesses map to state module"
```

---

## Chunk 2: Profile Loading & Validation

### Task 6: Create `src/profiles.ts` with Zod schema and loader

**Files:**
- Create: `src/profiles.ts`
- Create: `tests/profiles.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/profiles.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadProfiles, validateProfile } from '../src/profiles.js';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tmpDir = join(tmpdir(), `broker-profiles-test-${Date.now()}`);
const profilesPath = join(tmpDir, 'profiles.yml');

beforeEach(() => {
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try { unlinkSync(profilesPath); } catch {}
});

describe('loadProfiles', () => {
  it('loads valid profiles from YAML', () => {
    writeFileSync(profilesPath, `
profiles:
  reviewer:
    system_prompt: "Review code"
    model: sonnet
    role: worker
`);
    const profiles = loadProfiles(profilesPath);
    expect(profiles.size).toBe(1);
    expect(profiles.get('reviewer')).toBeDefined();
    expect(profiles.get('reviewer')!.model).toBe('sonnet');
    expect(profiles.get('reviewer')!.auto_register).toBe(true);
    expect(profiles.get('reviewer')!.permission_mode).toBe('auto');
  });

  it('applies defaults for optional fields', () => {
    writeFileSync(profilesPath, `
profiles:
  worker1:
    system_prompt: "Do work"
    model: haiku
`);
    const profiles = loadProfiles(profilesPath);
    const p = profiles.get('worker1')!;
    expect(p.role).toBe('worker');
    expect(p.auto_register).toBe(true);
    expect(p.permission_mode).toBe('auto');
    expect(p.allowed_tools).toBeUndefined();
    expect(p.max_budget_usd).toBeUndefined();
  });

  it('loads multiple profiles', () => {
    writeFileSync(profilesPath, `
profiles:
  reviewer:
    system_prompt: "Review"
    model: sonnet
  tester:
    system_prompt: "Test"
    model: haiku
    max_budget_usd: 2.00
    allowed_tools:
      - Read
      - Bash
`);
    const profiles = loadProfiles(profilesPath);
    expect(profiles.size).toBe(2);
    expect(profiles.get('tester')!.max_budget_usd).toBe(2.00);
    expect(profiles.get('tester')!.allowed_tools).toEqual(['Read', 'Bash']);
  });

  it('throws on missing file', () => {
    expect(() => loadProfiles('/nonexistent/profiles.yml')).toThrow('config_not_found');
  });

  it('throws on invalid YAML', () => {
    writeFileSync(profilesPath, '{{{{invalid yaml');
    expect(() => loadProfiles(profilesPath)).toThrow('invalid_config');
  });

  it('throws on invalid profile name', () => {
    writeFileSync(profilesPath, `
profiles:
  "bad name!":
    system_prompt: "test"
    model: sonnet
`);
    expect(() => loadProfiles(profilesPath)).toThrow('invalid_profile');
  });

  it('throws on missing required fields', () => {
    writeFileSync(profilesPath, `
profiles:
  reviewer:
    model: sonnet
`);
    expect(() => loadProfiles(profilesPath)).toThrow('invalid_profile');
  });

  it('throws on invalid model', () => {
    writeFileSync(profilesPath, `
profiles:
  reviewer:
    system_prompt: "test"
    model: gpt4
`);
    expect(() => loadProfiles(profilesPath)).toThrow('invalid_profile');
  });

  it('returns empty map for empty profiles', () => {
    writeFileSync(profilesPath, `
profiles: {}
`);
    const profiles = loadProfiles(profilesPath);
    expect(profiles.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/profiles.test.ts
```

Expected: FAIL — `src/profiles.ts` doesn't exist.

- [ ] **Step 3: Create `src/profiles.ts`**

```typescript
import { readFileSync, existsSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { BrokerError } from './errors.js';
import { validateName } from './validators.js';
import type { Profile, AgentRole, PermissionMode } from './types.js';

const ProfileSchema = z.object({
  system_prompt: z.string().min(1).max(10000),
  model: z.enum(['opus', 'sonnet', 'haiku']),
  max_budget_usd: z.number().positive().optional(),
  auto_register: z.boolean().default(true),
  allowed_tools: z.array(z.string()).optional(),
  additional_instructions: z.string().optional(),
  role: z.enum(['peer', 'worker', 'supervisor']).default('worker'),
  working_directory: z.string().optional(),
  permission_mode: z.enum(['default', 'auto', 'bypassPermissions']).default('auto'),
});

const ProfilesFileSchema = z.object({
  profiles: z.record(z.string(), z.unknown()).default({}),
});

export function loadProfiles(filePath: string): Map<string, Profile> {
  if (!existsSync(filePath)) {
    throw new BrokerError('config_not_found', `profiles.yml not found at ${filePath}`);
  }

  let raw: unknown;
  try {
    const content = readFileSync(filePath, 'utf-8');
    raw = parse(content);
  } catch (e) {
    if (e instanceof BrokerError) throw e;
    throw new BrokerError('invalid_config', `profiles.yml parse error: ${(e as Error).message}`);
  }

  const fileResult = ProfilesFileSchema.safeParse(raw);
  if (!fileResult.success) {
    throw new BrokerError('invalid_config', `profiles.yml structure error: ${fileResult.error.message}`);
  }

  const profiles = new Map<string, Profile>();

  for (const [key, value] of Object.entries(fileResult.data.profiles)) {
    const nameErr = validateName(key);
    if (nameErr) {
      throw new BrokerError('invalid_profile', `Profile name "${key}": ${nameErr}`);
    }

    const result = ProfileSchema.safeParse(value);
    if (!result.success) {
      throw new BrokerError('invalid_profile', `Profile "${key}": ${result.error.message}`);
    }

    profiles.set(key, result.data as Profile);
  }

  return profiles;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/profiles.test.ts
```

Expected: All pass.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/profiles.ts tests/profiles.test.ts
git commit -m "feat: add profile loading and validation with Zod schema"
```

---

## Chunk 3: Spawner Module

### Task 7: Create `src/spawner.ts` — MCP config generation

**Files:**
- Create: `src/spawner.ts`
- Create: `tests/spawner.test.ts`

- [ ] **Step 1: Write failing tests for MCP config generation**

Create `tests/spawner.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { generateMcpConfig, cleanupMcpConfig } from '../src/spawner.js';
import { existsSync, readFileSync } from 'fs';

let createdPaths: string[] = [];

afterEach(() => {
  for (const p of createdPaths) {
    try { cleanupMcpConfig(p); } catch {}
  }
  createdPaths = [];
});

describe('generateMcpConfig', () => {
  it('creates a temp MCP config file', () => {
    const tmpPath = generateMcpConfig('test-agent', '/tmp/test.db');
    createdPaths.push(tmpPath);
    expect(existsSync(tmpPath)).toBe(true);
    expect(tmpPath).toContain('broker-mcp-test-agent');
  });

  it('contains correct broker server config', () => {
    const tmpPath = generateMcpConfig('test-agent', '/tmp/test.db');
    createdPaths.push(tmpPath);
    const content = JSON.parse(readFileSync(tmpPath, 'utf-8'));
    expect(content.mcpServers.broker.command).toBe('bun');
    expect(content.mcpServers.broker.env.BROKER_DB_PATH).toBe('/tmp/test.db');
    expect(content.mcpServers.broker.args[0]).toContain('index.ts');
  });
});

describe('cleanupMcpConfig', () => {
  it('deletes the temp file', () => {
    const tmpPath = generateMcpConfig('cleanup-test', '/tmp/test.db');
    expect(existsSync(tmpPath)).toBe(true);
    cleanupMcpConfig(tmpPath);
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('does not throw on missing file', () => {
    expect(() => cleanupMcpConfig('/nonexistent/file.json')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/spawner.test.ts
```

Expected: FAIL — `src/spawner.ts` doesn't exist.

- [ ] **Step 3: Create `src/spawner.ts` with MCP config functions**

```typescript
import { writeFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';

export function generateMcpConfig(agentName: string, brokerDbPath: string): string {
  const config = {
    mcpServers: {
      broker: {
        command: 'bun',
        args: [resolve(import.meta.dir, 'index.ts')],
        env: {
          BROKER_DB_PATH: brokerDbPath,
        },
      },
    },
  };
  const tmpPath = join(tmpdir(), `broker-mcp-${agentName}.json`);
  writeFileSync(tmpPath, JSON.stringify(config, null, 2));
  return tmpPath;
}

export function cleanupMcpConfig(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // File already deleted or never existed — safe to ignore
  }
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/spawner.test.ts
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/spawner.ts tests/spawner.test.ts
git commit -m "feat: add MCP config generation for spawned agents"
```

---

### Task 8: Add `buildSpawnArgs` to spawner

**Files:**
- Modify: `src/spawner.ts`
- Modify: `tests/spawner.test.ts`

- [ ] **Step 1: Write failing tests for buildSpawnArgs**

Add to `tests/spawner.test.ts`:

```typescript
import { buildSpawnArgs } from '../src/spawner.js';
import type { Profile } from '../src/types.js';

const baseProfile: Profile = {
  system_prompt: 'You are a reviewer.',
  model: 'sonnet',
  auto_register: true,
  role: 'worker',
  permission_mode: 'auto',
};

describe('buildSpawnArgs', () => {
  it('builds minimal args with required fields', () => {
    const args = buildSpawnArgs('reviewer', baseProfile, '/tmp/mcp.json', 'Review this code');
    expect(args).toContain('-p');
    expect(args).toContain('--model');
    expect(args).toContain('sonnet');
    expect(args).toContain('--output-format');
    expect(args).toContain('stream-json');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('auto');
    expect(args).toContain('--mcp-config');
    expect(args).toContain('/tmp/mcp.json');
    expect(args[args.length - 1]).toBe('Review this code');
  });

  it('prepends auto_register instruction to system prompt', () => {
    const args = buildSpawnArgs('reviewer', baseProfile, '/tmp/mcp.json', 'task');
    const sysPromptIdx = args.indexOf('--system-prompt');
    const sysPrompt = args[sysPromptIdx + 1];
    expect(sysPrompt).toContain('[BROKER REGISTRATION]');
    expect(sysPrompt).toContain('name: "reviewer"');
    expect(sysPrompt).toContain('role: "worker"');
    expect(sysPrompt).toContain('You are a reviewer.');
  });

  it('skips auto_register prefix when disabled', () => {
    const profile = { ...baseProfile, auto_register: false };
    const args = buildSpawnArgs('reviewer', profile, '/tmp/mcp.json', 'task');
    const sysPromptIdx = args.indexOf('--system-prompt');
    const sysPrompt = args[sysPromptIdx + 1];
    expect(sysPrompt).not.toContain('[BROKER REGISTRATION]');
    expect(sysPrompt).toBe('You are a reviewer.');
  });

  it('includes allowed_tools when set', () => {
    const profile = { ...baseProfile, allowed_tools: ['Read', 'Grep', 'Bash'] };
    const args = buildSpawnArgs('reviewer', profile, '/tmp/mcp.json', 'task');
    expect(args).toContain('--allowed-tools');
    expect(args).toContain('Read Grep Bash');
  });

  it('omits allowed_tools when not set', () => {
    const args = buildSpawnArgs('reviewer', baseProfile, '/tmp/mcp.json', 'task');
    expect(args).not.toContain('--allowed-tools');
  });

  it('includes max_budget_usd when set', () => {
    const profile = { ...baseProfile, max_budget_usd: 1.50 };
    const args = buildSpawnArgs('reviewer', profile, '/tmp/mcp.json', 'task');
    expect(args).toContain('--max-budget-usd');
    expect(args).toContain('1.5');
  });

  it('includes append-system-prompt when additional_instructions set', () => {
    const profile = { ...baseProfile, additional_instructions: '## Rules\n- Be nice' };
    const args = buildSpawnArgs('reviewer', profile, '/tmp/mcp.json', 'task');
    expect(args).toContain('--append-system-prompt');
    expect(args).toContain('## Rules\n- Be nice');
  });

  it('includes add-dir when working_directory set', () => {
    const profile = { ...baseProfile, working_directory: '/home/user/project' };
    const args = buildSpawnArgs('reviewer', profile, '/tmp/mcp.json', 'task', '/home/user/project');
    expect(args).toContain('--add-dir');
    expect(args).toContain('/home/user/project');
  });

  it('uses default task when not provided', () => {
    const args = buildSpawnArgs('reviewer', baseProfile, '/tmp/mcp.json');
    const lastArg = args[args.length - 1];
    expect(lastArg).toContain('You are ready to work');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/spawner.test.ts
```

Expected: FAIL — `buildSpawnArgs` not exported.

- [ ] **Step 3: Add `buildSpawnArgs` to `src/spawner.ts`**

```typescript
import type { Profile } from './types.js';

function buildAutoRegisterPrefix(name: string, role: string): string {
  return `[BROKER REGISTRATION]
On startup, immediately call the broker's "register" tool with:
  name: "${name}"
  role: "${role}"
Before exiting, call the broker's "unregister" tool.
[END BROKER REGISTRATION]

`;
}

export function buildSpawnArgs(
  name: string,
  profile: Profile,
  mcpConfigPath: string,
  task?: string,
  workingDirectory?: string,
): string[] {
  const args: string[] = ['-p'];

  // Model
  args.push('--model', profile.model);

  // System prompt (with optional auto_register prefix)
  let systemPrompt = profile.system_prompt;
  if (profile.auto_register) {
    systemPrompt = buildAutoRegisterPrefix(name, profile.role) + systemPrompt;
  }
  args.push('--system-prompt', systemPrompt);

  // Output format
  args.push('--output-format', 'stream-json');

  // Permission mode
  args.push('--permission-mode', profile.permission_mode);

  // MCP config
  args.push('--mcp-config', mcpConfigPath);

  // Optional: allowed tools
  if (profile.allowed_tools && profile.allowed_tools.length > 0) {
    args.push('--allowed-tools', profile.allowed_tools.join(' '));
  }

  // Optional: max budget
  if (profile.max_budget_usd !== undefined) {
    args.push('--max-budget-usd', String(profile.max_budget_usd));
  }

  // Optional: additional instructions
  if (profile.additional_instructions) {
    args.push('--append-system-prompt', profile.additional_instructions);
  }

  // Optional: working directory
  if (workingDirectory) {
    args.push('--add-dir', workingDirectory);
  }

  // Task (positional argument)
  args.push(task || `You are ready to work. Register with the broker and await instructions via poll_messages.`);

  return args;
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/spawner.test.ts
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/spawner.ts tests/spawner.test.ts
git commit -m "feat: add buildSpawnArgs for constructing claude CLI arguments from profiles"
```

---

### Task 9: Add `spawnAgent` and `stopAgent` to spawner

**Files:**
- Modify: `src/spawner.ts`
- Modify: `tests/spawner.test.ts`

- [ ] **Step 1: Write failing tests for spawnAgent and stopAgent**

Add to `tests/spawner.test.ts`:

```typescript
import { stopAgent } from '../src/spawner.js';
import { createTestDb } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { getSpawnedProcesses, clearAgent } from '../src/state.js';
import { handleRegister } from '../src/tools/register.js';
import { isOnline } from '../src/presence.js';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../src/config.js';

let db: Database;
let config: BrokerConfig;

// NOTE: spawnAgent() cannot be fully tested without a real `claude` binary.
// These tests verify the DB pre-insert logic, singleton guard conditions,
// and stopAgent error handling. Full spawn integration requires manual testing.

describe('spawnAgent DB pre-insert logic', () => {
  beforeEach(() => {
    db = createTestDb();
    config = loadConfig();
    clearAgent();
    getSpawnedProcesses().clear();
  });

  it('pre-inserted row has NULL heartbeat and correct profile/spawned_by', () => {
    handleRegister(db, config, { name: 'coordinator', role: 'supervisor' });

    const now = Date.now();
    db.prepare(
      'INSERT INTO agents (id, name, role, status, last_heartbeat, created_at, updated_at, profile, spawned_by) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)'
    ).run(uuidv4(), 'reviewer', 'worker', 'idle', now, now, 'reviewer', 'coordinator');

    const agent = db.prepare('SELECT * FROM agents WHERE name = ?').get('reviewer') as any;
    expect(agent.last_heartbeat).toBeNull();
    expect(agent.profile).toBe('reviewer');
    expect(agent.spawned_by).toBe('coordinator');
    expect(agent.status).toBe('idle');
  });

  it('pre-inserted row with NULL heartbeat allows register reconnect', () => {
    // Pre-insert with NULL heartbeat
    const now = Date.now();
    db.prepare(
      'INSERT INTO agents (id, name, role, status, last_heartbeat, created_at, updated_at, profile, spawned_by) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)'
    ).run(uuidv4(), 'reviewer', 'worker', 'idle', now, now, 'reviewer', 'coordinator');

    // Spawned agent registers — should reconnect (not throw)
    const result = handleRegister(db, config, { name: 'reviewer', role: 'worker' });
    expect(result.name).toBe('reviewer');
  });

  it('online agent blocks singleton guard', () => {
    handleRegister(db, config, { name: 'reviewer', role: 'worker' });
    clearAgent();

    const existing = db.prepare('SELECT last_heartbeat FROM agents WHERE name = ?').get('reviewer') as any;
    expect(isOnline(existing.last_heartbeat, config)).toBe(true);
  });
});

describe('stopAgent', () => {
  beforeEach(() => {
    db = createTestDb();
    getSpawnedProcesses().clear();
  });

  it('throws not_managed for unknown agent', () => {
    expect(() => stopAgent(db, 'unknown-agent')).toThrow('not_managed');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/spawner.test.ts
```

Expected: FAIL — `spawnAgent`, `stopAgent` not exported.

- [ ] **Step 3: Add `spawnAgent` and `stopAgent` to `src/spawner.ts`**

```typescript
import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from './config.js';
import { v4 as uuidv4 } from 'uuid';
import { existsSync } from 'fs';
import { isOnline } from './presence.js';
import { requireAgent, addSpawnedProcess, removeSpawnedProcess, getSpawnedProcesses } from './state.js';
import { BrokerError } from './errors.js';

export function spawnAgent(
  db: Database,
  config: BrokerConfig,
  profileName: string,
  profile: Profile,
  task?: string,
  cwd?: string,
): { name: string; pid: number; status: string } {
  const caller = requireAgent();

  // Resolve working directory
  const workingDir = cwd || profile.working_directory || process.cwd();
  const explicitWorkingDir = cwd || profile.working_directory;

  if (explicitWorkingDir && !existsSync(explicitWorkingDir)) {
    throw new BrokerError('invalid_directory', `working_directory "${explicitWorkingDir}" does not exist`);
  }

  // Singleton guard — wrapped in transaction to prevent race conditions
  const preInsert = db.transaction(() => {
    const existing = db.prepare('SELECT id, last_heartbeat FROM agents WHERE name = ?').get(profileName) as
      | { id: string; last_heartbeat: number | null }
      | undefined;

    if (existing && isOnline(existing.last_heartbeat, config)) {
      const proc = getSpawnedProcesses().get(profileName);
      const pidInfo = proc ? ` (pid: ${proc.pid})` : '';
      throw new BrokerError('agent_already_running', `"${profileName}" is online${pidInfo}`);
    }

    // Pre-insert or update agent row
    const now = Date.now();
    if (existing) {
      db.prepare(
        'UPDATE agents SET profile = ?, spawned_by = ?, updated_at = ?, last_heartbeat = NULL WHERE id = ?'
      ).run(profileName, caller.name, now, existing.id);
    } else {
      const id = uuidv4();
      db.prepare(
        'INSERT INTO agents (id, name, role, status, last_heartbeat, created_at, updated_at, profile, spawned_by) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)'
      ).run(id, profileName, profile.role, 'idle', now, now, profileName, caller.name);
    }
  });

  preInsert();

  // Generate temp MCP config
  const mcpConfigPath = generateMcpConfig(profileName, config.dbPath);

  // Build spawn args
  const args = buildSpawnArgs(profileName, profile, mcpConfigPath, task, explicitWorkingDir);

  // Spawn subprocess
  const proc = Bun.spawn(['claude', ...args], {
    cwd: workingDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const pid = proc.pid;

  // Update pid in DB
  db.prepare('UPDATE agents SET pid = ? WHERE name = ?').run(pid, profileName);

  // Track in memory
  addSpawnedProcess(profileName, {
    pid,
    profile: profileName,
    startedAt: new Date(),
    process: proc,
    mcpConfigPath,
  });

  // Listen for exit — guard against double-cleanup (stopAgent may have already cleaned up)
  proc.exited.then((code) => {
    if (getSpawnedProcesses().has(profileName)) {
      handleProcessExit(db, config, profileName, code);
    }
  });

  return { name: profileName, pid, status: 'spawned' };
}

function handleProcessExit(db: Database, config: BrokerConfig, agentName: string, exitCode: number): void {
  // Set offline
  db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE name = ?').run(agentName);

  // Remove from tracking
  const proc = removeSpawnedProcess(agentName);
  if (proc) {
    cleanupMcpConfig(proc.mcpConfigPath);
  }

  // Crash notification
  if (exitCode !== 0) {
    const crashedAgent = db.prepare('SELECT id, spawned_by FROM agents WHERE name = ?').get(agentName) as
      | { id: string; spawned_by: string | null }
      | undefined;

    if (crashedAgent?.spawned_by) {
      const spawnerAgent = db.prepare('SELECT id FROM agents WHERE name = ?').get(crashedAgent.spawned_by) as
        | { id: string }
        | undefined;

      if (spawnerAgent) {
        db.prepare(
          'INSERT INTO messages (seq, id, from_agent, to_agent, message_type, content, created_at) VALUES (NULL, ?, ?, ?, ?, ?, ?)'
        ).run(uuidv4(), crashedAgent.id, spawnerAgent.id, 'dm', `Agent "${agentName}" crashed (exit code ${exitCode})`, Date.now());
      }
    }
  }
}

export function stopAgent(db: Database, name: string): { name: string; stopped: boolean } {
  const proc = getSpawnedProcesses().get(name);
  if (!proc) {
    throw new BrokerError('not_managed', `"${name}" was not spawned by this session`);
  }

  // Remove from map FIRST to prevent double-cleanup from .exited handler
  removeSpawnedProcess(name);

  // SIGTERM (Bun Subprocess.kill() takes numeric signal)
  proc.process.kill(15); // SIGTERM

  // Wait up to 10s, then SIGKILL
  const pid = proc.pid;
  setTimeout(() => {
    try {
      process.kill(pid, 0); // Check if still alive (Node API, string OK)
      proc.process.kill(9); // SIGKILL
    } catch {
      // Already dead — expected
    }
  }, 10_000);

  // Cleanup DB and temp file
  db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE name = ?').run(name);
  cleanupMcpConfig(proc.mcpConfigPath);

  return { name, stopped: true };
}

export function shutdownAllAgents(db: Database): void {
  const entries = [...getSpawnedProcesses().entries()];
  getSpawnedProcesses().clear(); // Clear map first to prevent .exited handlers from double-cleanup

  for (const [name, proc] of entries) {
    try {
      proc.process.kill(15); // SIGTERM
    } catch {}
    db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE name = ?').run(name);
    cleanupMcpConfig(proc.mcpConfigPath);
  }

  // SIGKILL survivors after 5s
  setTimeout(() => {
    for (const [, proc] of entries) {
      try {
        process.kill(proc.pid, 0);
        proc.process.kill(9); // SIGKILL
      } catch {}
    }
  }, 5_000);
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/spawner.test.ts
```

Expected: All pass.

- [ ] **Step 5: Run full test suite**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test
```

Expected: All pass.

- [ ] **Step 6: Commit**

```bash
git add src/spawner.ts tests/spawner.test.ts
git commit -m "feat: add spawnAgent, stopAgent, and shutdownAllAgents to spawner module"
```

---

## Chunk 4: MCP Tool Handlers & Registration

### Task 10: Create `src/tools/spawn.ts` — tool handlers

**Files:**
- Create: `src/tools/spawn.ts`
- Create: `tests/spawn-tools.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/spawn-tools.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'bun:test';
import { handleListProfiles } from '../src/tools/spawn.js';
import { createTestDb } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { clearAgent } from '../src/state.js';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../src/config.js';

const tmpDir = join(tmpdir(), `broker-spawn-test-${Date.now()}`);
const profilesPath = join(tmpDir, 'profiles.yml');

let db: Database;
let config: BrokerConfig;

beforeEach(() => {
  db = createTestDb();
  config = { ...loadConfig(), profilesPath };
  clearAgent();
  mkdirSync(tmpDir, { recursive: true });
});

describe('handleListProfiles', () => {
  it('returns empty list when no profiles file', () => {
    config = { ...config, profilesPath: '/nonexistent/profiles.yml' };
    const result = handleListProfiles(db, config);
    expect(result.profiles).toEqual([]);
  });

  it('returns profiles with is_running false when no agents online', () => {
    writeFileSync(profilesPath, `
profiles:
  reviewer:
    system_prompt: "Review code"
    model: sonnet
  tester:
    system_prompt: "Test code"
    model: haiku
    max_budget_usd: 2.0
`);
    const result = handleListProfiles(db, config);
    expect(result.profiles).toHaveLength(2);
    expect(result.profiles[0].name).toBe('reviewer');
    expect(result.profiles[0].model).toBe('sonnet');
    expect(result.profiles[0].is_running).toBe(false);
    expect(result.profiles[1].name).toBe('tester');
    expect(result.profiles[1].max_budget_usd).toBe(2.0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/spawn-tools.test.ts
```

Expected: FAIL — `src/tools/spawn.ts` doesn't exist.

- [ ] **Step 3: Create `src/tools/spawn.ts`**

```typescript
import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../config.js';
import { loadProfiles } from '../profiles.js';
import { spawnAgent, stopAgent } from '../spawner.js';
import { requireAgent } from '../state.js';
import { isOnline } from '../presence.js';
import { BrokerError } from '../errors.js';

interface SpawnAgentParams {
  profile: string;
  task?: string;
  cwd?: string;
}

interface StopAgentParams {
  name: string;
}

export function handleSpawnAgent(
  db: Database,
  config: BrokerConfig,
  params: SpawnAgentParams,
): Record<string, unknown> {
  requireAgent(); // Must be registered

  const profiles = loadProfiles(config.profilesPath);
  const profile = profiles.get(params.profile);
  if (!profile) {
    throw new BrokerError('profile_not_found', `"${params.profile}" not in profiles.yml`);
  }

  return spawnAgent(db, config, params.profile, profile, params.task, params.cwd);
}

export function handleStopAgent(
  db: Database,
  config: BrokerConfig,
  params: StopAgentParams,
): Record<string, unknown> {
  return stopAgent(db, params.name);
}

export function handleListProfiles(
  db: Database,
  config: BrokerConfig,
): Record<string, unknown> {
  let profiles: Map<string, any>;
  try {
    profiles = loadProfiles(config.profilesPath);
  } catch {
    return { profiles: [] };
  }

  const result = [];
  for (const [name, profile] of profiles) {
    // Check if running via DB
    let isRunning = false;
    const agent = db.prepare(
      'SELECT pid, last_heartbeat FROM agents WHERE profile = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(name) as { pid: number | null; last_heartbeat: number | null } | undefined;

    if (agent?.pid && isOnline(agent.last_heartbeat, config)) {
      try {
        process.kill(agent.pid, 0);
        isRunning = true;
      } catch {
        // Process dead — clean up stale row
        db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE pid = ?').run(agent.pid);
      }
    }

    result.push({
      name,
      model: profile.model,
      role: profile.role,
      max_budget_usd: profile.max_budget_usd ?? null,
      is_running: isRunning,
    });
  }

  return { profiles: result };
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test tests/spawn-tools.test.ts
```

Expected: All pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/spawn.ts tests/spawn-tools.test.ts
git commit -m "feat: add spawn_agent, stop_agent, list_profiles tool handlers"
```

---

### Task 11: Register new tools in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add imports and tool registrations**

Add to imports in `src/index.ts`:

```typescript
import { handleSpawnAgent, handleStopAgent, handleListProfiles } from './tools/spawn.js';
import { shutdownAllAgents } from './spawner.js';
```

Add before `// --- Start server ---`:

```typescript
// --- Profiles & Spawner ---

server.registerTool(
  'spawn_agent',
  {
    title: 'Spawn Agent',
    description: 'Spawn a Claude Code instance from a pre-defined profile',
    inputSchema: {
      profile: z.string().describe('Profile name from profiles.yml'),
      task: z.string().optional().describe('Task/prompt for the spawned agent'),
      cwd: z.string().optional().describe('Working directory override'),
    },
  },
  async ({ profile, task, cwd }) => wrapHandler(() => handleSpawnAgent(db, config, { profile, task, cwd })),
);

server.registerTool(
  'stop_agent',
  {
    title: 'Stop Agent',
    description: 'Stop a spawned agent by name',
    inputSchema: {
      name: z.string().describe('Agent name to stop'),
    },
    annotations: { destructiveHint: true },
  },
  async ({ name }) => wrapHandler(() => handleStopAgent(db, config, { name })),
);

server.registerTool(
  'list_profiles',
  {
    title: 'List Profiles',
    description: 'List all available agent profiles and their running status',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => wrapHandler(() => handleListProfiles(db, config)),
);
```

Add after `await server.connect(transport)`:

```typescript
// Cleanup spawned agents on shutdown
process.on('SIGTERM', () => shutdownAllAgents(db));
process.on('SIGINT', () => shutdownAllAgents(db));
```

- [ ] **Step 2: Run full test suite**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test
```

Expected: All pass.

- [ ] **Step 3: Verify broker starts without error**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && timeout 3 bun src/index.ts 2>&1 || true
```

Expected: No crash on startup (will timeout after 3s since it waits for stdio).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: register spawn_agent, stop_agent, list_profiles tools and shutdown handler"
```

---

## Chunk 5: Example Profile & Final Verification

### Task 12: Create example `profiles.yml`

**Files:**
- Create: `profiles.example.yml`

- [ ] **Step 1: Create example profile file**

Create `profiles.example.yml` at project root:

```yaml
# Example agent profiles for mcp-broker
# Copy to ~/.claude/mcp-broker/profiles.yml and customize
#
# Each profile defines a Claude Code agent that can be spawned
# via the spawn_agent MCP tool.

profiles:
  reviewer:
    system_prompt: |
      You are an expert code reviewer.
      Review code for quality, security, performance, and maintainability.
      Provide actionable feedback with specific line references.
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
      - Check OWASP Top 10 vulnerabilities
      - Flag N+1 query patterns
      - Report only — do not modify code
    role: worker
    permission_mode: auto

  tester:
    system_prompt: |
      You are a test engineer.
      Write comprehensive tests covering happy paths, edge cases, and error scenarios.
    model: haiku
    max_budget_usd: 2.00
    auto_register: true
    allowed_tools:
      - Read
      - Write
      - Edit
      - Bash
      - Glob
      - Grep
    additional_instructions: |
      ## Testing Standards
      - Aim for 80%+ code coverage
      - Use the project's existing test framework
      - Write descriptive test names
    role: worker
    permission_mode: auto

  researcher:
    system_prompt: |
      You are a research assistant.
      Search the codebase, documentation, and web to answer questions
      and provide technical analysis.
    model: sonnet
    auto_register: true
    allowed_tools:
      - Read
      - Grep
      - Glob
      - Bash
    role: worker
    permission_mode: auto
```

- [ ] **Step 2: Commit**

```bash
git add profiles.example.yml
git commit -m "docs: add example profiles.yml for agent profile configuration"
```

---

### Task 13: Final integration verification

- [ ] **Step 1: Run full test suite**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun test
```

Expected: All tests pass (existing + new).

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && bun run build 2>&1 | tail -5
```

Expected: No type errors.

- [ ] **Step 3: Verify broker starts**

```bash
cd /Users/krittinkhaneung/.claude/mcp-broker && timeout 3 bun src/index.ts 2>&1 || true
```

Expected: No crash.

- [ ] **Step 4: Commit any fixes if needed, then final commit**

```bash
git log --oneline -10
```

Expected: Clean commit history with all tasks.
