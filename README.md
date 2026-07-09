# nestjs-libs

## TypeScript Toolchain

This branch prepares TypeScript 7 support, but it is intentionally still a
draft migration.

### Goal

Use the TypeScript 7 native compiler for project type-checking while keeping
the TypeScript 6 JavaScript compiler API available for tooling that still
depends on it, especially `typescript-eslint`.

### Non-goals

This does not remove `typescript-eslint`, switch CI to a Bun canary build, or
treat the TypeScript 7 compiler API as a drop-in replacement for the TypeScript
6 JavaScript API.

### Package Boundary

The intended package split follows the TypeScript side-by-side layout:

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@^7.0.2",
    "typescript": "npm:@typescript/typescript6@^6.0.2"
  }
}
```

- `@typescript/native` owns the TS7 native `tsc` path used by
  `bun run typecheck`.
- `typescript` remains the package name resolved by tools such as ESLint and
  `typescript-eslint`; it must expose the TS6 JavaScript compiler API.
- `tsc6` is kept available as a compatibility check through
  `bun run typecheck:ts6`.

### Verification

After installing dependencies from a package manager that resolves the aliases
correctly, the toolchain boundary should pass:

```sh
bun run toolchain:ts
bun run lint
bun run typecheck
bun test
```

The important invariant is that `require("typescript")` returns the TS6
JavaScript API, while `tsc` resolves to TypeScript 7 native.

Current local draft status on Bun `1.3.14`:

- `bun install --ignore-scripts` completes with the side-by-side aliases.
- `bun run typecheck` passes through the TS7 native `tsc`.
- `bun test` passes.
- `bun run toolchain:ts` fails because `require("typescript")` resolves to
  `version=undefined Extension=undefined`.
- Direct ESLint fails inside `@typescript-eslint/typescript-estree` when it
  reads `ts.Extension.Cjs`.

### Pending

- Bun `1.3.14` is the last Zig stable release. The Rust rewrite is expected in
  Bun `1.4.0`, but the stable release is not available yet.
- Current stable Bun installs this side-by-side TypeScript layout incorrectly:
  `@typescript/typescript6` depends on `@typescript/old` with the
  `npm:typescript@^6` spec, and Bun redirects that nested alias back to the
  root `typescript` alias instead of the real TypeScript 6 package.
- The upstream Bun issue is
  <https://github.com/oven-sh/bun/issues/33834>. The upstream fix PR is
  <https://github.com/oven-sh/bun/pull/33835>, but it is not in a stable Bun
  release yet.
- This PR should stay draft until a stable Bun release resolves the alias
  behavior and a clean install can pass the verification commands above.
