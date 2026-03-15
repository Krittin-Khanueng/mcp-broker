import { describe, it, expect, beforeEach } from 'bun:test';
import { createTestDb, registerAgent } from './helpers.js';
import { handleListPeers } from '../src/tools/peers.js';
import { loadConfig } from '../src/config.js';
import { clearAgent } from '../src/state.js';
import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../src/config.js';

let db: Database;
let config: BrokerConfig;

beforeEach(() => {
  db = createTestDb();
  config = loadConfig();
  clearAgent();
});

describe('list_peers', () => {
  it('lists all agents with online status', () => {
    registerAgent(db, config, 'alice', 'supervisor');
    registerAgent(db, config, 'bob', 'worker');
    clearAgent();
    const result = handleListPeers(db, config, {});
    expect(result.peers).toHaveLength(2);
    expect((result.peers as Array<{ status_online: boolean }>)[0].status_online).toBe(true);
  });

  it('filters by role', () => {
    registerAgent(db, config, 'alice', 'supervisor');
    registerAgent(db, config, 'bob', 'worker');
    clearAgent();
    const result = handleListPeers(db, config, { role: 'supervisor' });
    expect(result.peers).toHaveLength(1);
    expect((result.peers as Array<{ name: string }>)[0].name).toBe('alice');
  });

  it('shows offline agents', () => {
    const a = registerAgent(db, config, 'alice');
    clearAgent();
    db.prepare('UPDATE agents SET last_heartbeat = ? WHERE id = ?').run(0, a.id);
    const result = handleListPeers(db, config, {});
    expect((result.peers as Array<{ status_online: boolean }>)[0].status_online).toBe(false);
  });
});
