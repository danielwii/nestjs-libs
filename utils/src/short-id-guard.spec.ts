import { createShortIdGuard } from './short-id';

import { describe, expect, it } from 'bun:test';

type TaskShortId = string & { readonly taskShortId: unique symbol };

describe('createShortIdGuard', () => {
  it('validates and preserves a stable short ID through is/of', () => {
    const guard = createShortIdGuard<TaskShortId>('tsk');
    expect(guard.is('tsk_3k9f2a')).toBe(true);
    expect(String(guard.of('tsk_3k9f2a'))).toBe('tsk_3k9f2a');
    for (const value of ['usr_3k9f2a', 'tsk_3K9f2a', 'tsk_abc123\n', 'tsk_cuid12345678901234567890', null, 42]) {
      expect(guard.is(value)).toBe(false);
      expect(() => guard.of(value)).toThrow('registered prefix "tsk"');
    }
  });
});
