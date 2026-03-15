import type { Database } from 'bun:sqlite';
import type { BrokerConfig } from './config.js';
import { getAgent } from './state.js';

export function updateHeartbeat(db: Database, agentId: string): void {
  db.prepare('UPDATE agents SET last_heartbeat = ?, updated_at = ? WHERE id = ?').run(
    Date.now(),
    Date.now(),
    agentId
  );
}

export function isOnline(lastHeartbeat: number | null, config: BrokerConfig): boolean {
  if (lastHeartbeat === null) return false;
  return Date.now() - lastHeartbeat < config.heartbeatTtl;
}

export function autoHeartbeat(db: Database): void {
  const agent = getAgent();
  if (agent) {
    updateHeartbeat(db, agent.id);
  }
}

export function pruneStaleAgents(db: Database, pruneAfterDays: number): number {
  const cutoff = Date.now() - pruneAfterDays * 24 * 60 * 60 * 1000;
  db.prepare(
    `DELETE FROM agents WHERE
      (last_heartbeat IS NOT NULL AND last_heartbeat < ?) OR
      (last_heartbeat IS NULL AND updated_at < ?)`
  ).run(cutoff, cutoff);
  return (db.prepare('SELECT changes() as cnt').get() as { cnt: number }).cnt;
}
