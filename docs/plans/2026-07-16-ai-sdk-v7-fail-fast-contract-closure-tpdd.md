# AI SDK v7 Fail-Fast Contract Closure (TPDD)

- Status: Implemented, ready for review
- Date: 2026-07-16
- Repository: `danielwii/nestjs-libs`
- Baseline: `main@58612f7`
- Predecessor: GitHub Issue #13 and PR #15
- Change shape: one atomic libs PR; consumer migrations remain separate PRs

## 1. Goal Alignment

### Goal

Make the shared LLM boundary fail fast at TypeScript compile time. The library
must expose exactly one AI SDK v7 vocabulary and make deprecated or duplicate
ownership states unrepresentable to TypeScript consumers.

The canonical vocabulary is:

- `instructions`
- `onEnd`
- `onAbort`
- `stream`
- `ai.tools`
- `ai.toolChoice`
- `ai.stopWhen`
- concrete `TOOLS` and `RUNTIME_CONTEXT` generics

The library must not absorb consumer migration errors through aliases,
normalization, fallback fields, merge arbitration, `any`, or generic-erasing
casts.

### Non-goals

- Do not change model selection, provider routing, prompts, tool behavior, or
  product behavior.
- Do not change REST, GraphQL, gRPC, protobuf, Prisma, or database contracts.
- Do not modify `calo-server`, `calo-agents`, `unee-server`, or any contract
  repository in this PR.
- Do not add a runtime compatibility layer for `system`, `onFinish`,
  `fullStream`, `maxSteps`, or root-level `tools` / `stopWhen`.
- Do not remove every deprecated or experimental AI SDK field. This cut owns
  only the canonical vocabulary named above and fields whose ownership is
  already managed by `LLM`.
- Do not migrate to AI SDK v8, TypeScript 6-only syntax, or a new LLM framework.
- Do not make per-tool `outputSchema` mandatory.
- Do not promise cleanup for a caller that abandons a native stream without an
  `AbortSignal`. Explicit cancellation remains `AbortSignal`-driven. The
  library-owned `streamObjectViaTool` async generator must still finalize when
  its consumer returns early.

### Success Criteria

1. Every removed public spelling produces a TypeScript error at the calling
   source line.
2. Positive v7 calls preserve concrete tool, tool choice, stop condition, and
   runtime-context types through the public boundary and return type.
3. Stream terminal cleanup and terminal logging execute exactly once for
   success, fatal failure, and abort, even when caller callbacks throw.
4. An AI SDK `onError` event is treated as an event, not automatically as a
   terminal failure.
5. AI SDK OTel registration has explicit, testable status and is process-wide
   idempotent.
6. The repository declares and locks the dependency identities required to
   reproduce its verification environment.
7. A consumer-facing dependency identity command detects duplicate physical
   package identities, including duplicates nested below scoped packages.
8. TypeScript 6 and the consumer baseline TypeScript 5.9.3 both pass the same
   compile-time contract fixtures.

## 2. Evidence Baseline

The following facts are verified on `main@58612f7` and are the reason for this
follow-up cut:

1. `LLMPrepareStepResult` omits `model` and `providerOptions`, but still inherits
   the AI SDK deprecated `system` field from `PrepareStepResult`.
   - `features/llm/clients/llm.class.ts:153-180`
2. `LLM.streamText()` and `LLM.streamObject()` infer and return native AI SDK
   results, so `fullStream` remains publicly addressable.
   - `features/llm/clients/llm.class.ts:1372-1483`
   - `features/llm/clients/llm.class.ts:1501-1603`
3. `StreamTextParams` is declared with `export`, but the clients barrel does not
   re-export it.
   - `features/llm/clients/llm.class.ts:273-279`
   - `features/llm/clients/index.ts:50-62`
4. Compile probes on the baseline produce these results:
   - `prepareStep: () => ({ system: 'legacy' })`: compiles.
   - `ReturnType<typeof LLM.streamText>['fullStream']`: compiles.
   - importing `StreamTextParams` from the public barrel: TS2305.
   - `ai.onFinish`: correctly fails to compile.
5. Stream callbacks await caller code before cleanup and internal logging. A
   throwing caller callback skips both operations.
   - `features/llm/clients/llm.class.ts:1456-1477`
   - `features/llm/clients/llm.class.ts:1576-1597`
6. AI SDK v7 invokes `onError` for each error stream part. It may later invoke
   `onEnd` when generation completes, so `onError` is not a terminal-state
   signal by definition.
   - verified against installed `ai@7.0.28` source
7. `replayFromFile()` still normalizes `data.system` to `instructions`.
   - `features/llm/clients/llm.class.ts:880-884`
