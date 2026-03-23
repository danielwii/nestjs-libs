import { Oops } from './oops';
import { OopsError } from './oops-error';

import { describe, expect, it } from 'bun:test';

import './oops-factories';

describe('Oops factory methods (422)', () => {
  it('Oops.Validation()', () => {
    const err = Oops.Validation('Invalid input', 'field X is missing');
    expect(err).toBeInstanceOf(Oops);
    expect(err.httpStatus).toBe(422);
    expect(err.userMessage).toBe('Invalid input');
    expect(err.internalDetails).toBe('field X is missing');
  });

  it('Oops.NotFound()', () => {
    const err = Oops.NotFound('User', 'u_123');
    expect(err).toBeInstanceOf(Oops);
    expect(err.httpStatus).toBe(422);
    expect(err.userMessage).toContain('User');
  });

  it('Oops.ExternalServiceExpected()', () => {
    const err = Oops.ExternalServiceExpected('PaymentGateway', 'timeout');
    expect(err).toBeInstanceOf(Oops);
    expect(err.provider).toBe('PaymentGateway');
  });
});

describe('Oops.Block factory methods (4xx)', () => {
  it('Block.Unauthorized()', () => {
    const err = Oops.Block.Unauthorized('bad token');
    expect(err).toBeInstanceOf(Oops.Block);
    expect(err.httpStatus).toBe(401);
  });

  it('Block.Forbidden()', () => {
    const err = Oops.Block.Forbidden('admin only');
    expect(err).toBeInstanceOf(Oops.Block);
    expect(err.httpStatus).toBe(403);
  });

  it('Block.NotFound()', () => {
    const err = Oops.Block.NotFound('User', 'u_123');
    expect(err).toBeInstanceOf(Oops.Block);
    expect(err.httpStatus).toBe(404);
  });

  it('Block.Conflict()', () => {
    const err = Oops.Block.Conflict('duplicate entry');
    expect(err).toBeInstanceOf(Oops.Block);
    expect(err.httpStatus).toBe(409);
  });
});

describe('Oops.Panic factory methods (500)', () => {
  it('Panic.Database()', () => {
    const err = Oops.Panic.Database('query timeout');
    expect(err).toBeInstanceOf(Oops.Panic);
    expect(err.httpStatus).toBe(500);
    expect(err.userMessage).toBe('系统繁忙，请稍后重试');
  });

  it('Panic.ExternalService()', () => {
    const err = Oops.Panic.ExternalService('Redis', 'connection refused');
    expect(err).toBeInstanceOf(Oops.Panic);
    expect(err.provider).toBe('Redis');
    expect(err.userMessage).toBe('服务暂时不可用，请稍后重试');
  });

  it('Panic.Config()', () => {
    const err = Oops.Panic.Config('missing API key');
    expect(err).toBeInstanceOf(Oops.Panic);
    expect(err.userMessage).toBe('服务配置异常，请联系管理员');
  });
});

describe('all factory results are OopsError', () => {
  it('instanceof OopsError should match all', () => {
    expect(Oops.Validation('x')).toBeInstanceOf(OopsError);
    expect(Oops.Block.Unauthorized()).toBeInstanceOf(OopsError);
    expect(Oops.Panic.Database('x')).toBeInstanceOf(OopsError);
  });
});
