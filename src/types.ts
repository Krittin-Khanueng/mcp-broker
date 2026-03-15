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

export type PermissionMode = 'default' | 'auto' | 'bypassPermissions';

export interface Profile {
  system_prompt: string;
  model: 'opus' | 'sonnet' | 'haiku';
  max_budget_usd?: number;
  auto_register: boolean;
  allowed_tools?: string[];
  additional_instructions?: string;
  role: AgentRole;
  working_directory?: string;
  permission_mode: PermissionMode;
}

export interface SpawnedAgent {
  profile: string;
  startedAt: Date;
  abortController: AbortController;
  completionPromise: Promise<AgentResult>;
  running: boolean;
}

export interface AgentResult {
  subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  totalCostUsd?: number;
  durationMs?: number;
  numTurns?: number;
}

export const MODEL_MAP: Record<Profile['model'], string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
};
