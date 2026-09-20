# Migrations

## Decouple class-validator / class-transformer in favor of NestJS 12 Standard Schema & GraphQL SDL

`@danielwii/libs-cli` has completely decoupled from `class-validator` and `class-transformer` as core dependencies,
migrating to NestJS 12 first-class `@standard-schema/spec` (Zod, Valibot, ArkType) and native GraphQL SDL boundaries.

### What changed

- **Environment configuration (`@app/env`)**:
  - `@Transform()` and legacy transform functions (`booleanTransformFn`, `objectTransformFn`, `arrayTransformFn`) are completely eradicated.
  - Configuration parsing and coercion are now Schema-First via `createEnvConfig` and `zod` schemas.
- **GraphQL Code-First (`@app/utils/graphql`)**:
  - `@Allow()` decorators are removed from `CursoredRequestInput`. In GraphQL Code-First, the GraphQL SDL engine (`@Field()`) natively enforces input types and strips unknown fields, making `class-validator` whitelisting decorators obsolete.
  - `export function Allow()` is marked `@deprecated` and remains as a no-op only for migration compatibility.
  - Added exportable `cursoredRequestSchema` (Zod) and bound it as `CursoredRequestInput.schema` for consumers validating pagination with NestJS 12 Standard Schema.
- **Bootstrap Validation Pipes (`@app/nest/boot`)**:
  - `bootstrap()` now registers `AppStandardSchemaValidationPipe` (extending NestJS 12 `StandardSchemaValidationPipe`) to natively validate Standard Schemas from parameter metadata (`@Body({ schema })`, `@Args({ schema })`) and static class schemas (`metatype.schema`).
  - Added `DualBoundaryValidationPipe` which automatically bypasses `class-validator` `whitelist: true` filtering when a Standard Schema is present, eliminating the legacy conflict where non-class-validator inputs were stripped to empty objects.
  - Added `validationPipe` option to `BootstrapOptions`. Consumers can pass `validationPipe: false` to completely disable the legacy `ValidationPipe` for pure Standard Schema environments.

### Required consumer changes

- **Environment variables**:
  - Do not use `@Transform()` decorators on environment classes. Pass Zod schemas directly to `createEnvConfig({ schema: ... })`.
- **GraphQL Code-First DTOs**:
  - **Pure inputs (e.g. pagination, ID lookups)**: Remove all `class-validator` decorators (including `@Allow()`, `@IsOptional()`). Let `@Field()` define the schema.
  - **Inputs requiring business validation (e.g. email, min length)**:
    1. Define the validation contract using Zod: `export const CreateUserInputSchema = z.object({ ... });`
    2. Derive TypeScript type: `export type CreateUserInputType = z.infer<typeof CreateUserInputSchema>;`
    3. Implement in Code-First class:
       ```typescript
       @InputType()
       export class CreateUserInput implements CreateUserInputType {
         @Field(() => String)
         name!: string;

         static readonly schema = CreateUserInputSchema;
       }
       ```
    4. In Resolvers, pass schema via `@Args('input', { schema: CreateUserInput.schema })`, or rely on `AppStandardSchemaValidationPipe` auto-detection.
- **Full modernization**:
  - Consumers ready to retire `class-validator` entirely can configure `bootstrap({ validationPipe: false })` and remove `class-validator` / `class-transformer` from their application dependencies.

### How migration is proven

- `bun run typecheck`, `bun run lint`, and `bun test` (850 pass / 0 fail across 68 test files) pass cleanly.
- `CursoredRequestInput` static schema integration verified via unit tests in `graphql.spec.ts`.
- gRPC microservice boundary enhancer tests in `bootstrap.spec.ts` pass without regression.

## `@app/utils/prompt` time rendering consolidates onto `Anchored`; offsets rejected; 3 zero-consumer exports removed

`@app/utils/prompt` had its own, second implementation of "is this timezone valid" and
"project an instant into it" — the same rules `@app/utils/anchored`'s `Anchored`/`assertZone`
already enforce for stored attribution. This revision removes the duplicate and adds one new
core function that both `formatLocalDateTime` and a new span renderer build on.

### What changed

