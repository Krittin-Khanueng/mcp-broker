import type { Database } from 'bun:sqlite';
import { v4 as uuidv4 } from 'uuid';
import type { BrokerConfig } from '../config.js';
import type { Message } from '../types.js';
import { requireAgent } from '../state.js';
import { validateContent } from '../validators.js';
import { autoHeartbeat } from '../presence.js';

interface SendParams {
  to: string;
  content: string;
  channel?: string;
}

export function handleSendMessage(
  db: Database,
  config: BrokerConfig,
  params: SendParams
): Record<string, unknown> {
  const agent = requireAgent();
  autoHeartbeat(db);

  const contentErr = validateContent(params.content, config.maxMessageLength);
  if (contentErr) return { error: 'validation_error', message: contentErr };

  const { to, content } = params;
  const now = Date.now();
  const insertMsg = db.prepare(
    'INSERT INTO messages (id, from_agent, to_agent, channel_id, message_type, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  // Channel message
  if (to.startsWith('channel:') || params.channel) {
    const channelName = params.channel ?? to.replace('channel:', '');
    const ch = db.prepare('SELECT id FROM channels WHERE name = ?').get(channelName) as { id: string } | undefined;
    if (!ch) return { error: 'channel_not_found', channel: channelName };
    const msgId = uuidv4();
    insertMsg.run(msgId, agent.id, null, ch.id, 'channel', content, now);
    return { message_id: msgId, delivered_to: 1 };
  }

  // Broadcast
  if (to === 'all') {
    const others = db
      .prepare('SELECT id FROM agents WHERE id != ? AND last_heartbeat > ?')
      .all(agent.id, now - config.heartbeatTtl) as { id: string }[];

    db.transaction(() => {
      for (const recipient of others) {
        insertMsg.run(uuidv4(), agent.id, recipient.id, null, 'broadcast', content, now);
      }
    })();
    return { message_id: 'broadcast', delivered_to: others.length };
  }

  // Role-targeted
  if (to.startsWith('role:')) {
    const role = to.replace('role:', '');
    const targets = db
      .prepare('SELECT id FROM agents WHERE role = ? AND id != ? AND last_heartbeat > ?')
      .all(role, agent.id, now - config.heartbeatTtl) as { id: string }[];

    if (targets.length === 0) return { error: 'no_agents_with_role', role };

    db.transaction(() => {
      for (const target of targets) {
        insertMsg.run(uuidv4(), agent.id, target.id, null, 'dm', content, now);
      }
    })();
    return { message_id: 'role_targeted', delivered_to: targets.length };
  }

  // Direct message by name
  const recipient = db.prepare('SELECT id FROM agents WHERE name = ?').get(to) as { id: string } | undefined;
  if (!recipient) return { error: 'agent_not_found', name: to };

  const msgId = uuidv4();
  insertMsg.run(msgId, agent.id, recipient.id, null, 'dm', content, now);
  return { message_id: msgId, delivered_to: 1 };
}

interface PollParams {
  channel?: string;
  limit?: number;
}

type MessageRow = Message & { from_name: string | null };

export function handlePollMessages(
  db: Database,
  config: BrokerConfig,
  params: PollParams
): Record<string, unknown> {
  const agent = requireAgent();
  autoHeartbeat(db);

  const limit = params.limit ?? 20;

  if (params.channel) {
    const ch = db.prepare('SELECT id FROM channels WHERE name = ?').get(params.channel) as { id: string } | undefined;
    if (!ch) return { error: 'channel_not_found', channel: params.channel };

    const source = `channel:${ch.id}`;
    const cursor = db
      .prepare('SELECT last_read_seq FROM read_cursors WHERE agent_id = ? AND source = ?')
      .get(agent.id, source) as { last_read_seq: number } | undefined;
    const lastSeq = cursor?.last_read_seq ?? 0;

    const messages = db
      .prepare(
        `SELECT m.*, a.name as from_name FROM messages m
         LEFT JOIN agents a ON m.from_agent = a.id
         WHERE m.channel_id = ? AND m.seq > ?
         ORDER BY m.seq ASC LIMIT ?`
      )
      .all(ch.id, lastSeq, limit) as MessageRow[];

    if (messages.length > 0) {
      const maxSeq = messages[messages.length - 1].seq;
      db.prepare(
        'INSERT OR REPLACE INTO read_cursors (agent_id, source, last_read_seq) VALUES (?, ?, ?)'
      ).run(agent.id, source, maxSeq);
    }

    return { messages, unread_count: messages.length };
  }

  // Unified inbox: DMs + broadcasts + all joined channels
  const getCursor = (source: string): number => {
    const row = db
      .prepare('SELECT last_read_seq FROM read_cursors WHERE agent_id = ? AND source = ?')
      .get(agent.id, source) as { last_read_seq: number } | undefined;
    return row?.last_read_seq ?? 0;
  };

  const dmSeq = getCursor('dm');
  const broadcastSeq = getCursor('broadcast');

  const directMessages = db
    .prepare(
      `SELECT m.*, a.name as from_name FROM messages m
       LEFT JOIN agents a ON m.from_agent = a.id
       WHERE m.to_agent = ? AND m.message_type = 'dm' AND m.seq > ?
       ORDER BY m.seq ASC LIMIT ?`
    )
    .all(agent.id, dmSeq, limit) as MessageRow[];

  const broadcasts = db
    .prepare(
      `SELECT m.*, a.name as from_name FROM messages m
       LEFT JOIN agents a ON m.from_agent = a.id
       WHERE m.to_agent = ? AND m.message_type = 'broadcast' AND m.seq > ?
       ORDER BY m.seq ASC LIMIT ?`
    )
    .all(agent.id, broadcastSeq, limit) as MessageRow[];

  const joinedChannels = db
    .prepare('SELECT channel_id FROM channel_members WHERE agent_id = ?')
    .all(agent.id) as { channel_id: string }[];

  let channelMessages: MessageRow[] = [];
  for (const { channel_id } of joinedChannels) {
    const chSeq = getCursor(`channel:${channel_id}`);
    const msgs = db
      .prepare(
        `SELECT m.*, a.name as from_name FROM messages m
         LEFT JOIN agents a ON m.from_agent = a.id
         WHERE m.channel_id = ? AND m.seq > ?
         ORDER BY m.seq ASC LIMIT ?`
      )
      .all(channel_id, chSeq, limit) as MessageRow[];
    channelMessages = channelMessages.concat(msgs);
  }

  const limited = [...directMessages, ...broadcasts, ...channelMessages]
    .sort((a, b) => a.seq - b.seq)
    .slice(0, limit);

  const updateCursor = db.prepare(
    'INSERT OR REPLACE INTO read_cursors (agent_id, source, last_read_seq) VALUES (?, ?, ?)'
  );

  db.transaction(() => {
    const returnedDMs = limited.filter((m) => m.message_type === 'dm');
    if (returnedDMs.length > 0) {
      updateCursor.run(agent.id, 'dm', returnedDMs[returnedDMs.length - 1].seq);
    }
    const returnedBroadcasts = limited.filter((m) => m.message_type === 'broadcast');
    if (returnedBroadcasts.length > 0) {
      updateCursor.run(agent.id, 'broadcast', returnedBroadcasts[returnedBroadcasts.length - 1].seq);
    }
    for (const { channel_id } of joinedChannels) {
      const chMsgs = limited.filter((m) => m.channel_id === channel_id);
      if (chMsgs.length > 0) {
        updateCursor.run(agent.id, `channel:${channel_id}`, chMsgs[chMsgs.length - 1].seq);
      }
    }
  })();

  return { messages: limited, unread_count: limited.length };
}
