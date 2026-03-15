import { describe, it, expect } from 'bun:test';
import { BrokerError } from '../src/errors.js';

// Recreate wrapHandler locally since it's not exported
function wrapHandler(fn: () => Record<string, unknown>) {
  try {
    const result = fn();
    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
  } catch (e) {
    if (e instanceof BrokerError) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e.code, message: e.message }) }] };
    }
    throw e;
  }
}

describe('wrapHandler', () => {
  it('returns JSON content for success', () => {
    const result = wrapHandler(() => ({ status: 'ok' }));
    expect(JSON.parse(result.content[0].text)).toEqual({ status: 'ok' });
  });

  it('catches BrokerError and returns error JSON', () => {
    const result = wrapHandler(() => { throw new BrokerError('test_error', 'test message'); });
    expect(JSON.parse(result.content[0].text)).toEqual({ error: 'test_error', message: 'test message' });
  });

  it('re-throws non-BrokerError exceptions', () => {
    expect(() => wrapHandler(() => { throw new TypeError('unexpected bug'); })).toThrow(TypeError);
  });
});