8. AI SDK OTel registration uses a process marker, but catches every error as if
   an optional package were absent. Tests cover only scope-name filtering.
   - `instrument.ts:134-158`
   - `instrument.spec.ts:40-50`
9. `instrument.ts` statically imports OTel runtime packages that are absent from
   the runtime/peer dependency contract and currently resolve through
   dev/transitive installation.
   - `instrument.ts:67-72`
   - `package.json`
10. PR #15 removed the first dependency identity script after review found that
    it missed nested dependencies below scoped parent packages. Manual consumer
    checking replaced the executable gate, but Issue #13 still requires the
    executable invariant.
11. Baseline verification is green but does not cover these gaps:
    - `bun run typecheck`: pass.
    - TypeScript 5.9.3 `tsc --noEmit`: pass.
    - `bun test`: 508 pass, 0 fail.

Passing the existing suite is therefore baseline evidence, not proof that this
spec is complete.

## 3. Architecture Decision

### 3.1 Invariants

#### C1. One owner per public fact

- Prompt owner: top-level `instructions` only.
- Tool owner: `ai.tools` only.
- Tool selection owner: `ai.toolChoice` only.
- Stop owner: `ai.stopWhen` only.
- Stream completion callback: `ai.onEnd` only.
- Stream abort callback: `ai.onAbort` only.
- Canonical event stream: result `stream` only.

#### C2. Type errors expose migration work

Deprecated fields are removed from the public type, not accepted and converted.
`@deprecated` documentation alone is insufficient because TypeScript does not
make it a compile error.

Compile-time fixtures use `@ts-expect-error`. If a deprecated field becomes
accepted again, TypeScript reports an unused directive and CI fails.

#### C3. Runtime boundaries reject; they do not normalize old contracts

`replayFromFile()` consumes an external file, so it remains runtime-validated.
The v7 capture schema accepts `instructions` and rejects a legacy prompt-owner
field named `system`; it does not convert it.

The message role value `'system'` is a valid protocol role and is not the
deprecated prompt-owner field. Guard types may also name `'system'` solely to
exclude it. Reviews and scans must distinguish these cases.

#### C4. Error events and terminal states are different concepts

AI SDK `onError` is an event callback. Terminal states are:

- `success`: `onEnd`
- `abort`: `onAbort`
- `failure`: synchronous setup failure or rejected terminal result/usage without
  a winning success/abort terminal state

Only a terminal state owns managed-signal cleanup and terminal summary logging.
The first terminal state wins synchronously; later terminal signals are no-ops.

#### C5. Optional dependencies may be absent, not broken

An absent optional AI package produces `dependency_missing`. Any other loading,
construction, or registration error produces `failed` and preserves the real
error. The two states must never share one catch-all diagnostic.

#### C6. Declared dependency topology is part of the API

Standalone success caused by dev dependency hoisting is not proof that a
consumer can compile or start. Every static runtime import and every source-level
type import required by consumers must be represented in the package contract.

### 3.2 Boundary Separation

| Layer                  | Owner                                      | Responsibility                                                          | Must not do                                           |
| ---------------------- | ------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------- |
| TypeScript boundary    | Public LLM types and barrels               | Expose only canonical v7 names and preserve generics                    | Accept aliases or erase types                         |
| Runtime input boundary | Capture-file schema                        | Validate v7 file shape and reject legacy fields                         | Normalize `system` to `instructions`                  |
| Adapter                | `LLM` to AI SDK v7                         | Translate model/provider-owned fields and pass canonical native options | Merge duplicate owners                                |
| Lifecycle              | Shared stream terminal coordinator         | Distinguish events from terminal states and finalize once               | Treat every `onError` event as terminal               |
| Output contract        | Canonical stream result type               | Expose `stream` while hiding `fullStream`                               | Return a public native type that reintroduces aliases |
| Observability          | AI SDK OTel registrar and telemetry policy | Register once, report exact status, export selected fields              | Swallow real registration errors                      |
| Dependency gate        | Identity checker                           | Prove one physical identity per skew-prone package name                 | Rely on manual inspection or shallow scoped scans     |

## 4. Consumer Chain

```text
Service developer and CI compiler
<- public `@app/llm-core` barrel and explicit stream result type
<- `LLM.streamText` / `LLM.streamObject` canonical adapter
<- AI SDK v7 typed request and lifecycle events
<- provider implementation

Operations and tracing consumer
<- Langfuse / OTLP spans
<- one registered `@ai-sdk/otel` integration
<- explicit per-call telemetry selection
<- sanitized request provenance

Consumer repository verification
<- CI/pre-push dependency identity command
<- recursive package discovery from configured anchors
<- installed workspace and libs package identities
```

