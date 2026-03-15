import { readFileSync, existsSync } from 'fs';
import { parse } from 'yaml';
import { z } from 'zod';
import { BrokerError } from './errors.js';
import { validateName } from './validators.js';
import type { Profile } from './types.js';

const ProfileSchema = z.object({
  system_prompt: z.string().min(1).max(10000),
  model: z.enum(['opus', 'sonnet', 'haiku']),
  max_budget_usd: z.number().positive().optional(),
  auto_register: z.boolean().default(true),
  allowed_tools: z.array(z.string()).optional(),
  additional_instructions: z.string().optional(),
  role: z.enum(['peer', 'worker', 'supervisor']).default('worker'),
  working_directory: z.string().optional(),
  permission_mode: z.enum(['default', 'auto', 'bypassPermissions']).default('auto'),
});

const ProfilesFileSchema = z.object({
  profiles: z.record(z.string(), z.unknown()).default({}),
});

export function loadProfiles(filePath: string): Map<string, Profile> {
  if (!existsSync(filePath)) {
    throw new BrokerError('config_not_found', `config_not_found: profiles.yml not found at ${filePath}`);
  }

  let raw: unknown;
  try {
    const content = readFileSync(filePath, 'utf-8');
    raw = parse(content);
  } catch (e) {
    if (e instanceof BrokerError) throw e;
    throw new BrokerError('invalid_config', `invalid_config: profiles.yml parse error: ${(e as Error).message}`);
  }

  const fileResult = ProfilesFileSchema.safeParse(raw);
  if (!fileResult.success) {
    throw new BrokerError('invalid_config', `invalid_config: profiles.yml structure error: ${fileResult.error.message}`);
  }

  const profiles = new Map<string, Profile>();

  for (const [key, value] of Object.entries(fileResult.data.profiles)) {
    const nameErr = validateName(key);
    if (nameErr) {
      throw new BrokerError('invalid_profile', `invalid_profile: Profile name "${key}": ${nameErr}`);
    }

    const result = ProfileSchema.safeParse(value);
    if (!result.success) {
      throw new BrokerError('invalid_profile', `invalid_profile: Profile "${key}": ${result.error.message}`);
    }

    profiles.set(key, result.data as Profile);
  }

  return profiles;
}
