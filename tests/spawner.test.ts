import { describe, it, expect, afterEach } from 'bun:test';
import { generateMcpConfig, cleanupMcpConfig, buildSpawnArgs } from '../src/spawner.js';
import { existsSync, readFileSync } from 'fs';
import type { Profile } from '../src/types.js';

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