| Link                               | Consumer need                                   | Producer promise                                    | Verification                           |
| ---------------------------------- | ----------------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| Service source -> libs types       | Wrong migration spelling is visible immediately | Deprecated fields are absent from public types      | Negative compile fixtures              |
| Libs types -> AI SDK adapter       | Concrete tool/context inference survives        | No `any` or generic-erasing return cast             | Positive and negative generic fixtures |
| Adapter -> AI SDK                  | One owner for each request fact                 | Canonical `ai.*` options pass unchanged             | Request-boundary integration tests     |
| AI SDK events -> lifecycle         | Cleanup is deterministic                        | Event/terminal split and once gate                  | Deterministic lifecycle tests          |
| Telemetry config -> exporter       | One trace and bounded context                   | Idempotent registration and explicit capture policy | In-memory span tests                   |
| Consumer install -> source compile | Runtime types have one identity                 | Recursive identity proof across anchors             | Fixture-driven CLI tests               |

## 5. TPDD Development Promise

### Must Have - Critical Check Points

- [x] M1. Top-level `system`, root-level `tools`, root-level `stopWhen`, and
      `maxSteps` fail public compile-time fixtures.
- [x] M2. `ai.instructions`, `ai.system`, `ai.prompt`, `ai.messages`, and
      `ai.onFinish` fail public compile-time fixtures.
- [x] M3. `prepareStep.system` fails while `prepareStep.instructions` compiles.
- [x] M4. `result.fullStream` fails while `result.stream` compiles for both
      `streamText` and `streamObject`.
- [x] M5. `StreamTextParams` and the canonical stream result type are exported
      from both `features/llm/clients` and `features/llm`.
- [x] M6. Concrete tool names, `ToolChoice`, `stopWhen`, and runtime-context
      fields remain inferred. Invalid tool names/context keys fail without `any`.
- [x] M7. No runtime prompt-owner compatibility remains in
      `replayFromFile()`; legacy capture files are rejected with an actionable
      validation error.
- [x] M8. `streamText` and `streamObject` use one shared terminal coordinator.
      Success, fatal failure, and abort each clean up and emit one terminal summary.
- [x] M9. A throwing caller `onEnd`, `onAbort`, or `onError` callback cannot
      skip required internal cleanup or logging.
- [x] M10. Non-terminal `onError` events do not clear the managed timeout or
      claim the terminal state; a later successful `onEnd` still owns finalization.
- [x] M11. `streamObjectViaTool` finalizes its managed signal when the owned
      async generator completes, throws, aborts, or is returned early.
- [x] M12. AI SDK OTel registration is process-global and idempotent; two
      bootstrap attempts add one integration and one LLM call emits one AI span.
- [x] M13. OTel status distinguishes `registered`, `already_registered`,
      `dependency_missing`, and `failed`; real errors are not reported as missing
      packages.
- [x] M14. Telemetry explicitly sets input/output recording and default runtime
      context selection. Unselected and sensitive provenance fields are absent from
      emitted spans.
- [x] M15. All static instrumentation imports have declared dependency/peer
      ownership; the standalone verification pair is reproducibly locked.
- [x] M16. The dependency identity command detects duplicate realpaths below
      unscoped and scoped parent packages, including same-version duplicates.
- [x] M17. TypeScript 6 and TypeScript 5.9.3 compile the same contract fixtures.
- [x] M18. No public/runtime compatibility path uses `any`, and no cast erases
      stream tool/context result generics.

### Need Have - Important Check Points

- [x] N1. A two-step fixture proves `event.usage` is aggregate usage and
      `event.finalStep.usage` is last-step usage; accounting/logging is not doubled.
- [x] N2. A non-AI preload fixture starts when `ai` and `@ai-sdk/otel` are
      unavailable, while required non-AI instrumentation dependencies are present.
- [x] N3. Dependency diagnostics list package name, version, logical path, and
      realpath for every conflicting identity.
- [x] N4. Existing LLM request/provider behavior tests remain green without
      deleting old assertions to make the cut pass.
- [x] N5. Full repository lint, typecheck, and test gates pass from a clean,
      standalone install.
- [x] N6. Migration documentation states that consumer pointer, AI SDK family,
      lockfile, overrides, and call sites advance atomically.

### Should Have - Optional Check Points

- [ ] S1. Provide a source-only codemod or migration report command that finds
      old spellings. It may rewrite source files, but it must not add runtime
      aliases to libs.
- [x] S2. Emit machine-readable JSON from the dependency identity command for
      CI artifact retention in addition to the human-readable output.
- [ ] S3. Add a documented extension point for future dependency families
      without changing the default skew-prone set.

### Explicit Deferrals

- Consumer repository implementation and release sequencing beyond the
  documented atomic migration contract.
