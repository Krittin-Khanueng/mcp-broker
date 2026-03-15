import { homedir } from 'os';
import { join } from 'path';

export interface BrokerConfig {
  dbPath: string;
  heartbeatTtl: number;
  maxMessageLength: number;
  pruneAfterDays: number;
  maxAgents: number;
  maxChannels: number;
  profilesPath: string;
}

export function loadConfig(): BrokerConfig {
  const home = homedir();
  return {
    dbPath: process.env.BROKER_DB_PATH || join(home, '.claude', 'mcp-broker', 'broker.db'),
    heartbeatTtl: parseInt(process.env.BROKER_HEARTBEAT_TTL || '60000', 10),
    maxMessageLength: parseInt(process.env.BROKER_MAX_MESSAGE_LENGTH || '10000', 10),
    pruneAfterDays: parseInt(process.env.BROKER_PRUNE_AFTER_DAYS || '7', 10),
    maxAgents: parseInt(process.env.BROKER_MAX_AGENTS || '100', 10),
    maxChannels: parseInt(process.env.BROKER_MAX_CHANNELS || '50', 10),
    profilesPath: process.env.BROKER_PROFILES_PATH || join(home, '.claude', 'mcp-broker', 'profiles.yml'),
  };
}
