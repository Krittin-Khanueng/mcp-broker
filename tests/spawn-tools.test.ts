import { describe, it, expect, beforeEach } from 'bun:test';
import { handleListProfiles } from '../src/tools/spawn.js';
import { createTestDb } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { clearAgent } from '../src/state.js';
import { writeFileSync, mkdirSync } from 'fs';
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
    expect((result.profiles as any[]).length).toBe(2);
    expect((result.profiles as any[])[0].name).toBe('reviewer');
    expect((result.profiles as any[])[0].model).toBe('sonnet');
    expect((result.profiles as any[])[0].is_running).toBe(false);
    expect((result.profiles as any[])[1].name).toBe('tester');
    expect((result.profiles as any[])[1].max_budget_usd).toBe(2.0);
  });
});
