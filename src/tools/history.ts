import type Database from 'better-sqlite3';
import type { BrokerConfig } from '../config.js';
import { requireAgent } from '../state.js';
import { autoHeartbeat } from '../presence.js';

interface GetHistoryParams {
  peer?: string;
  channel?: string;
  limit?: number;
  before_seq?: number;
}

export function handleGetHistory(
  db: Database.Database,
  config: BrokerConfig,
  params: GetHistoryParams
): Record<string, unknown> {
  requireAgent();
  autoHeartbeat(db);
  const limit = params.limit || 50;
  const conditions: string[] = [];
  const queryParams: (string | number)[] = [];

  if (params.peer) {
    const peer = db.prepare('SELECT id FROM agents WHERE name = ?').get(params.peer) as { id: string } | undefined;
    if (!peer) return { error: 'agent_not_found', name: params.peer };
    conditions.push('(m.from_agent = ? OR m.to_agent = ?)');
    queryParams.push(peer.id, peer.id);
  }

  if (params.channel) {
    const ch = db.prepare('SELECT id FROM channels WHERE name = ?').get(params.channel) as { id: string } | undefined;
    if (!ch) return { error: 'channel_not_found', channel: params.channel };
    conditions.push('m.channel_id = ?');
    queryParams.push(ch.id);
  }

  if (params.before_seq) {
    conditions.push('m.seq < ?');
    queryParams.push(params.before_seq);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  queryParams.push(limit);

  const messages = db.prepare(
    `SELECT m.*, a.name as from_name FROM messages m
     LEFT JOIN agents a ON m.from_agent = a.id
     ${where}
     ORDER BY m.seq DESC LIMIT ?`
  ).all(...queryParams);

  messages.reverse();
  return { messages };
}

interface PurgeParams { before_date: string; }

export function handlePurgeHistory(db: Database.Database, params: PurgeParams): Record<string, unknown> {
  requireAgent();
  autoHeartbeat(db);
  const cutoff = new Date(params.before_date).getTime();
  if (isNaN(cutoff)) return { error: 'invalid_date', before_date: params.before_date };
  const result = db.prepare('DELETE FROM messages WHERE created_at < ?').run(cutoff);
  return { deleted_count: result.changes };
}