- Fork synchronization from `danielwii/nestjs-libs` to
  `rampagege/nestjs-libs`.
- Runtime protection for callers that deliberately bypass TypeScript with
  `any`, unsafe casts, or JavaScript.
- Bare native stream cancellation without an `AbortSignal`.
- Removal of unrelated AI SDK deprecated/experimental fields.
- Tool result `outputSchema` rollout.

## 6. Target Design

### 6.1 Public Type Surface

The implementation must use explicit public types instead of relying on native
return inference.

Conceptual shape:

```typescript
type LLMManagedAIKeys =
  'model' | 'providerOptions' | 'instructions' | 'system' | 'prompt' | 'messages' | 'onFinish' | 'prepareStep';

export type LLMPrepareStepResult<TOOLS extends ToolSet = ToolSet, RUNTIME_CONTEXT extends Context = Context> =
  | (Omit<NonNullable<PrepareStepResult<TOOLS, RUNTIME_CONTEXT>>, 'model' | 'providerOptions' | 'system'> & {
      llm?: LLMPrepareStepOptions;
    })
  | undefined;

export type LLMStreamTextResult<
  TOOLS extends ToolSet = ToolSet,
  RUNTIME_CONTEXT extends Context = Context,
  OUTPUT extends Output = Output,
> = Omit<StreamTextResult<TOOLS, RUNTIME_CONTEXT, OUTPUT>, 'fullStream'>;
```

The exact `OUTPUT` constraint must match `ai@7.0.28`; the conceptual type above
does not authorize a generic-erasing cast.

Requirements:

1. `LLM.streamText()` and `LLM.streamObject()` declare explicit canonical return
   types preserving all concrete generics.
2. Hiding `fullStream` is a TypeScript public-contract operation. The adapter
   need not clone the runtime AI SDK result merely to delete a property.
3. Public barrels export `StreamTextParams` and `LLMStreamTextResult`.
4. `prepareStep.instructions` remains supported because it is the canonical
   per-step override. `prepareStep.system` is omitted.
5. The touched production surface contains no explicit `any`. Existing replay
   tool choice construction must be typed rather than suppressed.

### 6.2 Capture File Boundary

Define an explicit v7 capture schema and parse the file before replay. The
schema must:

- accept `instructions`;
- reject a prompt-owner property named `system`;
- preserve the valid message role value `'system'` inside `messages`;
- report the rejected path and tell the operator that v7 capture files use
  `instructions`;
- perform no compatibility transform.

No migration script is required for completion. A source/file migration tool is
Should Have only.

### 6.3 Stream Lifecycle Coordinator

Create one internal lifecycle owner used by `streamText` and `streamObject`.
The coordinator has an internal terminal state:

```typescript
type StreamTerminalState = 'pending' | 'success' | 'failure' | 'abort';
```

It must provide these semantics:

1. `onError`:
   - invoke the caller callback once per AI SDK error event;
   - record/log the event through a non-terminal path;
   - never clean up or claim a terminal state by itself;
   - use `try/finally` so caller failure cannot suppress the internal event log.
2. `onEnd`:
   - atomically claim `success` if still pending;
   - invoke caller `onEnd`;
   - in `finally`, clean up and write one success terminal summary using
     aggregate `event.usage`;
   - preserve the caller callback failure behavior expected by AI SDK while
     still completing internal finalization.
3. `onAbort`:
   - atomically claim `abort` if still pending;
   - invoke caller `onAbort`;
   - in `finally`, clean up and write one abort terminal summary.
4. Fatal failure:
   - synchronous adapter/setup failure claims `failure`, cleans up, logs once,
     and rethrows;
   - rejected terminal usage/result without a winning `success` or `abort`
     claims `failure`, cleans up, and logs once;
   - a later signal cannot finalize again.
5. Repeated or racing terminal calls:
   - the first synchronous claim wins;
   - losing calls do not invoke a second terminal callback, cleanup, or terminal
     summary.

`streamObjectViaTool` owns an async generator rather than returning the native
result. Its loop must be enclosed in `try/catch/finally` so early iterator return
also releases managed resources. Explicit abort remains driven by the merged
`AbortSignal`.

### 6.4 OTel Registration and Capture Policy

Move AI SDK registration into a testable boot helper, for example:

`nest/src/boot/ai-sdk-otel.ts`

Public-to-boot internal status:

```typescript
type AiSdkOtelRegistrationResult =
  | { status: 'registered' }
  | { status: 'already_registered' }
  | { status: 'dependency_missing'; packageName: 'ai' | '@ai-sdk/otel' }
  | { status: 'failed'; error: unknown };
```

Rules:

1. Registration runs only after `NodeSDK.start()` succeeds.
2. A process-global `Symbol.for(...)` stores successful registration state.
3. Only a verified module-not-found error for `ai` or `@ai-sdk/otel` maps to
   `dependency_missing`.
