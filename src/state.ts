import type { SessionAgent } from './types.js';
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
