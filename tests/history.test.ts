import { describe, it, expect, beforeEach } from 'bun:test';
import { BrokerError } from '../src/errors.js';
import { createTestDb, registerAgent } from './helpers.js';
import { handleGetHistory, handlePurgeHistory } from '../src/tools/history.js';
import { handleSendMessage } from '../src/tools/messaging.js';
import { loadConfig } from '../src/config.js';
import { clearAgent, setAgent } from '../src/state.js';
import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../src/config.js';

let db: Database;
let config: BrokerConfig;

beforeEach(() => {
  db = createTestDb();
  config = loadConfig();
  clearAgent();
});

describe('get_history', () => {
  it('returns message history', () => {
    const a = registerAgent(db, config, 'alice');
    const b = registerAgent(db, config, 'bob');
    setAgent(a);
    handleSendMessage(db, config, { to: 'bob', content: 'hello' });
    handleSendMessage(db, config, { to: 'bob', content: 'world' });
    const result = handleGetHistory(db, config, {});
    expect(result.messages).toHaveLength(2);
  });

  it('filters by peer', () => {
    const a = registerAgent(db, config, 'alice');
    registerAgent(db, config, 'bob');
    registerAgent(db, config, 'charlie');
    setAgent(a);
    handleSendMessage(db, config, { to: 'bob', content: 'to bob' });
    handleSendMessage(db, config, { to: 'charlie', content: 'to charlie' });
    const result = handleGetHistory(db, config, { peer: 'bob' });
    expect(result.messages).toHaveLength(1);
    expect((result.messages as Array<{ content: string }>)[0].content).toBe('to bob');
  });

  it('respects limit', () => {
    const a = registerAgent(db, config, 'alice');
    registerAgent(db, config, 'bob');
    setAgent(a);
    for (let i = 0; i < 10; i++) {
      handleSendMessage(db, config, { to: 'bob', content: `msg${i}` });
    }
    const result = handleGetHistory(db, config, { limit: 3 });
    expect(result.messages).toHaveLength(3);
  });

  it('rejects unknown peer in history', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleGetHistory(db, config, { peer: 'ghost' })).toThrow(BrokerError);
  });

  it('rejects unknown channel in history', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleGetHistory(db, config, { channel: '#ghost' })).toThrow(BrokerError);
  });
});

describe('purge_history', () => {
  it('deletes messages before date', () => {
    const a = registerAgent(db, config, 'alice');
    registerAgent(db, config, 'bob');
    setAgent(a);
    handleSendMessage(db, config, { to: 'bob', content: 'old message' });
    db.prepare('UPDATE messages SET created_at = ? WHERE content = ?').run(
      new Date('2020-01-01').getTime(), 'old message'
    );
    const result = handlePurgeHistory(db, { before_date: '2025-01-01' });
    expect(result.deleted_count).toBe(1);
  });

  it('rejects invalid purge date', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handlePurgeHistory(db, { before_date: 'not-a-date' })).toThrow(BrokerError);
  });
});