4. Constructor and registration errors map to `failed` and are logged as errors
   with the original cause.
5. Existing startup policy decides whether a telemetry failure is fatal; this
   cut does not silently change application startup behavior.
6. The successful diagnostic is info-level and duplicate registration is
   debug-level.
7. The default per-call policy explicitly preserves current capture behavior:

```typescript
const DEFAULT_TELEMETRY = {
  isEnabled: true,
  recordInputs: true,
  recordOutputs: true,
  includeRuntimeContext: { tags: true },
} satisfies TelemetryOptions;
```

8. `@ai-sdk/otel` supplemental `runtimeContext`, `usage`, and
   `providerMetadata` remain explicit.
9. Default runtime context exports only selected sanitized tags. Callers may
   deliberately expand selection through typed telemetry configuration; that
   is an explicit caller decision, not a hidden default.

### 6.5 Dependency Closure and Identity Gate

#### Manifest ownership

- Keep compatible peer ranges for consumers.
- Use exact dev versions for the tested `ai@7.0.28` and
  `@ai-sdk/otel@1.0.28` pair.
- Track `bun.lock` for deterministic standalone CI; remove its ignore rule.
- Declare all static instrumentation runtime imports as dependencies or peers.
- Declare source-level type packages needed when consumers compile vendored
  libs source.
- Keep dynamically required optional integrations optional.

#### Identity command

Ship `scripts/check-dep-identity.ts` and a package script. It must accept one or
more anchors, for example:

```bash
bun run check:dep-identity -- --anchor . --anchor libs
```

Default package families:

- `ai`
- `@ai-sdk/*`
- `@nestjs/*`
- `zod`

Algorithm requirements:

1. Walk each anchor's installed package graph from `node_modules` package
   directories.
2. Treat a scope directory such as `@openrouter` as a container and enter each
   child package before looking for its nested `node_modules`.
3. Read package identity from structured `package.json` data.
4. Follow symlinks with `realpath`, retain both logical and physical paths, and
   track visited realpaths to avoid cycles.
5. Recurse into each discovered package's nested `node_modules`.
6. Group by exact package name, not only family name.
7. Pass only when every occurrence of one package name resolves to one physical
   realpath and one version.
8. Reject two physical installs even when their versions match; duplicate type
   identity is still possible.
9. Print every conflicting version, logical path, and realpath, then exit
   nonzero.

Fixture tests must reproduce the original missed shape:

```text
node_modules/
  @openrouter/
    ai-sdk-provider/
      node_modules/
        @ai-sdk/
          provider/
```

The checker must detect a conflicting root `@ai-sdk/provider` and nested
`@ai-sdk/provider` in that shape.

## 7. Test Plan A

