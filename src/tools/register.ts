import type { Database } from 'bun:sqlite';
import { v4 as uuidv4 } from 'uuid';
import type { BrokerConfig } from '../config.js';
import type { Agent } from '../types.js';
import { setAgent, clearAgent, requireAgent } from '../state.js';
import { validateName, validateRole } from '../validators.js';
import { isOnline, updateHeartbeat, pruneStaleAgents } from '../presence.js';

interface RegisterParams {
  name: string;
  role?: string;
  metadata?: string;
}

export function handleRegister(
  db: Database,
  config: BrokerConfig,
  params: RegisterParams
): Record<string, unknown> {
  const nameErr = validateName(params.name);
  if (nameErr) return { error: 'validation_error', message: nameErr };

  const role = params.role || 'peer';
  const roleErr = validateRole(role);
  if (roleErr) return { error: 'validation_error', message: roleErr };

  // Check if name exists first (before pruning, so we can reconnect even stale agents)
  const existing = db.prepare('SELECT * FROM agents WHERE name = ?').get(params.name) as Agent | undefined;

  // Prune stale agents (skip this agent's row if we're about to reconnect it)
  if (!existing) {
    pruneStaleAgents(db, config.pruneAfterDays);
  }

  // Check agent limit
  const count = db.prepare('SELECT COUNT(*) as cnt FROM agents').get() as { cnt: number };
  if (count.cnt >= config.maxAgents) {
    return { error: 'limit_exceeded', message: `Max ${config.maxAgents} agents` };
  }

  if (existing) {
    if (isOnline(existing.last_heartbeat, config)) {
      let suffix = 2;
      while (db.prepare('SELECT 1 FROM agents WHERE name = ?').get(`${params.name}-${suffix}`)) suffix++;
      return { error: 'name_taken', suggestion: `${params.name}-${suffix}` };
    }
    // Reconnect offline agent — reset status to idle
    const now = Date.now();
    db.prepare('UPDATE agents SET role = ?, status = ?, last_heartbeat = ?, updated_at = ?, metadata = ? WHERE id = ?').run(
      role,
      'idle',
      now,
      now,
      params.metadata || existing.metadata,
      existing.id
    );
    setAgent({ id: existing.id, name: existing.name, role: role as 'supervisor' | 'worker' | 'peer' });
    return { agent_id: existing.id, name: existing.name, role };
  }

  // New registration
  const id = uuidv4();
  const now = Date.now();
  db.prepare(
    'INSERT INTO agents (id, name, role, metadata, last_heartbeat, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, params.name, role, params.metadata || null, now, now, now);

  setAgent({ id, name: params.name, role: role as 'supervisor' | 'worker' | 'peer' });
  return { agent_id: id, name: params.name, role };
}

interface HeartbeatParams {
  status?: string;
}

export function handleHeartbeat(
  db: Database,
  config: BrokerConfig,
  params: HeartbeatParams
): Record<string, unknown> {
  const agent = requireAgent();
  updateHeartbeat(db, agent.id);

  if (params.status) {
    const validStatuses = ['idle', 'busy', 'blocked'];
    if (!validStatuses.includes(params.status)) {
      return { error: 'validation_error', message: 'Status must be idle, busy, or blocked' };
    }
    db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(params.status, agent.id);
  }

  const online = db
    .prepare('SELECT COUNT(*) as cnt FROM agents WHERE last_heartbeat > ?')
    .get(Date.now() - config.heartbeatTtl) as { cnt: number };

  return { status: 'ok', peers_online: online.cnt };
}

export function handleUnregister(db: Database): Record<string, unknown> {
  const agent = requireAgent();
  db.prepare('UPDATE agents SET last_heartbeat = NULL WHERE id = ?').run(agent.id);
  clearAgent();
  return { status: 'ok' };
}
