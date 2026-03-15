import { describe, it, expect, beforeEach } from 'bun:test';
import { BrokerError } from '../src/errors.js';
import { createTestDb, registerAgent } from './helpers.js';
import { handleSendMessage, handlePollMessages } from '../src/tools/messaging.js';
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

describe('send_message', () => {
  it('sends DM by agent name', () => {
    const a = registerAgent(db, config, 'alice');
    const b = registerAgent(db, config, 'bob');
    setAgent(a);
    const result = handleSendMessage(db, config, { to: 'bob', content: 'hello bob' });
    expect(result.message_id).toBeDefined();
    expect(result.delivered_to).toBe(1);
  });

  it('sends broadcast to all online agents', () => {
    const a = registerAgent(db, config, 'alice');
    registerAgent(db, config, 'bob');
    registerAgent(db, config, 'charlie');
    setAgent(a);
    const result = handleSendMessage(db, config, { to: 'all', content: 'hello everyone' });
    expect(result.delivered_to).toBe(2); // bob + charlie (not self)
  });

  it('sends to role', () => {
    const a = registerAgent(db, config, 'alice');
    registerAgent(db, config, 'bob', 'supervisor');
    registerAgent(db, config, 'charlie', 'supervisor');
    setAgent(a);
    const result = handleSendMessage(db, config, { to: 'role:supervisor', content: 'hey supervisors' });
    expect(result.delivered_to).toBe(2);
  });

  it('sends channel message', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    db.prepare('INSERT INTO channels (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
      'ch1', '#general', a.id, Date.now()
    );
    db.prepare('INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)').run(
      'ch1', a.id, Date.now()
    );
    const result = handleSendMessage(db, config, { to: 'channel:#general', content: 'in channel' });
    expect(result.message_id).toBeDefined();
  });

  it('rejects message to unknown agent', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleSendMessage(db, config, { to: 'nobody', content: 'hello' })).toThrow(BrokerError);
  });

  it('rejects empty content', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handleSendMessage(db, config, { to: 'all', content: '' })).toThrow(BrokerError);
  });
});

describe('poll_messages', () => {
  it('returns unread DMs', () => {
    const a = registerAgent(db, config, 'alice');
    const b = registerAgent(db, config, 'bob');
    setAgent(a);
    handleSendMessage(db, config, { to: 'bob', content: 'msg1' });
    handleSendMessage(db, config, { to: 'bob', content: 'msg2' });
    setAgent(b);
    const result = handlePollMessages(db, config, {});
    expect(result.messages).toHaveLength(2);
    expect((result.messages as Array<{ content: string }>)[0].content).toBe('msg1');
  });

  it('does not return already-read messages', () => {
    const a = registerAgent(db, config, 'alice');
    const b = registerAgent(db, config, 'bob');
    setAgent(a);
    handleSendMessage(db, config, { to: 'bob', content: 'msg1' });
    setAgent(b);
    handlePollMessages(db, config, {}); // read msg1
    setAgent(a);
    handleSendMessage(db, config, { to: 'bob', content: 'msg2' });
    setAgent(b);
    const result = handlePollMessages(db, config, {});
    expect(result.messages).toHaveLength(1);
    expect((result.messages as Array<{ content: string }>)[0].content).toBe('msg2');
  });

  it('rejects polling non-existent channel', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    expect(() => handlePollMessages(db, config, { channel: '#nonexistent' })).toThrow(BrokerError);
  });

  it('returns channel messages for joined channels', () => {
    const a = registerAgent(db, config, 'alice');
    const b = registerAgent(db, config, 'bob');
    db.prepare('INSERT INTO channels (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
      'ch1', '#general', a.id, Date.now()
    );
    db.prepare('INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)').run('ch1', a.id, Date.now());
    db.prepare('INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)').run('ch1', b.id, Date.now());
    setAgent(a);
    handleSendMessage(db, config, { to: 'channel:#general', content: 'hello channel' });
    setAgent(b);
    const result = handlePollMessages(db, config, { channel: '#general' });
    expect(result.messages).toHaveLength(1);
    expect((result.messages as Array<{ content: string }>)[0].content).toBe('hello channel');
  });

  it('returns unified inbox across DMs, broadcasts, and multiple channels', () => {
    const a = registerAgent(db, config, 'alice');
    const b = registerAgent(db, config, 'bob');

    // Create 3 channels and join both agents to all
    for (const ch of ['#ch1', '#ch2', '#ch3']) {
      const chId = ch.replace('#', '');
      db.prepare('INSERT INTO channels (id, name, created_by, created_at) VALUES (?, ?, ?, ?)').run(
        chId, ch, a.id, Date.now()
      );
      db.prepare('INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)').run(chId, a.id, Date.now());
      db.prepare('INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)').run(chId, b.id, Date.now());
    }

    // Alice sends: 1 DM to bob, 1 broadcast, 1 msg per channel = 5 messages
    setAgent(a);
    handleSendMessage(db, config, { to: 'bob', content: 'dm-msg' });
    handleSendMessage(db, config, { to: 'all', content: 'broadcast-msg' });
    handleSendMessage(db, config, { to: 'channel:#ch1', content: 'ch1-msg' });
    handleSendMessage(db, config, { to: 'channel:#ch2', content: 'ch2-msg' });
    handleSendMessage(db, config, { to: 'channel:#ch3', content: 'ch3-msg' });

    // Bob polls unified inbox
    setAgent(b);
    const result = handlePollMessages(db, config, {});
    const msgs = result.messages as Array<{ content: string; message_type: string }>;
    expect(msgs).toHaveLength(5);
    expect(msgs.map(m => m.content).sort()).toEqual([
      'broadcast-msg', 'ch1-msg', 'ch2-msg', 'ch3-msg', 'dm-msg'
    ]);

    // Second poll should return empty (cursors updated)
    const result2 = handlePollMessages(db, config, {});
    expect(result2.messages).toHaveLength(0);
  });
});
