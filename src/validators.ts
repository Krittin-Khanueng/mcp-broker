const NAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
const CHANNEL_RE = /^#[a-zA-Z0-9_-]{1,31}$/;

export function validateName(name: string): string | null {
  if (!NAME_RE.test(name)) {
    return 'Name must be 1-32 chars, [a-zA-Z0-9_-] only';
  }
  return null;
}

export function validateChannel(name: string): string | null {
  if (!CHANNEL_RE.test(name)) {
    return 'Channel must start with # and be 2-32 chars, [a-zA-Z0-9_-] only';
  }
  return null;
}

export function validateRole(role: string): string | null {
  if (!['supervisor', 'worker', 'peer'].includes(role)) {
    return 'Role must be supervisor, worker, or peer';
  }
  return null;
}

export function validateContent(content: string, maxLength: number): string | null {
  if (!content || content.length === 0) {
    return 'Content cannot be empty';
  }
  if (content.length > maxLength) {
    return `Content exceeds max length of ${maxLength}`;
  }
  return null;
}
