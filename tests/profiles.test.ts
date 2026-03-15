import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { loadProfiles } from '../src/profiles.js';
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
