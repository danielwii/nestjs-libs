import 'reflect-metadata';

import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';

import { getTypeSafeApiKey } from './api-key';

import { afterEach, describe, expect, it } from 'bun:test';

import type { AbstractEnvironmentVariables } from '@app/env';

type CanonicalTypeSafeKey = AbstractEnvironmentVariables['AI_TYPESAFE_API_KEY'];
const _canonical: CanonicalTypeSafeKey = undefined;
void _canonical;

// @ts-expect-error official SDK env name is not a SysEnv field; pass AI_TYPESAFE_API_KEY into TypeSafeClient
type RemovedOfficialSdkKey = AbstractEnvironmentVariables['TYPESAFE_API_KEY'];
void null as unknown as RemovedOfficialSdkKey;

const sysEnvMut = SysEnv as unknown as Record<string, string | undefined>;
const originalKey = sysEnvMut.AI_TYPESAFE_API_KEY;

afterEach(() => {
  sysEnvMut.AI_TYPESAFE_API_KEY = originalKey;
});

describe('getTypeSafeApiKey', () => {
  it('returns the trimmed SysEnv value when configured', () => {
    sysEnvMut.AI_TYPESAFE_API_KEY = '  ts_live_test_key  ';
    expect(getTypeSafeApiKey()).toBe('ts_live_test_key');
  });

  it('throws Oops.Panic.Config when the key is missing or blank', () => {
    for (const value of [undefined, '', '   ']) {
      sysEnvMut.AI_TYPESAFE_API_KEY = value;
      try {
        getTypeSafeApiKey();
        expect.unreachable('expected Config panic');
      } catch (error) {
        expect(error).toBeInstanceOf(Oops.Panic);
        expect((error as Oops.Panic).internalDetails).toContain('AI_TYPESAFE_API_KEY is not configured');
      }
    }
  });
});
