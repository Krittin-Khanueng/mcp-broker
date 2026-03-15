import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { initDb } from './db.js';
import { handleRegister, handleHeartbeat, handleUnregister } from './tools/register.js';
import { handleSendMessage, handlePollMessages } from './tools/messaging.js';
import {
  handleCreateChannel,
  handleJoinChannel,
  handleLeaveChannel,
  handleListChannels,
} from './tools/channels.js';
import { handleListPeers } from './tools/peers.js';
import { handleGetHistory, handlePurgeHistory } from './tools/history.js';

const config = loadConfig();
const db = initDb(config.dbPath);

const server = new McpServer({
  name: 'mcp-broker',
  version: '0.1.0',
});

// Helper: wrap handler with try/catch for not_registered errors
function wrapHandler(fn: () => Record<string, unknown>) {
  try {
    const result = fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (e) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'not_registered' }) }] };
  }
}

// --- Registration & Presence ---

server.registerTool(
  'register',
  {
    title: 'Register',
    description: 'Register this agent with the broker',
    inputSchema: {
      name: z.string().describe('Agent name (1-32 chars, [a-zA-Z0-9_-])'),
      role: z.enum(['supervisor', 'worker', 'peer']).optional().describe('Agent role (default: peer)'),
      metadata: z.string().optional().describe('JSON metadata'),
    },
  },
  async ({ name, role, metadata }) => {
    const result = handleRegister(db, config, { name, role, metadata });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  'heartbeat',
  {
    title: 'Heartbeat',
    description: 'Update presence heartbeat',
    inputSchema: {
      status: z.enum(['idle', 'busy', 'blocked']).optional().describe('Self-reported status'),
    },
  },
  async ({ status }) => wrapHandler(() => handleHeartbeat(db, config, { status })),
);

server.registerTool(
  'unregister',
  {
    title: 'Unregister',
    description: 'Unregister this agent from the broker',
    inputSchema: {},
  },
  async () => wrapHandler(() => handleUnregister(db)),
);

// --- Messaging ---

server.registerTool(
  'send_message',
  {
    title: 'Send Message',
    description: 'Send a message to an agent, role, channel, or broadcast',
    inputSchema: {
      to: z.string().describe('Recipient: agent name, "all", "role:<role>", or "channel:#name"'),
      content: z.string().describe('Message content'),
      channel: z.string().optional().describe('Channel name (alternative to channel: prefix in "to")'),
    },
  },
  async ({ to, content, channel }) => wrapHandler(() => handleSendMessage(db, config, { to, content, channel })),
);

server.registerTool(
  'poll_messages',
  {
    title: 'Poll Messages',
    description: 'Fetch unread messages (unified inbox or specific channel)',
    inputSchema: {
      channel: z.string().optional().describe('Channel name to filter (omit for unified inbox)'),
      limit: z.number().optional().describe('Max messages to return (default: 20)'),
    },
  },
  async ({ channel, limit }) => wrapHandler(() => handlePollMessages(db, config, { channel, limit })),
);

// --- Channels ---

server.registerTool(
  'create_channel',
  {
    title: 'Create Channel',
    description: 'Create a new channel',
    inputSchema: {
      name: z.string().describe('Channel name (must start with #, 2-32 chars)'),
      purpose: z.string().optional().describe('Channel purpose'),
    },
  },
  async ({ name, purpose }) => wrapHandler(() => handleCreateChannel(db, config, { name, purpose })),
);

server.registerTool(
  'join_channel',
  {
    title: 'Join Channel',
    description: 'Join an existing channel',
    inputSchema: {
      channel: z.string().describe('Channel name'),
    },
  },
  async ({ channel }) => wrapHandler(() => handleJoinChannel(db, { channel })),
);

server.registerTool(
  'leave_channel',
  {
    title: 'Leave Channel',
    description: 'Leave a channel',
    inputSchema: {
      channel: z.string().describe('Channel name'),
    },
  },
  async ({ channel }) => wrapHandler(() => handleLeaveChannel(db, { channel })),
);

server.registerTool(
  'list_channels',
  {
    title: 'List Channels',
    description: 'List all channels',
    inputSchema: {},
  },
  async () => wrapHandler(() => handleListChannels(db)),
);

// --- Discovery & History ---

server.registerTool(
  'list_peers',
  {
    title: 'List Peers',
    description: 'List all registered agents with online status',
    inputSchema: {
      role: z.string().optional().describe('Filter by role'),
    },
  },
  async ({ role }) => {
    const result = handleListPeers(db, config, { role });
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  },
);

server.registerTool(
  'get_history',
  {
    title: 'Get History',
    description: 'Query message history',
    inputSchema: {
      peer: z.string().optional().describe('Filter by peer name'),
      channel: z.string().optional().describe('Filter by channel name'),
      limit: z.number().optional().describe('Max messages (default: 50)'),
      before_seq: z.number().optional().describe('Return messages before this sequence number'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ peer, channel, limit, before_seq }) =>
    wrapHandler(() => handleGetHistory(db, config, { peer, channel, limit, before_seq })),
);

server.registerTool(
  'purge_history',
  {
    title: 'Purge History',
    description: 'Delete messages older than a date',
    inputSchema: {
      before_date: z.string().describe('ISO 8601 date (e.g., "2025-01-01")'),
    },
    annotations: { destructiveHint: true },
  },
  async ({ before_date }) => wrapHandler(() => handlePurgeHistory(db, { before_date })),
);

// --- Start server ---

const transport = new StdioServerTransport();
await server.connect(transport);
