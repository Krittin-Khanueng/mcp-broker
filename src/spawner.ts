import { resolve } from 'path';
import { existsSync } from 'fs';
import type { Database } from 'bun:sqlite';
import { v4 as uuidv4 } from 'uuid';
import { query, AbortError } from '@anthropic-ai/claude-agent-sdk';
import type { Options as QueryOptions } from '@anthropic-ai/claude-agent-sdk';
import type { Profile, AgentResult } from './types.js';
import { MODEL_MAP } from './types.js';
import type { BrokerConfig } from './config.js';
import { requireAgent, addSpawnedAgent, removeSpawnedAgent, getSpawnedAgents } from './state.js';
import { isOnline } from './presence.js';
import { BrokerError } from './errors.js';

function buildAutoRegisterPrefix(name: string, role: string): string {
  return `[BROKER REGISTRATION]
On startup, immediately call the broker's "register" tool with:
  name: "${name}"
  role: "${role}"
Before exiting, call the broker's "unregister" tool.
[END BROKER REGISTRATION]

`;
}

export function buildQueryOptions(
  name: string,
  profile: Profile,
  brokerDbPath: string,
  task?: string,
  workingDir?: string,
): { prompt: string; options: QueryOptions; abortController: AbortController } {
  let systemPrompt = profile.system_prompt;
  if (profile.auto_register) {
    systemPrompt = buildAutoRegisterPrefix(name, profile.role) + systemPrompt;
  }
  if (profile.additional_instructions) {
    systemPrompt += '\n\n' + profile.additional_instructions;
  }

  const abortController = new AbortController();

  const options: QueryOptions = {
    model: MODEL_MAP[profile.model],
    systemPrompt,
    permissionMode: profile.permission_mode === 'auto' ? 'default' : profile.permission_mode,
    allowDangerouslySkipPermissions: profile.permission_mode === 'bypassPermissions',
    mcpServers: {
      broker: {
        command: 'bun',
        args: [resolve(import.meta.dir, 'index.ts')],
        env: { BROKER_DB_PATH: brokerDbPath },
      },
    },
    persistSession: false,
    abortController,
    ...(profile.allowed_tools?.length && { allowedTools: profile.allowed_tools }),
    ...(profile.max_budget_usd !== undefined && { maxBudgetUsd: profile.max_budget_usd }),
    ...(workingDir && { cwd: workingDir }),
  };

  const prompt = task || 'You are ready to work. Register with the broker and await instructions via poll_messages.';

  return { prompt, options, abortController };
}

export function spawnAgent(
  db: Database,
  config: BrokerConfig,
  profileName: string,
  profile: Profile,
  task?: string,
  cwd?: string,
): { name: string; status: string } {
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
      const agent = getSpawnedAgents().get(profileName);
      const runningInfo = agent?.running ? ' (running)' : '';
      throw new BrokerError('agent_already_running', `"${profileName}" is online${runningInfo}`);
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

  const { prompt, options, abortController } = buildQueryOptions(
    profileName, profile, config.dbPath, task, explicitWorkingDir || workingDir,
  );

  const completionPromise = runAgentInBackground(db, config, profileName, prompt, options);

  addSpawnedAgent(profileName, {
    profile: profileName,
    startedAt: new Date(),
    abortController,
    completionPromise,
    running: true,
  });

  return { name: profileName, status: 'spawned' };
}

async function runAgentInBackground(
  db: Database,
  config: BrokerConfig,
  agentName: string,
  prompt: string,
  options: QueryOptions,
): Promise<AgentResult> {
  let result: AgentResult = { subtype: 'error_during_execution' };
  try {
    for await (const msg of query({ prompt, options })) {
      if (msg.type === 'result') {
        result = {
          subtype: msg.subtype,
          totalCostUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
        };
      }
    }
  } catch (err) {
    if (err instanceof AbortError) {
      result = { subtype: 'success' };
    }
  } finally {
    handleAgentCompletion(db, config, agentName, result);
  }
  return result;
}

function handleAgentCompletion(
  db: Database,
  config: BrokerConfig,
  agentName: string,
  result: AgentResult,
): void {
  db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE name = ?').run(agentName);

  const agent = getSpawnedAgents().get(agentName);
  if (agent) {
    agent.running = false;
  }
  removeSpawnedAgent(agentName);

  if (result.subtype !== 'success') {
    const crashedAgent = db.prepare('SELECT id, spawned_by FROM agents WHERE name = ?').get(agentName) as
      | { id: string; spawned_by: string | null }
      | undefined;

    if (crashedAgent?.spawned_by) {
      const spawnerAgent = db.prepare('SELECT id FROM agents WHERE name = ?').get(crashedAgent.spawned_by) as
        | { id: string }
        | undefined;

      if (spawnerAgent) {
        let reason: string;
        switch (result.subtype) {
          case 'error_max_budget_usd':
            reason = `budget exceeded ($${result.totalCostUsd?.toFixed(2) ?? '?'})`;
            break;
          case 'error_max_turns':
            reason = `max turns reached (${result.numTurns ?? '?'})`;
            break;
          default:
            reason = 'failed';
        }

        db.prepare(
          'INSERT INTO messages (seq, id, from_agent, to_agent, message_type, content, created_at) VALUES (NULL, ?, ?, ?, ?, ?, ?)'
        ).run(uuidv4(), crashedAgent.id, spawnerAgent.id, 'dm', `Agent "${agentName}" ${reason}`, Date.now());
      }
    }
  }
}

export function stopAgent(db: Database, name: string): { name: string; stopped: boolean } {
  const agent = getSpawnedAgents().get(name);
  if (!agent) {
    throw new BrokerError('not_managed', `"${name}" was not spawned by this session`);
  }

  removeSpawnedAgent(name);
  agent.running = false;
  agent.abortController.abort();

  db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE name = ?').run(name);

  return { name, stopped: true };
}

export function shutdownAllAgents(db: Database): void {
  const entries = [...getSpawnedAgents().entries()];
  getSpawnedAgents().clear();

  for (const [name, agent] of entries) {
    agent.abortController.abort();
    db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE name = ?').run(name);
  }
}
