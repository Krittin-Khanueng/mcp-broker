import { describe, it, expect } from 'bun:test';
import { tmpdir } from 'os';
import { join } from 'path';
import { unlinkSync } from 'fs';
import { createTestDb } from './helpers.js';
import { initDb } from '../src/db.js';

describe('Database', () => {
  it('creates all tables on init', () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name).filter((n) => !n.startsWith('sqlite_'));
    expect(names).toEqual([
      'agents',
      'channel_members',
      'channels',
      'messages',
      'read_cursors',
    ]);
  });

  it('enables WAL mode on file-based DB', () => {
    const tmpPath = join(tmpdir(), `broker-test-${Date.now()}.db`);
    const db = initDb(tmpPath);
    const result = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(result.journal_mode).toBe('wal');
    db.close();
    try { unlinkSync(tmpPath); unlinkSync(tmpPath + '-wal'); unlinkSync(tmpPath + '-shm'); } catch {}
  });

  it('enables foreign keys', () => {
    const db = createTestDb();
    const result = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(result.foreign_keys).toBe(1);
  });
});
