import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../config.js';
import type { Profile } from '../types.js';
import { loadProfiles } from '../profiles.js';
import { spawnAgent, stopAgent } from '../spawner.js';
import { requireAgent, getSpawnedAgents } from '../state.js';
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
    const isRunning = getSpawnedAgents().get(name)?.running ?? false;

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
