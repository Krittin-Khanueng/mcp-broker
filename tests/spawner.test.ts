import { describe, it, expect, beforeEach } from 'bun:test';
import { buildQueryOptions, stopAgent } from '../src/spawner.js';
import type { Profile } from '../src/types.js';
import { MODEL_MAP } from '../src/types.js';
import { createTestDb } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { getSpawnedAgents, clearAgent, addSpawnedAgent } from '../src/state.js';
import { handleRegister } from '../src/tools/register.js';
import { isOnline } from '../src/presence.js';
import { v4 as uuidv4 } from 'uuid';
import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../src/config.js';

const baseProfile: Profile = {
  system_prompt: 'You are a reviewer.',
  model: 'sonnet',
  auto_register: true,
  role: 'worker',
  permission_mode: 'auto',
};

describe('buildQueryOptions', () => {
  it('returns correct model mapping', () => {
    const { options } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db');
    expect(options.model).toBe(MODEL_MAP.sonnet);
  });

  it('maps all model types correctly', () => {
    for (const [alias, fullId] of Object.entries(MODEL_MAP)) {
      const profile = { ...baseProfile, model: alias as Profile['model'] };
      const { options } = buildQueryOptions('test', profile, '/tmp/test.db');
      expect(options.model).toBe(fullId);
    }
  });

  it('prepends auto_register instruction to system prompt', () => {
    const { options } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db');
    const systemPrompt = options.systemPrompt as string;
    expect(systemPrompt).toContain('[BROKER REGISTRATION]');
    expect(systemPrompt).toContain('name: "reviewer"');
    expect(systemPrompt).toContain('role: "worker"');
    expect(systemPrompt).toContain('You are a reviewer.');
  });

  it('skips auto_register prefix when disabled', () => {
    const profile = { ...baseProfile, auto_register: false };
    const { options } = buildQueryOptions('reviewer', profile, '/tmp/test.db');
    const systemPrompt = options.systemPrompt as string;
    expect(systemPrompt).not.toContain('[BROKER REGISTRATION]');
    expect(systemPrompt).toBe('You are a reviewer.');
  });

  it('includes allowed_tools when set', () => {
    const profile = { ...baseProfile, allowed_tools: ['Read', 'Grep', 'Bash'] };
    const { options } = buildQueryOptions('reviewer', profile, '/tmp/test.db');
    expect(options.allowedTools).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('omits allowed_tools when not set', () => {
    const { options } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db');
    expect(options.allowedTools).toBeUndefined();
  });

  it('includes max_budget_usd when set', () => {
    const profile = { ...baseProfile, max_budget_usd: 1.50 };
    const { options } = buildQueryOptions('reviewer', profile, '/tmp/test.db');
    expect(options.maxBudgetUsd).toBe(1.50);
  });

  it('appends additional_instructions to system prompt', () => {
    const profile = { ...baseProfile, additional_instructions: '## Rules\n- Be nice' };
    const { options } = buildQueryOptions('reviewer', profile, '/tmp/test.db');
    const systemPrompt = options.systemPrompt as string;
    expect(systemPrompt).toContain('## Rules\n- Be nice');
  });

  it('sets cwd when working directory provided', () => {
    const { options } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db', undefined, '/home/user/project');
    expect(options.cwd).toBe('/home/user/project');
  });

  it('uses default task when not provided', () => {
    const { prompt } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db');
    expect(prompt).toContain('You are ready to work');
  });

  it('uses custom task when provided', () => {
    const { prompt } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db', 'Review this code');
    expect(prompt).toBe('Review this code');
  });

  it('returns an AbortController', () => {
    const { abortController } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db');
    expect(abortController).toBeInstanceOf(AbortController);
  });

  it('configures mcpServers with broker', () => {
    const { options } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db');
    expect(options.mcpServers).toBeDefined();
    const broker = (options.mcpServers as any).broker;
    expect(broker.command).toBe('bun');
    expect(broker.args[0]).toContain('index.ts');
    expect(broker.env.BROKER_DB_PATH).toBe('/tmp/test.db');
  });

  it('sets persistSession to false', () => {
    const { options } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db');
    expect(options.persistSession).toBe(false);
  });

  it('maps permission_mode auto to default', () => {
    const { options } = buildQueryOptions('reviewer', baseProfile, '/tmp/test.db');
    expect(options.permissionMode).toBe('default');
  });

  it('passes bypassPermissions with allowDangerouslySkipPermissions', () => {
    const profile = { ...baseProfile, permission_mode: 'bypassPermissions' as const };
    const { options } = buildQueryOptions('reviewer', profile, '/tmp/test.db');
    expect(options.permissionMode).toBe('bypassPermissions');
    expect(options.allowDangerouslySkipPermissions).toBe(true);
  });
});

let db: Database;
let config: BrokerConfig;

describe('spawnAgent DB pre-insert logic', () => {
  beforeEach(() => {
    db = createTestDb();
    config = loadConfig();
    clearAgent();
    getSpawnedAgents().clear();
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
    const now = Date.now();
    db.prepare(
      'INSERT INTO agents (id, name, role, status, last_heartbeat, created_at, updated_at, profile, spawned_by) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)'
    ).run(uuidv4(), 'reviewer', 'worker', 'idle', now, now, 'reviewer', 'coordinator');

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
    getSpawnedAgents().clear();
  });

  it('throws not_managed for unknown agent', () => {
    expect(() => stopAgent(db, 'unknown-agent')).toThrow();
  });

  it('aborts the agent and removes from map', () => {
    const abortController = new AbortController();
    addSpawnedAgent('test-agent', {
      profile: 'test-agent',
      startedAt: new Date(),
      abortController,
      completionPromise: Promise.resolve({ subtype: 'success' }),
      running: true,
    });

    db.prepare(
      'INSERT INTO agents (id, name, role, status, last_heartbeat, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(uuidv4(), 'test-agent', 'worker', 'idle', Date.now(), Date.now(), Date.now());

    const result = stopAgent(db, 'test-agent');
    expect(result.stopped).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
    expect(getSpawnedAgents().has('test-agent')).toBe(false);
  });
});
