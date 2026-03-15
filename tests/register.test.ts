import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from './helpers.js';
import { handleRegister, handleHeartbeat, handleUnregister } from '../src/tools/register.js';
import { loadConfig } from '../src/config.js';
import { getAgent, clearAgent } from '../src/state.js';
import type Database from 'better-sqlite3';
import type { BrokerConfig } from '../src/config.js';

let db: Database.Database;
let config: BrokerConfig;

beforeEach(() => {
  db = createTestDb();
  config = loadConfig();
  clearAgent();
});

describe('register', () => {
  it('registers a new agent', () => {
    const result = handleRegister(db, config, { name: 'worker-1', role: 'worker' });
    expect(result.name).toBe('worker-1');
    expect(result.role).toBe('worker');
    expect(result.agent_id).toBeDefined();
    expect(getAgent()?.name).toBe('worker-1');
  });

  it('defaults role to peer', () => {
    const result = handleRegister(db, config, { name: 'agent-1' });
    expect(result.role).toBe('peer');
  });

  it('reconnects offline agent with same name', () => {
    const first = handleRegister(db, config, { name: 'worker-1' });
    clearAgent();
    // Simulate offline by setting old heartbeat
    db.prepare('UPDATE agents SET last_heartbeat = ? WHERE id = ?').run(0, first.agent_id);
    const second = handleRegister(db, config, { name: 'worker-1' });
    expect(second.agent_id).toBe(first.agent_id);
  });

  it('rejects duplicate online name', () => {
    handleRegister(db, config, { name: 'worker-1' });
    clearAgent();
    const result = handleRegister(db, config, { name: 'worker-1' });
    expect(result.error).toBe('name_taken');
    expect(result.suggestion).toBe('worker-1-2');
  });

  it('rejects invalid name', () => {
    const result = handleRegister(db, config, { name: 'bad name!' });
    expect(result.error).toBe('validation_error');
  });
});

describe('heartbeat', () => {
  it('updates heartbeat and returns peers count', () => {
    handleRegister(db, config, { name: 'agent-1' });
    const result = handleHeartbeat(db, config, {});
    expect(result.status).toBe('ok');
    expect(result.peers_online).toBe(1);
  });

  it('updates agent status', () => {
    handleRegister(db, config, { name: 'agent-1' });
    handleHeartbeat(db, config, { status: 'busy' });
    const agent = db.prepare('SELECT status FROM agents WHERE name = ?').get('agent-1') as { status: string };
    expect(agent.status).toBe('busy');
  });
});

describe('unregister', () => {
  it('clears heartbeat and session state', () => {
    handleRegister(db, config, { name: 'agent-1' });
    const result = handleUnregister(db);
    expect(result.status).toBe('ok');
    expect(getAgent()).toBeNull();
  });
});
