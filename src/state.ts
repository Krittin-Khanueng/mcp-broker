import type { SessionAgent } from './types.js';

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
    throw new Error('not_registered');
  }
  return currentAgent;
}
