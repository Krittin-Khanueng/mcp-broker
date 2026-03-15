export type AgentRole = 'supervisor' | 'worker' | 'peer';
export type AgentStatus = 'idle' | 'busy' | 'blocked';
export type MessageType = 'dm' | 'channel' | 'broadcast';

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  status: AgentStatus;
  metadata: string | null;
  last_heartbeat: number | null;
  created_at: number;
  updated_at: number;
}

export interface Channel {
  id: string;
  name: string;
  purpose: string | null;
  created_by: string | null;
  created_at: number;
}

export interface Message {
  seq: number;
  id: string;
  from_agent: string | null;
  to_agent: string | null;
  channel_id: string | null;
  message_type: MessageType;
  content: string;
  created_at: number;
}

export interface SessionAgent {
  id: string;
  name: string;
  role: AgentRole;
}