- **New**: `readLocalTime(value, observer, ownZone?, sensitivity?)` — the one validate +
  project + render implementation for model-facing local time. `value` is an instant or a
  `Temporal.PlainDate`. `observer` (required, no default) is whoever is reading the text.
  `ownZone` (optional) is the value's own attribution zone when it differs from the observer
  (e.g. someone else's event); omitted, it equals `observer` and the result is trivially
  same-zone. Returns `{ text, shape, zone, ownZone, sameZone, ownText?, weekday, dayPeriod? }`
  (`dayPeriod` only for `shape: 'instant'`). `formatLocalDateTime`'s body is now
  `readLocalTime(...).text`.
- **New**: `readLocalSpan(start, end, observer, ownZone?)` — a start–end instant range in the same
  wording (`2026-09-23 15:00–16:00 (Asia/Taipei)`, or `→` across a local day boundary).
  When the two endpoints carry different UTC offsets (a span crossing a DST transition) each clock is printed with its offset, e.g. `01:30-07:00–01:30-08:00`, because identical local clocks can name different instants there. Blank endpoints throw; a blank attribution zone passed to `readLocalTime` throws instead of being treated as omitted.
- **New types**: `TimeReading`, `SpanReading`, `LocalTimeValue` — a *reading* is a time as one reader sees it: `text` is presentation for the model, never an identity; `instant` / `start` / `end` (ISO-8601 UTC) are for code. Ambiguous local clocks (DST repeated hour) carry their UTC offset in `text`; a cross-midnight owner date rides in `ownText`.
- **Breaking**: a raw UTC offset (`"+8"`, `"+08:00"`) as `timezone`/`observer` — to
  `formatLocalDateTime`, `zonedAt`, `readLocalSpan`, `readLocalTime`, or
  `PromptBuilder.render()`'s `timezone` option — now throws instead of being tolerated. Only
  IANA identifiers (and, where the shape allows it, `FLOATING`) are accepted; this is the same
  rule `Anchored` already applied to stored attribution, now applied uniformly to observer
  zones too. A caller with a legacy offset-format zone must resolve it to an IANA identifier
  before calling.
- **Removed** (zero call sites in every downstream consumer checked at removal time):
  `zonedNow`, `formatLocalDate`, `formatLocalShortTime`. `zonedAt` is kept — it has an active
  consumer — as a thin shell over the same projection, same signature and return type
  (`Temporal.ZonedDateTime`).
- `decorateWithNow`'s `<now>` label now shares the same weekday/day-period wording assembly as
  `formatLocalDateTime`'s Now-line text (previously two separate copies of the same
  concatenation); its own output format (time embedded in the tag body, zone as a separate XML
  attribute) is unchanged.
- **Breaking**: an explicit empty string as `readLocalTime`'s/`formatLocalDateTime`'s `value`
  now throws instead of being read as "now" — only omitting the argument (`undefined`) means
  "now". A caller that built an empty string to mean "no value" must omit the argument instead.
- `TimeSensitivity.Hour` (`"01 AM"`) falls back to `Minute` granularity only inside a DST-repeated
  hour, so the disambiguating UTC offset reads as `01:30-07:00` instead of appending after
  `AM`/`PM` (`01 AM-07:00`, which reads as a range). Unambiguous `Hour`-sensitivity renders are
  unchanged.

### Required consumer changes

None for a consumer that only ever passes IANA zone identifiers (the norm since the write
boundary work in this same effort started enforcing that on stored attribution). A consumer
still passing a raw UTC offset as an observer/render timezone must resolve it to an IANA
identifier first. A consumer importing `zonedNow`, `formatLocalDate`, or
`formatLocalShortTime` must migrate to `readLocalTime`/`formatLocalDateTime` — the import
will no longer resolve. A consumer building an empty string to mean "use the current time"
must omit the argument instead.

### How migration is proven

`bun run typecheck`, `bun run lint`, and `bun run test` (828 pass / 0 fail) are clean.
`zonedNow`/`formatLocalDate`/`formatLocalShortTime` had zero references in every downstream
consumer checked at removal time and zero references in this repo's own test suite.

## Removed the 3 deprecated prompt factory functions

`createBasePrompt`, `createPrompt`, and `createEnhancedPrompt` (all in
`@app/utils/prompt`, all marked `@deprecated` in favor of
`PromptBuilder.from(config).render(options)` from `@app/utils/prompt.xml`)
are removed, along with their private helpers (`PromptSchema`,
`RequirementsSchema`, `SpecialConsiderationsSchema`, `renderList`) that had no
other caller.

### What changed

The three functions, their supporting types/schemas, and the `dedent` import
they alone used are gone from `@app/utils/prompt`. Nothing else in that module
changed — `formatLocalDateTime`, `formatLocalDate`, `formatLocalShortTime`,
`zonedNow`, `zonedAt`, `generateJsonFormat`, `customJsonFormatSupportOutput`,
and the cache-aware prompt decorators (`decorateWithNow`, `decorateUserInput`)
are all untouched.

### Required consumer changes

None for a consumer that has already migrated to `PromptBuilder` — this was
the only supported path since these three were deprecated. A consumer that
still imports `createBasePrompt`, `createPrompt`, or `createEnhancedPrompt`
must move to `PromptBuilder.from(config).render(options)` before advancing
past this revision; the import will no longer resolve.

### How migration is proven

Zero call sites in every downstream consumer checked at removal time, and
zero references in this repo's own test suite — the functions had been fully
superseded by `PromptBuilder`, which already carries its own spec coverage in
`prompt.spec.ts`. `bun run typecheck`, `bun run lint`, and `bun run test`
(813 pass / 0 fail) are clean after removal with no other file touched.

## `@app/utils/prompt` time formatting requires an explicit timezone