| ID  | Priority | Scenario                                  | Setup / Given                                                                                   | Trigger / When                                     | Expected / Then                                                                              | Evidence                           | Automation       |
| --- | -------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------- | ---------------- |
| C1  | Must     | Canonical request compiles                | Public barrel import, concrete model/messages                                                   | Compile request using `instructions` and `ai.*`    | No diagnostic                                                                                | TS fixture                         | automated        |
| C2  | Must     | Root aliases fail                         | Separate object literals for `system`, `tools`, `stopWhen`, `maxSteps`                          | Run TS6 and TS5.9                                  | Every fixture consumes one `@ts-expect-error`; no unused directive                           | Compiler output                    | automated        |
| C3  | Must     | Nested prompt aliases fail                | `ai.instructions/system/prompt/messages` and `ai.onFinish` fixtures                             | Compile                                            | Every deprecated/duplicate owner is rejected                                                 | Compiler output                    | automated        |
| C4  | Must     | Per-step canonical vocabulary             | One fixture returns `prepareStep.instructions`; one returns `prepareStep.system`                | Compile                                            | `instructions` passes; `system` is rejected                                                  | Compiler output                    | automated        |
| C5  | Must     | Canonical result hides old stream         | Capture return types for `streamText` and `streamObject`                                        | Access `.stream` and `.fullStream`                 | `.stream` passes; `.fullStream` is rejected                                                  | Compiler output                    | automated        |
| C6  | Must     | Public types are exported                 | Import `StreamTextParams` and canonical result from clients and top-level barrels               | Compile                                            | All imports resolve                                                                          | Compiler output                    | automated        |
| C7  | Must     | Concrete tool choice survives             | Define tools `{ lookup, weather }`                                                              | Select `lookup`, then invalid `calendar`           | Valid name compiles; invalid name fails                                                      | Compiler output                    | automated        |
| C8  | Must     | Concrete runtime context survives         | Define typed context and telemetry selection                                                    | Select valid then invalid context property         | Valid key compiles; invalid key fails                                                        | Compiler output                    | automated        |
| C9  | Must     | Stop condition passes unchanged           | Concrete tool set and `stepCountIs(2)` under `ai.stopWhen`                                      | Capture AI SDK request/options                     | Same stop condition identity/behavior reaches SDK                                            | Integration assertion              | automated        |
| C10 | Must     | Legacy capture is rejected                | File fixture has top-level `system`, valid messages/model/schema                                | Call `replayFromFile()` before provider invocation | Validation fails at `system`; provider is not called                                         | Error/result assertion             | automated        |
| C11 | Must     | Message role remains valid                | Capture uses `instructions` and message `{ role: 'system' }`                                    | Parse capture                                      | Parse succeeds                                                                               | Schema assertion                   | automated        |
| L1  | Must     | Successful stream finalizes once          | Fake provider completes one step; spies on caller, cleanup, terminal log                        | Fully consume stream                               | Caller `onEnd`, cleanup, success summary each equal 1                                        | Spy counts                         | automated        |
| L2  | Must     | Throwing `onEnd` cannot skip finalization | Successful fake stream; caller `onEnd` throws                                                   | Consume stream                                     | Cleanup and success summary each equal 1; no second terminal state                           | Spy counts/state                   | automated        |
| L3  | Must     | Error event can recover                   | Fake stream emits one error event then a valid finish                                           | Consume stream                                     | Caller/error-event log each equal 1; cleanup remains 0 until `onEnd`; success finalizes once | Ordered spy trace                  | automated        |
| L4  | Must     | Fatal failure finalizes once              | Fake stream emits fatal error with no completed step                                            | Consume/await terminal usage                       | Failure summary and cleanup equal 1; no end/abort summary                                    | Spy counts and rejected promise    | automated        |
| L5  | Must     | Abort finalizes once                      | AbortController and pending fake stream                                                         | Abort after start                                  | Caller `onAbort`, cleanup, abort summary each equal 1                                        | Spy counts                         | automated        |
| L6  | Must     | Caller abort callback throws              | Same as L5; caller throws                                                                       | Abort                                              | Cleanup and abort summary still equal 1                                                      | Spy counts                         | automated        |
| L7  | Must     | Terminal race is idempotent               | Coordinator fixture invokes abort/failure/end in controlled order                               | Invoke signals synchronously/concurrently          | First claim wins; one cleanup and one terminal summary                                       | Coordinator state                  | automated        |
| L8  | Must     | Stream object uses same semantics         | `streamObject` success and fatal fixtures                                                       | Consume canonical stream                           | Same finalization invariants as text path                                                    | Shared matrix                      | automated        |
| L9  | Must     | Owned generator early return cleans up    | Start `streamObjectViaTool`, receive first event                                                | Call iterator `.return()`                          | Cleanup equals 1; no timer/listener remains                                                  | Spy/resource assertion             | automated        |
| U1  | Need     | Usage is aggregate, not final-step        | Two fake model steps with distinct usage                                                        | Complete stream                                    | `event.usage` equals sum; `finalStep.usage` equals step 2; terminal accounting logs sum once | Fixture values/log                 | automated        |
| O1  | Must     | Registration is idempotent                | Reset test global and install fake registrar                                                    | Call registration twice                            | Results are `registered`, then `already_registered`; integration count is 1                  | Registry assertion                 | automated        |
| O2  | Must     | One call emits one AI span                | In-memory OTel provider and fake AI SDK model                                                   | Register twice, execute once                       | Exactly one expected `gen_ai` operation span                                                 | Exported spans                     | automated        |
| O3  | Must     | Missing AI package is optional            | Inject loader that reports module-not-found for `ai`                                            | Register                                           | `dependency_missing(ai)`; no marker; no false success                                        | Result/log assertion               | automated        |
| O4  | Must     | Broken registration is visible            | Loader returns modules; constructor or registrar throws sentinel                                | Register                                           | `failed` contains sentinel; error diagnostic is not “not installed”                          | Result/log assertion               | automated        |
| O5  | Must     | Default capture policy is explicit        | Default LLM telemetry call                                                                      | Inspect event/span                                 | Input/output present by explicit policy; selected tags present                               | Span attributes                    | automated        |
| O6  | Must     | Unselected/secrets do not export          | Runtime context includes selected tags, unselected IDs, and sensitive provenance candidates     | Execute fake call                                  | Only selected sanitized tags appear; sensitive/unselected fields absent                      | Span attribute negative assertions | automated        |
| O7  | Need     | Non-AI preload survives                   | Subprocess/fixture without `ai` and `@ai-sdk/otel`, with required base instrumentation packages | Import preload                                     | Exit 0 and emit dependency-missing diagnostic                                                | Process result                     | automated        |
| D1  | Must     | Manifest owns static imports              | Parse `instrument.ts` imports and `package.json`                                                | Run dependency contract test                       | Every static runtime/type import is declared in the required category                        | Structured manifest assertion      | automated        |
| D2  | Must     | One physical identity passes              | Fixture contains multiple symlinks to one store realpath                                        | Run checker                                        | Exit 0                                                                                       | CLI result                         | automated        |
| D3  | Must     | Unscoped duplicate fails                  | Fixture contains two physical `zod` installs                                                    | Run checker                                        | Exit nonzero and list both identities                                                        | CLI result                         | automated        |
| D4  | Must     | Scoped nested duplicate fails             | Root and scoped-parent-nested `@ai-sdk/provider` use different realpaths                        | Run checker                                        | Exit nonzero and list both identities                                                        | CLI result                         | automated        |
| D5  | Must     | Same-version duplicate fails              | Two realpaths both report same package/version                                                  | Run checker                                        | Exit nonzero                                                                                 | CLI result                         | automated        |
| D6  | Need     | Multiple anchors are compared             | Root anchor and libs anchor each resolve different `ai` realpaths                               | Run with both `--anchor` values                    | Exit nonzero and attribute each path to its anchor                                           | CLI result                         | automated        |
| G1  | Must     | TS version matrix agrees                  | Exact TS6 and TS5.9.3 compilers installed deterministically                                     | Compile same project/fixtures                      | Both exit 0                                                                                  | CI jobs/commands                   | automated        |
| G2  | Need     | Full baseline remains green               | Clean standalone install                                                                        | Run lint, typecheck, full tests, diff check        | All commands exit 0; no old assertions deleted without mapping                               | CI artifacts                       | automated/review |

