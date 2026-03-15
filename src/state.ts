import type { SessionAgent, SpawnedAgent } from './types.js';
import { BrokerError } from './errors.js';

let currentAgent: SessionAgent | null = null;

export function getAgent(): SessionAgent | null {
  return currentAgent;
}

export function setAgent(agent: SessionAgent): void {
  currentAgent = agent;
}

export function clearAgent(): void {
  currentAgent = null;
}

export function requireAgent(): SessionAgent {
  if (!currentAgent) {
    throw new BrokerError('not_registered', 'Agent not registered');
  }
  return currentAgent;
}

const spawnedAgents = new Map<string, SpawnedAgent>();

export function getSpawnedAgents(): Map<string, SpawnedAgent> {
  return spawnedAgents;
}

export function addSpawnedAgent(name: string, agent: SpawnedAgent): void {
  spawnedAgents.set(name, agent);
}

export function removeSpawnedAgent(name: string): SpawnedAgent | undefined {
  const agent = spawnedAgents.get(name);
  spawnedAgents.delete(name);
  return agent;
}
