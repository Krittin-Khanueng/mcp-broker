import type { SessionAgent, SpawnedProcess } from './types.js';
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

const spawnedProcesses = new Map<string, SpawnedProcess>();

export function getSpawnedProcesses(): Map<string, SpawnedProcess> {
  return spawnedProcesses;
}

export function addSpawnedProcess(name: string, proc: SpawnedProcess): void {
  spawnedProcesses.set(name, proc);
}

export function removeSpawnedProcess(name: string): SpawnedProcess | undefined {
  const proc = spawnedProcesses.get(name);
  spawnedProcesses.delete(name);
  return proc;
}