## 8. Implementation Slices

### Slice 1 - Canonical Type and File Boundaries

- Semantic owner: public TypeScript contract.
- Likely files:
  - `features/llm/clients/llm.class.ts`
  - `features/llm/clients/index.ts`
  - `features/llm/index.ts`
  - `features/llm/clients/llm.v7-contract.spec.ts`
  - new capture schema/spec near the existing LLM schema or replay owner
- Changes:
  - omit `prepareStep.system`;
  - add/export canonical result types;
  - declare explicit generic-preserving method returns;
  - remove replay fallback and validate v7 capture shape;
  - remove touched `any`.
- Tests: C1-C11.
- Failure eliminated: migration mistakes compile or validate at their source
  instead of becoming runtime ownership arbitration.

### Slice 2 - Shared Stream Lifecycle

- Semantic owner: managed-signal terminal state.
- Likely files:
  - `features/llm/clients/llm.class.ts`
  - new internal lifecycle helper and focused spec under
    `features/llm/clients/`
- Changes:
  - extract terminal coordinator;
  - separate event logging from terminal logging;
  - compose callbacks with `try/finally`;
  - attach fatal completion rejection to the once gate;
  - add generator `try/finally`.
- Tests: L1-L9 and U1.
- Failure eliminated: duplicate/early cleanup, swallowed internal finalization,
  and leaked generator resources.

### Slice 3 - OTel Registration and Privacy Contract

- Semantic owner: preload observability boundary.
- Likely files:
  - `instrument.ts`
  - `instrument-helpers.ts`
  - `instrument.spec.ts`
  - new `nest/src/boot/ai-sdk-otel.ts` and focused spec
- Changes:
  - make registration testable and status-bearing;
  - narrow missing-module detection;
  - keep process-global idempotency;
  - make capture policy explicit;
  - verify one real span and default field selection.
- Tests: O1-O7.
- Failure eliminated: silent registration failure, duplicate integrations, and
  implicit telemetry capture behavior.

### Slice 4 - Dependency Closure

- Semantic owner: install and source-compile reproducibility.
- Likely files:
  - `package.json`
  - `.gitignore`
  - `bun.lock`
  - new `scripts/check-dep-identity.ts`
  - new focused specs/fixtures
  - CI workflow
- Changes:
  - close static dependency declarations;
  - lock standalone verification;
  - implement recursive scoped-aware identity discovery;
  - add deterministic TS5.9.3 compiler support.
- Tests: D1-D6 and G1.
- Failure eliminated: standalone/consumer split reality and false-green shallow
  dependency scans.

### Slice 5 - Release Evidence

- Semantic owner: reviewer and consumer migration contract.
- Likely files:
  - this plan's completion ledger
  - migration/release notes
  - PR description and CI artifacts
- Changes:
  - record exact commands/results;
  - map every Must item to evidence;
  - state consumer atomic migration requirements;
  - do not modify consumer code.
