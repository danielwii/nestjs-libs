# Schema-based environment configuration

`createEnvConfig` validates and coerces the complete environment through one Zod object. It returns typed `vars`, source information, database-field metadata, and an explicit `sync(client)` operation. Loading configuration does not connect to a database.

```ts
import { asDatabaseField, baseEnvSchema, coerceNumber, createEnvConfig } from '@app/env';

import { z } from 'zod';

const schema = baseEnvSchema.extend({
  SERVICE_BATCH_SIZE: asDatabaseField(coerceNumber(z.number().int().min(1).max(100).default(10)), {
    format: 'number',
    scoped: true,
    description: 'Batch size',
  }),
});
const config = createEnvConfig(schema, { scope: 'example-service' });

// Before accepting traffic:
const initial = await config.sync(settingsClient);
if (initial.isErr()) throw initial.error;

// Later, from the application's existing refresh lifecycle:
const refreshed = await config.sync(settingsClient);
if (refreshed.isOk()) console.log(refreshed.value.changedKeys);
// On Err, report the error; config.vars still contains the last valid snapshot.
```

The settings client is structural (`ISysAppSettingClient`). Its write formats are the four supported values, so a generated Prisma client with the corresponding enum can satisfy the port directly. The caller owns connection creation, scheduling and shutdown; `sync` does not disconnect it.

## Configuration and refresh rules

- `coerceBoolean` accepts booleans, numeric `1/0`, and the exact strings `true/false/1/0`. Nullish or blank input invokes the field's default/optional behavior. Other values are rejected by a boolean schema instead of becoming `false`.
- `coerceNumber` converts numeric strings or numbers. It does not convert booleans, arrays or objects into numbers. Blank/nullish values retain missing-value semantics; numeric constraints remain in the field schema.
- Host environment wins over dotenv files. Schema defaults and transformations should be deterministic; derive volatile runtime values separately. Production loading requires an explicit `ENV` or `DOPPLER_ENVIRONMENT` instead of silently selecting development.
- Fields used by synchronization must declare `format: 'string' | 'number' | 'boolean' | 'json'`. Env-only loading may omit this metadata. Format is declared explicitly, never inferred from Zod internals.
- Synchronization requires `options.scope` or the captured `APP_NAME`; `shared` is reserved. Unscoped fields use the shared row. Scoped fields select the project row when present, otherwise the shared row. A selected row with SQL `NULL` withdraws its override and restores the startup host/schema baseline.
- String storage is read literally; other formats use JSON decoding before the full schema runs. Blank non-string storage is treated as missing. JSON `null` is an explicit JSON-field value, distinct from SQL `NULL`.
- Each refresh starts from the captured raw input, preventing repeated transforms from accumulating on previously parsed values. The entire candidate is validated before any metadata write. A valid `false` or `0` reaches `vars` unchanged.
- Metadata coordination preserves manual `value` data. A service owns metadata in its project scope; shared rows require matching `createdBy`, including restoration. Foreign or unowned shared rows are never claimed automatically. Optional defaults absent from code do not erase an existing metadata default.
- Publication occurs only after every required metadata operation succeeds. The `vars` object keeps its identity; withdrawn optional properties are removed. Overlapping refresh calls share the in-flight result.
- The storage port has no transaction guarantee. An IO failure may leave some metadata writes completed, but returns `Err` without publishing a new runtime snapshot. Operations are idempotent so a later retry converges. Validation errors perform no writes.

`AppConfigure` and `@DatabaseField` remain available for existing consumers. They reuse the same metadata ownership coordination while retaining their existing per-field refresh and statistics contract. The schema runtime does not invoke the reflection-based entry point or obtain fields from a legacy class.

## Verification

Run normal checks with `bun run typecheck`, `bun run typecheck:tsc`, `bun run lint`, and `bun test`.

For the PostgreSQL port exercise, set `SETTINGS_TEST_DATABASE_URL` to a disposable database and run:

```sh
bun run test:settings-integration
```

This explicitly selected test creates a temporary settings table and rolls back every fixture. It checks actual persisted scope/creator isolation and defaults, rejected-candidate write isolation, override removal, and caller connection ownership. It is separate from the default test suite and fails if the database variable is missing.
