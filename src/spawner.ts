import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import type { Database } from 'bun:sqlite';
import { v4 as uuidv4 } from 'uuid';
import type { Profile } from './types.js';
import type { BrokerConfig } from './config.js';
import { requireAgent, addSpawnedProcess, removeSpawnedProcess, getSpawnedProcesses } from './state.js';
import { isOnline } from './presence.js';
import { BrokerError } from './errors.js';

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

export function spawnAgent(
  db: Database,
  config: BrokerConfig,
  profileName: string,
  profile: Profile,
  task?: string,
  cwd?: string,
): { name: string; pid: number; status: string } {
  const caller = requireAgent();

  const workingDir = cwd || profile.working_directory || process.cwd();
  const explicitWorkingDir = cwd || profile.working_directory;

  if (explicitWorkingDir && !existsSync(explicitWorkingDir)) {
    throw new BrokerError('invalid_directory', `working_directory "${explicitWorkingDir}" does not exist`);
  }

  // Singleton guard in transaction
  const preInsert = db.transaction(() => {
    const existing = db.prepare('SELECT id, last_heartbeat FROM agents WHERE name = ?').get(profileName) as
      | { id: string; last_heartbeat: number | null }
      | undefined;

    if (existing && isOnline(existing.last_heartbeat, config)) {
      const proc = getSpawnedProcesses().get(profileName);
      const pidInfo = proc ? ` (pid: ${proc.pid})` : '';
      throw new BrokerError('agent_already_running', `"${profileName}" is online${pidInfo}`);
    }

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

  const mcpConfigPath = generateMcpConfig(profileName, config.dbPath);
  const args = buildSpawnArgs(profileName, profile, mcpConfigPath, task, explicitWorkingDir);

  const proc = Bun.spawn(['claude', ...args], {
    cwd: workingDir,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const pid = proc.pid;
  db.prepare('UPDATE agents SET pid = ? WHERE name = ?').run(pid, profileName);

  addSpawnedProcess(profileName, {
    pid,
    profile: profileName,
    startedAt: new Date(),
    process: proc,
    mcpConfigPath,
  });

  // Guard against double-cleanup (stopAgent may have already cleaned up)
  proc.exited.then((code) => {
    if (getSpawnedProcesses().has(profileName)) {
      handleProcessExit(db, config, profileName, code);
    }
  });

  return { name: profileName, pid, status: 'spawned' };
}

function handleProcessExit(db: Database, config: BrokerConfig, agentName: string, exitCode: number): void {
  db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE name = ?').run(agentName);

  const proc = removeSpawnedProcess(agentName);
  if (proc) {
    cleanupMcpConfig(proc.mcpConfigPath);
  }

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

  proc.process.kill(15); // SIGTERM (Bun uses numeric signals)

  const pid = proc.pid;
  setTimeout(() => {
    try {
      process.kill(pid, 0); // Check if still alive
      proc.process.kill(9); // SIGKILL
    } catch {
      // Already dead
    }
  }, 10_000);

  db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE name = ?').run(name);
  cleanupMcpConfig(proc.mcpConfigPath);

  return { name, stopped: true };
}

export function shutdownAllAgents(db: Database): void {
  const entries = [...getSpawnedProcesses().entries()];
  getSpawnedProcesses().clear();

  for (const [name, proc] of entries) {
    try {
      proc.process.kill(15); // SIGTERM
    } catch {}
    db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE name = ?').run(name);
    cleanupMcpConfig(proc.mcpConfigPath);
  }

  setTimeout(() => {
    for (const [, proc] of entries) {
      try {
        process.kill(proc.pid, 0);
        proc.process.kill(9); // SIGKILL
      } catch {}
    }
  }, 5_000);
}
