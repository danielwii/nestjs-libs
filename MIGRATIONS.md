# Migrations

## Oops hard retirement

This Libs revision hard-removes three historical compatibility paths:

- `@app/nest/exceptions/oops-factories`;
- `Oops.NotFound`;
- direct `new Oops.Panic({...})` construction without an explicit `oopsCode`.

Consumers pin Libs by an exact Git gitlink. A consumer that keeps its old pin
keeps the old behavior and is not affected by this revision. A consumer that
advances its gitlink to this revision must complete the migration below in the
same change. There is no cross-version runtime compatibility layer.

### How migration is proven

A consumer is migrated only when all of the following evidence exists in its
upgrade change:

1. the recorded `libs` gitlink advances to the hard-removal revision;
2. the removed import and factory path have zero active references;
3. every direct Panic constructor has a deliberate, non-empty `oopsCode`, or is
   replaced by a shared factory with exactly matching semantics;
4. the consumer's normal typecheck, tests, and lint pass against the advanced
   gitlink.

A consumer still pinned to an older Libs commit is intentionally **not
migrated**. That is safe and observable from the gitlink; it is not evidence
that this revision needs a compatibility alias.

If a consumer advances the gitlink without migrating, expected compiler errors
are the enforcement mechanism: the removed module cannot be resolved,
`Oops.NotFound` does not exist, or `PanicConfig.oopsCode` is required.

### Required source changes

#### 1. Remove side-effect factory imports

Before:

```ts
import { Oops } from '@app/nest/exceptions/oops';
import '@app/nest/exceptions/oops-factories';
```

After:

```ts
import { Oops } from '@app/nest/exceptions/oops';
```

No replacement import is required. Importing `oops.ts` exposes every supported
factory at runtime.

#### 2. Use the canonical not-found factory

Before:

```ts
throw Oops.NotFound('设备', deviceId);
```

After:

```ts
throw Oops.Block.NotFound('设备', deviceId);
```

The observable contract remains `404 / CLIENT_INPUT_ERROR / GN02`, including
the existing user message and internal details.

#### 3. Give direct Panic constructors a domain-owned code

If an existing shared factory exactly matches the failure semantics, use it:

```ts
return Oops.Panic.Database('searchMemories', { cause });
return Oops.Panic.ExternalService('redis', details, { cause });
return Oops.Panic.Config('INFRA_REDIS_URL is required');
```

Otherwise keep the consumer-owned construction and add a stable code owned by
that consumer:

```ts
return new Oops.Panic({
  errorCode: ErrorCodes.EXTERNAL_SERVICE_ERROR,
  oopsCode: 'LOCK01',
  userMessage: '系统繁忙，请稍后重试',
  internalDetails: `Lock: ${details}`,
  provider: 'lock',
  cause,
});
```

Do not allocate a new shared `GNxx` code in consumer code. Preserve
`httpStatus`, `errorCode`, user message, internal details, provider, and `cause`
unless a separately reviewed contract change authorizes different behavior.

### AI migration contract

An AI agent performing a consumer upgrade must:

1. read that repository's nearest `AGENTS.md` and record branch, HEAD, current
   gitlink, nested Libs HEAD, and dirty state before editing;
2. preserve all pre-existing tracked, staged, nested-submodule, and untracked
   user changes;
3. limit the migration to the three source changes above plus the deliberate
   gitlink advance;
4. use a shared Panic factory only when its status, `errorCode`, message,
   details, provider, and cause semantics match; otherwise allocate a
   consumer-owned code;
5. run the zero-reference checks and the repository's normal typecheck, tests,
   and lint;
6. report the exact advanced gitlink and separate local validation from PR/CI,
   merge, deployment, and runtime evidence.

The agent must not modify an embedded Libs checkout in place and then claim the
consumer migrated. The parent repository's recorded gitlink is the version
authority.

### Registered-consumer migration baseline

Inventory date: 2026-07-23. Counts exclude embedded `libs`, contract checkouts,
dependencies, generated output, dist, build, and coverage.

| project_id | `Oops.NotFound` calls | old factory imports | direct Panic without `oopsCode` |
|---|---:|---:|---:|
| `calo-server` | 0 active (1 dated plan reference) | 0 | 5 |
| `calo-agents` | 0 | 0 | 0 |
| `unee` | 2 | 14 | 2 |
| `unee-admin-web` | 0 | 0 | 0 |
| `unee-ai-persona` | 0 | 7 | 1 |
| `mcp` | 0 | 0 | 0 |
| `marsgate` | 4 | 5 | 1 |
| `third-party` | 4 | 5 | 1 |
| **Total active** | **10** | **31** | **10** |

This table estimates migration work; it is not a release gate for this Libs
revision. Re-run the searches against the exact consumer head when that
consumer advances its gitlink.

Useful zero-reference checks:

```sh
rg "Oops\\.NotFound\\s*\\(" . --glob '!**/libs/**' --glob '!**/contract*/**' --glob '!**/node_modules/**'
rg "oops-factories" . --glob '!**/libs/**' --glob '!**/contract*/**' --glob '!**/node_modules/**'
rg -U "new\\s+Oops\\.Panic\\s*\\(\\s*\\{" . --glob '!**/libs/**' --glob '!**/contract*/**' --glob '!**/node_modules/**'
```

The third search is a review list rather than a zero-result assertion. Every
result must include a deliberate non-empty `oopsCode` or be replaced by a
semantically matching shared factory.

There is no data migration. Rollback means restoring the consumer's previous
source and exact Libs gitlink.