- Tests: G2 and review checklist.
- Failure eliminated: declaring completion from a green suite that does not
  exercise the promised boundary.

## 9. Verification Commands

The implementation may add deterministic scripts, but the final evidence must
include equivalents of:

```bash
bun install --frozen-lockfile
bunx eslint . --no-fix --format stylish
bun run typecheck
bun run typecheck:ts59
bun run check:dep-identity -- --anchor .
bun test
git diff --check
```

The canonical contract is verified by compiler fixtures and structured tests,
not by a raw `rg system` gate. Raw text matching would incorrectly reject the
valid message role and the guard type that names a field solely to exclude it.

### Implementation Evidence (2026-07-16)

- `bun install --frozen-lockfile`: pass (`718` installs, `651` packages).
- `bun run lint`: pass; the command is read-only and no longer rewrites source.
- `bun run typecheck`: pass with the repository TypeScript 6 compiler.
- `bun run typecheck:ts59`: pass with exact TypeScript `5.9.3`.
- `bun run check:dep-identity -- --anchor .`: pass (`18` matching package
  installations, one physical identity per package name).
- `bun test`: `540` pass, `0` fail, `1133` assertions across `47` files.
- Prettier check over every touched source, test, workflow, manifest, and plan
  file: pass. The full-repository Prettier scan still reports six untouched
  baseline files and this PR does not rewrite them.
- No pre-existing test assertion was deleted. Direct native/proto-shaped
  assertions were retained or supplemented with public-boundary and adapter
  assertions.
- S1 and S3 remain explicit deferrals. They add migration or extension
  ergonomics and are not required for the fail-fast correctness invariant. S2
  is implemented and verified through the identity CLI subprocess fixture.

## 10. Review Checklist

- [x] Goal remains fail-fast discovery, not compatibility absorption.
- [x] No alias is accepted and converted at runtime.
- [x] Public input and output types reject every named deprecated spelling.
- [x] Tool and context generics survive through the returned result.
- [x] `onError` event semantics are not confused with terminal failure.
- [x] Caller callback failure cannot skip cleanup or terminal logging.
- [x] All library-owned stream/generator paths have deterministic finalization.
- [x] OTel absence and OTel failure are distinguishable.
- [x] Capture policy is explicit and verified at emitted span attributes.
- [x] Static imports have declared ownership.
- [x] Identity discovery enters scoped child packages before nested
      `node_modules`.
- [x] Same-version duplicate physical identities fail.
- [x] TS5.9.3 and TS6 run the same fixtures.
- [x] No consumer repository or product behavior entered the diff.
- [x] Existing tests were retained or have an explicit assertion mapping.

## 11. Definition of Done

This spec is complete only when:

1. Every Must Have item has passing automated evidence from Test Plan A.
2. Every Need Have item passes, or a reviewer explicitly identifies a concrete
   non-correctness reason for deferral before merge. N1, N2, N4, and N5 may not
   be deferred merely for schedule.
3. The public compile fixture proves deprecated fields fail and canonical
   generic usage succeeds under both compiler versions.
4. Lifecycle tests prove exact-once terminal cleanup/logging under callback
   failure and competing terminal signals.
5. OTel tests prove one registration and one span, with explicit selected-field
   behavior.
6. Dependency fixtures prove the scoped nested duplicate case is detected.
7. The repository is reproducible from its tracked lockfile and clean install.
8. Full lint, typecheck, and test suites pass.
9. The PR contains only libs changes and documents the separate consumer
   migration sequence.

## 12. Rollout and Rollback

### Rollout

1. Merge this canonical libs closure PR.
2. Synchronize the Calo fork in a separate operation after the canonical cut is
   green.
3. Migrate each consumer atomically: libs pointer/fork revision, exact AI SDK
   family, overrides, lockfile, source aliases, compile fixtures, and identity
   gate.
4. Do not advance a consumer pointer independently of its dependency and source
   migration.

### Rollback

Before any consumer advances, rollback is a normal revert of the libs closure
PR. After a consumer advances, rollback that consumer's complete atomic
migration. Do not restore compatibility aliases in libs as a rollback strategy.

## 13. TPDD Readiness Verdict

Verdict: implemented and TPDD-complete for review.

- Goal and non-goals are explicit.
- Current violations are evidence-backed.
- Boundary, lifecycle, output, observability, and dependency ownership are
  separated.
- Every Must and Need item has passing automated evidence.
- Failure and negative compile scenarios are first-class acceptance evidence.
- Consumer work is explicitly deferred and independently releasable.
- Optional S1 and S3 remain deferred without weakening the correctness
  contract; S2 is implemented with machine-readable CLI evidence.
- No product decision is required from the reviewer.
