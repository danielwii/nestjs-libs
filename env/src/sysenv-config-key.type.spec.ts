/**
 * Type-level lock for SysEnvConfigKey (TPDD M5/M6/N1).
 * If this file typechecks, invalid/free-string keys and excluded getters are not assignable.
 */

// Runtime smoke so `bun test` picks up the file (types already enforced by tsc).
import { describe, expect, it } from 'bun:test';

import type { SysEnvConfigKey } from './configure';

type IsAssignable<A, B> = A extends B ? true : false;
type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;

type VertexIsKey = IsAssignable<'AI_GOOGLE_VERTEX_API_KEY', SysEnvConfigKey>;
type OpenRouterIsKey = IsAssignable<'AI_OPENROUTER_API_KEY', SysEnvConfigKey>;
type TypoIsKey = IsAssignable<'NOT_A_SYSENV_KEY', SysEnvConfigKey>;
type FreeStringIsKey = IsAssignable<string, SysEnvConfigKey>;
type EnvironmentIsKey = IsAssignable<'environment', SysEnvConfigKey>;
type IsNodeDevIsKey = IsAssignable<'isNodeDevelopment', SysEnvConfigKey>;
type NodeNameIsKey = IsAssignable<'NODE_NAME', SysEnvConfigKey>;

type _vertex = AssertTrue<VertexIsKey>;
type _openrouter = AssertTrue<OpenRouterIsKey>;
type _typo = AssertFalse<TypoIsKey>;
type _free = AssertFalse<FreeStringIsKey>;
type _env = AssertFalse<EnvironmentIsKey>;
type _isNode = AssertFalse<IsNodeDevIsKey>;
type _nodeName = AssertFalse<NodeNameIsKey>;

describe('SysEnvConfigKey type contract', () => {
  it('accepts known scalar config keys at the value level', () => {
    const keys: SysEnvConfigKey[] = ['AI_GOOGLE_VERTEX_API_KEY', 'AI_OPENROUTER_API_KEY', 'DATABASE_URL'];
    expect(keys).toHaveLength(3);
  });
});
