import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb, registerAgent } from './helpers.js';
import {
  handleCreateChannel, handleJoinChannel, handleLeaveChannel, handleListChannels
} from '../src/tools/channels.js';
import { loadConfig } from '../src/config.js';
import { clearAgent, setAgent } from '../src/state.js';
import type Database from 'better-sqlite3';
import type { BrokerConfig } from '../src/config.js';

let db: Database.Database;
let config: BrokerConfig;

beforeEach(() => {
  db = createTestDb();
  config = loadConfig();
  clearAgent();
});

describe('channels', () => {
  it('creates a channel', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    const result = handleCreateChannel(db, config, { name: '#general' });
    expect(result.name).toBe('#general');
    expect(result.channel_id).toBeDefined();
  });

  it('rejects invalid channel name', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    const result = handleCreateChannel(db, config, { name: 'no-hash' });
    expect(result.error).toBe('validation_error');
  });

  it('rejects duplicate channel name', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    handleCreateChannel(db, config, { name: '#general' });
    const result = handleCreateChannel(db, config, { name: '#general' });
    expect(result.error).toBe('channel_exists');
  });

  it('joins and leaves a channel', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    handleCreateChannel(db, config, { name: '#general' });
    const joinResult = handleJoinChannel(db, { channel: '#general' });
    expect(joinResult.status).toBe('joined');
    const leaveResult = handleLeaveChannel(db, { channel: '#general' });
    expect(leaveResult.status).toBe('left');
  });

  it('lists channels with member counts', () => {
    const a = registerAgent(db, config, 'alice');
    setAgent(a);
    handleCreateChannel(db, config, { name: '#general', purpose: 'General chat' });
    handleJoinChannel(db, { channel: '#general' });
    const result = handleListChannels(db);
    expect(result.channels).toHaveLength(1);
    expect((result.channels as Array<{ name: string; member_count: number }>)[0].name).toBe('#general');
    expect((result.channels as Array<{ name: string; member_count: number }>)[0].member_count).toBe(1);
  });
});
