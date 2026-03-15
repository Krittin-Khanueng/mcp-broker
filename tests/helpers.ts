import { Database } from 'bun:sqlite';
import { initDb } from '../src/db.js';
import { handleRegister } from '../src/tools/register.js';
import { clearAgent } from '../src/state.js';
import type { BrokerConfig } from '../src/config.js';
import type { SessionAgent } from '../src/types.js';

export function createTestDb(): Database {
  return initDb(':memory:');
}

export function registerAgent(
  db: Database,
  config: BrokerConfig,
  name: string,
  role: string = 'peer'
): SessionAgent {
  clearAgent();
  const result = handleRegister(db, config, { name, role });
  return { id: result.agent_id as string, name, role: role as SessionAgent['role'] };
}
