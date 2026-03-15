import { writeFileSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import type { Profile } from './types.js';

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
    // File already deleted or never existed
  }
}

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

  args.push('--model', profile.model);

  let systemPrompt = profile.system_prompt;
  if (profile.auto_register) {
    systemPrompt = buildAutoRegisterPrefix(name, profile.role) + systemPrompt;
  }
  args.push('--system-prompt', systemPrompt);

  args.push('--output-format', 'stream-json');
  args.push('--permission-mode', profile.permission_mode);
  args.push('--mcp-config', mcpConfigPath);

  if (profile.allowed_tools && profile.allowed_tools.length > 0) {
    args.push('--allowed-tools', profile.allowed_tools.join(' '));
  }

  if (profile.max_budget_usd !== undefined) {
    args.push('--max-budget-usd', String(profile.max_budget_usd));
  }

  if (profile.additional_instructions) {
    args.push('--append-system-prompt', profile.additional_instructions);
  }

  if (workingDirectory) {
    args.push('--add-dir', workingDirectory);
  }

  args.push(task || 'You are ready to work. Register with the broker and await instructions via poll_messages.');

  return args;
}
