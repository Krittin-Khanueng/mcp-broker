import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../config.js';
import type { Profile } from '../types.js';
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
  // requireAgent is called inside spawnAgent — no need to duplicate here

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
  requireAgent();
  return stopAgent(db, params.name);
}

export function handleListProfiles(
  db: Database,
  config: BrokerConfig,
): Record<string, unknown> {
  let profiles: Map<string, Profile>;
  try {
    profiles = loadProfiles(config.profilesPath);
  } catch (e) {
    if (e instanceof BrokerError && e.code === 'config_not_found') {
      return { profiles: [] };
    }
    throw e;
  }

  const result = [];
  for (const [name, profile] of profiles) {
    let isRunning = false;
    const agent = db.prepare(
      'SELECT pid, last_heartbeat FROM agents WHERE profile = ? ORDER BY updated_at DESC LIMIT 1'
    ).get(name) as { pid: number | null; last_heartbeat: number | null } | undefined;

    if (agent?.pid && isOnline(agent.last_heartbeat, config)) {
      try {
        process.kill(agent.pid, 0);
        isRunning = true;
      } catch {
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
