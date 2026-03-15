import { describe, it, expect, beforeEach } from 'bun:test';
import { BrokerError } from '../src/errors.js';
import { createTestDb } from './helpers.js';
import { handleRegister, handleHeartbeat, handleUnregister } from '../src/tools/register.js';
import { loadConfig } from '../src/config.js';
import { getAgent, clearAgent } from '../src/state.js';
import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../src/config.js';

let db: Database;
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
    expect(() => handleRegister(db, config, { name: 'worker-1' })).toThrow(BrokerError);
    try {
      handleRegister(db, config, { name: 'worker-1' });
    } catch (e) {
      expect((e as BrokerError).code).toBe('name_taken');
      expect((e as BrokerError).message).toBe('worker-1-2');
    }
  });

  it('rejects invalid name', () => {
    expect(() => handleRegister(db, config, { name: 'bad name!' })).toThrow(BrokerError);
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

  it('rejects invalid heartbeat status', () => {
    handleRegister(db, config, { name: 'agent-1' });
    expect(() => handleHeartbeat(db, config, { status: 'dancing' })).toThrow(BrokerError);
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
