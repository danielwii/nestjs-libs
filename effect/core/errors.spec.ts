import {
  BusinessError,
  ClientError,
  DataError,
  ExternalError,
  ForbiddenError,
  NotFoundError,
  SystemError,
  UnauthorizedError,
  ValidationError,
} from './errors';

import { describe, expect, test } from 'bun:test';
import { Effect } from 'effect';

const run = <A>(effect: Effect.Effect<A, any, never>) => Effect.runPromise(effect);

// ==================== _tag correctness ====================

describe('error _tag', () => {
  const cases = [
    { Cls: ClientError, tag: 'ClientError', props: { message: 'bad request' } },
    { Cls: BusinessError, tag: 'BusinessError', props: { message: 'insufficient funds' } },
    { Cls: ExternalError, tag: 'ExternalError', props: { message: 'upstream down' } },
    { Cls: SystemError, tag: 'SystemError', props: { message: 'oom' } },
    { Cls: DataError, tag: 'DataError', props: { message: 'inconsistent' } },
    { Cls: NotFoundError, tag: 'NotFoundError', props: { message: 'not found' } },
    { Cls: UnauthorizedError, tag: 'UnauthorizedError', props: { message: 'no token' } },
    { Cls: ForbiddenError, tag: 'ForbiddenError', props: { message: 'no access' } },
    { Cls: ValidationError, tag: 'ValidationError', props: { message: 'invalid' } },
  ] as const;

  for (const { Cls, tag, props } of cases) {
    test(`${tag} has correct _tag`, () => {
      const err = new Cls(props as any);
      expect(err._tag).toBe(tag);
    });
  }
});

// ==================== Field access ====================

describe('error fields', () => {
  test('ClientError code field', () => {
    const err = new ClientError({ message: 'bad', code: 'INVALID_PARAM' });
    expect(err.message).toBe('bad');
    expect(err.code).toBe('INVALID_PARAM');
  });

  test('ExternalError service field', () => {
    const err = new ExternalError({ message: 'timeout', service: 'payment-api' });
    expect(err.service).toBe('payment-api');
  });

  test('NotFoundError entity and id fields', () => {
    const err = new NotFoundError({ message: 'missing', entity: 'User', id: '123' });
    expect(err.entity).toBe('User');
    expect(err.id).toBe('123');
  });

  test('DataError entity and id fields', () => {
    const err = new DataError({ message: 'corrupt', entity: 'Order', id: 'abc' });
    expect(err.entity).toBe('Order');
    expect(err.id).toBe('abc');
  });

  test('ValidationError errors array', () => {
    const err = new ValidationError({
      message: 'validation failed',
      errors: [{ field: 'email', message: 'invalid format' }],
    });
    expect(err.errors).toHaveLength(1);
    expect(err.errors?.[0]!.field).toBe('email');
  });
});

// ==================== Effect.fail + catchTag ====================

describe('Effect.fail + catchTag', () => {
  test('catches NotFoundError by tag', () =>
    run(
      Effect.fail(new NotFoundError({ message: 'user not found', entity: 'User' })).pipe(
        Effect.catchTag('NotFoundError', (e) => Effect.succeed(`caught: ${e.entity}`)),
      ),
    ).then((v) => expect(v).toBe('caught: User')));

  test('catches ClientError by tag', () =>
    run(
      Effect.fail(new ClientError({ message: 'bad input', code: 'E001' })).pipe(
        Effect.catchTag('ClientError', (e) => Effect.succeed(e.code)),
      ),
    ).then((v) => expect(v).toBe('E001')));

  test('unmatched tag propagates', () =>
    run(
      Effect.either(
        (
          Effect.fail(new BusinessError({ message: 'nope' })) as Effect.Effect<never, BusinessError | NotFoundError>
        ).pipe(Effect.catchTag('NotFoundError', () => Effect.succeed('wrong'))),
      ),
    ).then((r) => {
      expect(r._tag).toBe('Left');
    }));
});
