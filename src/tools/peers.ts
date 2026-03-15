import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from '../config.js';
import type { Agent } from '../types.js';
import { isOnline } from '../presence.js';

interface ListPeersParams { role?: string; }

export function handleListPeers(
  db: Database,
  config: BrokerConfig,
  params: ListPeersParams
): Record<string, unknown> {
  let query = 'SELECT * FROM agents';
  const queryParams: string[] = [];
  if (params.role) {
    query += ' WHERE role = ?';
    queryParams.push(params.role);
  }
  query += ' ORDER BY name';
  const agents = db.prepare(query).all(...queryParams) as Agent[];
  const peers = agents.map((a) => ({
    name: a.name,
    role: a.role,
    status: a.status,
    status_online: isOnline(a.last_heartbeat, config),
    last_seen: a.last_heartbeat,
    metadata: a.metadata ? (() => { try { return JSON.parse(a.metadata as string); } catch { return a.metadata; } })() : null,
  }));
  return { peers };
}
