import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type { BrokerConfig } from '../config.js';
import { requireAgent } from '../state.js';
import { validateChannel } from '../validators.js';
import { autoHeartbeat } from '../presence.js';

interface CreateChannelParams {
  name: string;
  purpose?: string;
}

export function handleCreateChannel(
  db: Database.Database,
  config: BrokerConfig,
  params: CreateChannelParams
): Record<string, unknown> {
  const agent = requireAgent();
  autoHeartbeat(db);
  const err = validateChannel(params.name);
  if (err) return { error: 'validation_error', message: err };
  const count = db.prepare('SELECT COUNT(*) as cnt FROM channels').get() as { cnt: number };
  if (count.cnt >= config.maxChannels) {
    return { error: 'limit_exceeded', message: `Max ${config.maxChannels} channels` };
  }
  const existing = db.prepare('SELECT id FROM channels WHERE name = ?').get(params.name);
  if (existing) return { error: 'channel_exists', channel: params.name };
  const id = uuidv4();
  db.prepare('INSERT INTO channels (id, name, purpose, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id, params.name, params.purpose || null, agent.id, Date.now()
  );
  return { channel_id: id, name: params.name };
}

interface ChannelParam { channel: string; }

export function handleJoinChannel(db: Database.Database, params: ChannelParam): Record<string, unknown> {
  const agent = requireAgent();
  autoHeartbeat(db);
  const ch = db.prepare('SELECT id FROM channels WHERE name = ?').get(params.channel) as { id: string } | undefined;
  if (!ch) return { error: 'channel_not_found', channel: params.channel };
  const exists = db.prepare('SELECT 1 FROM channel_members WHERE channel_id = ? AND agent_id = ?').get(ch.id, agent.id);
  if (exists) return { status: 'already_joined' };
  db.prepare('INSERT INTO channel_members (channel_id, agent_id, joined_at) VALUES (?, ?, ?)').run(ch.id, agent.id, Date.now());
  return { status: 'joined' };
}

export function handleLeaveChannel(db: Database.Database, params: ChannelParam): Record<string, unknown> {
  const agent = requireAgent();
  autoHeartbeat(db);
  const ch = db.prepare('SELECT id FROM channels WHERE name = ?').get(params.channel) as { id: string } | undefined;
  if (!ch) return { error: 'channel_not_found', channel: params.channel };
  db.prepare('DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?').run(ch.id, agent.id);
  return { status: 'left' };
}

export function handleListChannels(db: Database.Database): Record<string, unknown> {
  requireAgent();
  autoHeartbeat(db);
  const channels = db.prepare(
    `SELECT c.*, COUNT(cm.agent_id) as member_count
     FROM channels c
     LEFT JOIN channel_members cm ON c.id = cm.channel_id
     GROUP BY c.id
     ORDER BY c.name`
  ).all();
  return { channels };
}