Breaking at runtime (not a type error). `formatLocalDateTime`, `formatLocalDate`,
`formatLocalShortTime`, `zonedNow`, `zonedAt`, and anything that renders through
`PromptBuilder.render()`'s `now`/`timezone` — every one of these previously
fell back to `process.env.TZ`, then the host's own timezone, whenever the
caller omitted (or passed an invalid) `timezone`. That default silently leaked
the process's own timezone into text meant to read as someone else's "now": a
prompt built for a person in one zone, running on a host or local machine in
another, showed the WRONG local time with no error to signal it.

### What changed

A missing or unrecognized `timezone` now throws `TypeError` (message contains
`timezone`) instead of defaulting. There is no fallback value; the caller must
always know and pass the timezone of whoever is meant to read the rendered
time.

### Required consumer changes

Audit every call site that renders a time through this module (`formatLocalDateTime`,
`zonedNow`, `zonedAt`, `formatLocalDate`, `formatLocalShortTime`, `PromptBuilder.render()`
with `now` not explicitly `null`) and confirm each one passes the timezone of
the actual reader — the requesting member's timezone, falling back to the
family/org's own timezone only when there is no individual to attribute it to.
A call site that has no such value available and only wants to omit the time
entirely should pass `render({ now: null, ... })` (or skip calling these
functions), not invent a placeholder zone.

## `assertZone` exported from `@app/utils/anchored`

Additive. The zone check that `Anchored` already applies at construction is now
also exported as `assertZone(zone, shape)`, so a consumer's write boundary can
validate and canonicalize an attribution zone with the same rule the read side
uses. `shape` (`'instant' | 'date' | 'time'`) is the shape being stored; it
decides whether `FLOATING` is acceptable (only for `'time'`). No consumer change is required; consumers that keep their
own IANA check may replace it with this one.

## Native Temporal and datetime trim

This Libs revision removes the `@js-temporal/polyfill` dependency and seven
unused exports from `utils/src/datetime.ts`, and establishes a runtime floor:
**Bun ≥ 1.4** (native `Temporal`). Consumers pin Libs by an exact Git gitlink;
a consumer that keeps its old pin is unaffected.

### What changed

- `@js-temporal/polyfill` is no longer a dependency. Every Libs file that
  imported `{ Temporal }` from it now uses the global that Bun 1.4 provides.
- Removed from `@app/utils/datetime` (zero references in every locally checked
  consumer at removal time): `normalizeTimezoneWithLog`, `parseTimezoneOffset`,
  `formatDateToYmd`, `parseYmdToUtcDate`, `isValidYmdDate`, `dateToPlainDate`,
  `plainDateToUtcDate`.
- `normalizeTimezone` is kept and now validates non-offset input through
  Temporal: unknown identifiers return `null` instead of passing through, and
  identifiers are case-normalized (`asia/tokyo` → `Asia/Tokyo`).
- New module: `@app/utils/anchored` (`Anchored`, `FLOATING`).

### Required consumer changes

All of these land in the **same change** as the gitlink advance.

#### 1. Regenerate `bun.lock`

Libs is a workspace member, so the consumer's committed `bun.lock` records
`@js-temporal/polyfill` inside the libs workspace block. CI and Docker install
with `--frozen-lockfile` and fail before typecheck runs. After advancing the
gitlink, run `bun install` in the consumer and commit the resulting lockfile.

#### 2. Enable Temporal types in `tsconfig`

The global `Temporal` is typed only by TypeScript's own
`lib.esnext.temporal.d.ts`; `@types/bun` does not declare it. A consumer whose
`lib` omits it fails with `TS2304: Cannot find name 'Temporal'` in the vendored
Libs files.

```jsonc
"lib": ["ES2022", "ESNext.Temporal"] // or ["ESNext"]
```

A consumer whose `tsconfig` extends `libs/tsconfig.base.json` inherits
`lib: ["ESNext"]` and needs no change. A consumer that sets its own `lib`
without `ESNext.Temporal` must add it.

#### 3. Own any `Date ↔ PlainDate` boundary codec

`dateToPlainDate` / `plainDateToUtcDate` have no successor in Libs. A consumer
that needs a Prisma `@db.Date` codec owns it, and keeps the invariant the removed
code carried: read with **UTC** accessors (`getUTCFullYear` / `getUTCMonth` /
`getUTCDate`) and write `Date.UTC(y, m - 1, d)`; otherwise a date column crosses
a day boundary in any non-UTC process.

### How migration is proven

1. the recorded `libs` gitlink advances to this revision;
2. the consumer's `bun.lock` no longer lists `@js-temporal/polyfill`;
3. the consumer's `tsconfig` `lib` resolves `Temporal`;
4. no active reference to any removed export;
5. the consumer's normal typecheck, tests, and lint pass against the advanced
   gitlink **on Bun ≥ 1.4**.

Passing typecheck is not runtime evidence for this revision: `tsc` resolves
`Temporal` from `lib` on any runtime, while only Bun ≥ 1.4 provides the global.
A Temporal-less runtime fails at boot with `ReferenceError: Temporal is not
defined`.

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
