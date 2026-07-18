# TPDD Spec: Typed `validateModelSpec` + per-key Reasoning Policy

> Methodology: **Test Plan Driven Development**  
> Skill: `tpdd-test-plan-driven-development`  
> Status: **discussion draft** — no implementation commitment until Must/Need agreed  
> Repo: `danielwii/nestjs-libs` (`features/llm`)

## Evidence Checked

### Code (libs)

- `features/llm/types/model.types.ts`
  - `LLMModelKey = keyof LLMModelRegistry` (closed keys)
  - `LLMModelSpec = LLMModelKey | \`${LLMModelKey}?${string}\`` (`?` tail is free string)
  - `ModelConfig.reasoningRequired?: boolean` — “cannot disable reasoning”
  - `parseModelSpec` / `validateModelKey` / `validateLLMConfiguration`
  - `validateModelKey` today: registered + provider configured only (no reasoning policy)
  - Registry: `openrouter:minimax-m2.5`, `openrouter:kimi-k2-thinking`, step-3.5-flash free, etc. already `reasoningRequired: true`
  - **Gap:** `openrouter:gemini-3.5-flash` / `openrouter:google/gemini-3.5-flash` **not** marked `reasoningRequired`
  - `vertex:gemini-3.5-flash` registered without mandatory flag
- `features/llm/clients/llm.class.ts` `buildProviderOptions`
  - `thinking === 'none'` + `reasoningRequired` → **do not** send disable options
  - else → `disableThinkingOptions` (OpenRouter: `reasoning.effort: 'none'`)
- `features/llm/clients/llm.clients.ts` / `auto.client.ts` / `opts.presets.ts`
  - OpenRouter defaults / `noThinking` emit `effort: 'none'`
- `env` `@LLMModelField` + bootstrap `validateLLMConfiguration` (api mode): register + provider key only

### Live / external (2026-07-18)

- Live `generateObject` (mood-shaped):
  - `openrouter:gemini-3.5-flash` → **400** `Reasoning is mandatory for this endpoint and cannot be disabled`
  - `openrouter:gemini-3.5-flash?reason=low` → **OK**
  - `vertex:gemini-3.5-flash` (default / noThinking path) → **OK**
- OpenRouter public `GET /api/v1/models` for `google/gemini-3.5-flash`:
  ```json
  "reasoning": {
    "mandatory": true,
    "default_enabled": true,
    "supported_efforts": ["high", "medium", "low", "minimal"],
    "default_effort": "medium"
  }
  ```
  — **no `none`** in `supported_efforts`
- OpenRouter docs (Reasoning Tokens): when `mandatory: true`, do not send `effort: "none"` — model rejects it

### Related specs

- `specs/2026-07-10-llm-provider-namespaced-options.tpdd.md`
- `specs/2026-07-17-llm-bedrock-provider.tpdd.md` (reasoningRequired on some bedrock keys)
- Consumer symptom path (out of repo, evidence only): mood-analyze uses `APP_MOOD_ANALYZER_MODEL` defaulting to `openrouter:gemini-3.5-flash` + default noThinking → soft-fail calm

---

## Goal Lock

```text
Problem being solved:
  LLMModelKey/Spec selection can request thinking=none (framework default)
  against models whose gateway forbids disable (esp. OpenRouter mandatory
  reasoning). Failure appears only at first call (400), not at config time.
  Registry already has reasoningRequired for some keys but is incomplete and
  has no typed validation result / alternative suggestions.

Not solving:
  Silent auto-rewrite of provider (openrouter → vertex) at call time.
  Product-specific mood/chat business logic.
  Doppler / ExternalSecret / requiredEnvs process gates (separate).
  Full OpenRouter /models live sync in production request path.
  Exhaustive TypeScript typing of every legal `?query` combination.

Success criteria (mechanically checkable):
  1. Per-key reasoning policy is expressible on ModelConfig (at least
     mandatory/reasoningRequired + optional supportedEfforts + optional
     preferredAlternativeWhenDisabling).
  2. openrouter:gemini-3.5-flash (and google/ alias) is marked mandatory.
  3. validateModelSpec(spec, intent?) returns a typed discriminated union
     (ok | issues with codes + optional suggestions).
  4. Intent thinking=none + mandatory key → REASONING_DISABLE_FORBIDDEN
     with suggestion(s) including vertex twin when registered.
  5. buildProviderOptions continues: mandatory + none → no disable payload.
  6. Unit tests cover openrouter vs vertex 3.5-flash policy divergence.
  7. Optional CI: registry mandatory flags consistent with a frozen OR
     models fixture (or documented skip).

Primary anti-pattern:
  String heuristics on modelId ("gemini") instead of per-LLMModelKey policy;
  silent provider switch without explicit fallback chain.
```

---

## Business Invariant

**Whether a model call may disable reasoning is a property of the registered LLMModelKey (gateway + model), not of the bare upstream model name. Invalid disable intent must be detectable before/at option build, with typed issues and optional alternative keys—never by guessing at call sites.**

---

## TPDD Development Promise

### Goal

Add a **typed model-spec validation layer** on top of `LLMModelKey` / `parseModelSpec` that:

1. Encodes per-key **reasoning policy** in the registry  
2. Exposes `validateModelSpec` with a **discriminated union** result  
3. Surfaces **actionable suggestions** (e.g. same capability on vertex, or `?reason=low`) when OpenRouter-style mandatory reasoning forbids disable  
4. Keeps **runtime option build** consistent (no illegal `effort: none`)

### Non-goals

- Do not auto-route openrouter → vertex inside `LLM.generate*` without explicit `fallback=` / app policy  
- Do not require network to OpenRouter on every request  
- Do not make all `@LLMModelField` misconfigurations hard-fail in production without explicit mode (dev can be stricter)  
- Do not redesign `LLMModelSpec` string grammar beyond validating known params  
- Do not implement consumer mood default env change in this libs PR (consumer may follow)

### Must Have — Critical Check Points

- [ ] `ModelConfig` documents and supports reasoning policy:
  - Keep `reasoningRequired?: boolean` as shorthand / compat (`true` ⇔ mandatory)
  - Add optional structured `reasoning?: ModelReasoningPolicy` **or** derive policy only from `reasoningRequired` + optional fields in Must v1
- [ ] Register `openrouter:gemini-3.5-flash` and `openrouter:google/gemini-3.5-flash` with `reasoningRequired: true` (mandatory)
- [ ] `validateModelSpec(spec, options?: { thinking?: ThinkingEffort }) → ModelSpecValidation` typed union:
  - `ok: true` + `parsed` + `warnings[]`
  - `ok: false` + `issues[]` with `code` + `message` + optional `suggestions?: LLMModelSpec[]`
- [ ] Issue code `REASONING_DISABLE_FORBIDDEN` when effective thinking is `none` (default intent or `reason=none`) and key is mandatory
- [ ] Suggestions for that case include at least one of:
  - registered vertex twin key if present (`vertex:gemini-3.5-flash` for 3.5-flash OR case)
  - and/or same openrouter key with `?reason=low` (or `defaultEffort` if set)
- [ ] `buildProviderOptions`: mandatory + thinking none still sends **no** disable payload (existing behavior once flag set)
- [ ] Unit tests: openrouter 3.5-flash disable forbidden; vertex 3.5-flash disable allowed; `?reason=low` ok on openrouter

### Need Have — Important Check Points

- [ ] `REASONING_EFFORT_UNSUPPORTED` when `reason=` not in `supportedEfforts` (if field present); warn + clamp **or** fail (pick one in discussion — see Open Questions)
- [ ] Wire into `validateModelKey` **or** replace call sites so configuration validation reuses the same codes (backward-compatible wrapper OK)
- [ ] `validateLLMConfiguration` emits **warnings** (not necessarily errors) for `@LLMModelField` values that would default-noThinking against mandatory keys
- [ ] Log once / warning text mentions alternative key when available
- [ ] Type export: `ModelSpecValidation`, `ModelSpecIssueCode` from public llm surface

### Should Have — Optional Check Points

- [ ] `ModelReasoningPolicy.supportedEfforts` / `defaultEffort` / `preferredAlternativeWhenDisabling` fully populated for openrouter 3.5-flash from OR fixture
- [ ] CI script: compare registry mandatory flags vs frozen OpenRouter `/models` JSON fixture for registered openrouter google/* keys
- [ ] `assertModelSpec(spec): asserts` helper for CLI/boot hard gate
- [ ] Live smoke script (opt-in, not CI): openrouter plain fail / reason=low pass / vertex plain pass

### Explicit Deferrals

- Silent auto-failover openrouter → vertex  
- Full branded TypeScript type for every legal query string  
- Live fetch OR models API in request hot path  
- Consumer default `APP_MOOD_ANALYZER_MODEL` change  
- Bedrock / Anthropic policy expansion beyond existing reasoningRequired usage  

### Definition Of Done

- All Must boxes checked; every Must Test Plan A row passes automated tests  
- `bun test` green for llm model/types + option build suites  
- `tsc --noEmit` green  
- Discussion Open Questions either resolved in this PR or listed under Explicit Deferrals  

---

## Consumer Chain

```text
Final consumer: operator / app config (env, DB-backed model field, call site)
  ← “can I use this model with noThinking / reason=X?” (answer before first token)
  ← validateModelSpec(spec, { thinking })
  ← ModelSpecValidation (typed ok | issues + suggestions)
  ← parseModelSpec + getModel(key).reasoning* policy
  ← LLMModelRegistry entry per LLMModelKey
  ← producers: env DEFAULT_*/APP_*_MODEL, call-site LLMModelSpec, optional CI fixture from OR /models
```

### Boundary

- **In:** string or `LLMModelSpec` + optional intent (`thinking`)  
- **Out:** structured validation; must not throw for soft validation API (assert* may throw)  
- **Must not:** mutate global registry; must not switch provider silently  

Verification: pure unit tests, no network.

### Normalization

- Strip query → base key; parse `reason` → ThinkingEffort  
- Effective thinking: explicit `reason` / intent, else framework default `none` for validate-of-default-path  
- `reasoningRequired === true` treated as `mandatory` if structured policy absent  

Verification: table-driven parse + validate cases.

### Business Logic

- Policy lookup by **LLMModelKey only** (not modelId substring)  
- Same upstream model on different providers may differ (openrouter vs vertex)  
- Suggestions are advisory keys already in registry  

Verification: openrouter vs vertex 3.5-flash divergence tests.

### Output Contract

- Discriminated union `ModelSpecValidation`  
- Stable issue codes (string union type)  
- `suggestions` only contain registered specs (or well-formed `key?reason=`)  

Verification: type tests + unit equality on codes.

### Observability

- Warnings via existing logger when configuration validation finds mandatory+default-none  
- No secret material in messages  

Verification: spy/logger tests if pattern exists; else message content asserts.

---

## Test Plan A

| ID | Priority | Scenario | Setup / Given | Trigger / When | Expected / Then | Evidence | Automation |
|---|---|---|---|---|---|---|---|
| M1 | Must | OR 3.5-flash marked mandatory | registry after change | `getModel('openrouter:gemini-3.5-flash').reasoningRequired` | `true` | unit | automated |
| M2 | Must | Disable forbidden on OR 3.5-flash | key registered mandatory | `validateModelSpec('openrouter:gemini-3.5-flash', { thinking: 'none' })` | `ok:false`, code `REASONING_DISABLE_FORBIDDEN` | unit | automated |
| M3 | Must | Suggestions include vertex twin and/or reason=low | vertex key registered | same as M2 | `suggestions` includes `vertex:gemini-3.5-flash` and/or `...?reason=low` | unit | automated |
| M4 | Must | reason=low allowed on OR 3.5-flash | mandatory key | `validateModelSpec('openrouter:gemini-3.5-flash?reason=low')` | `ok:true` | unit | automated |
| M5 | Must | Vertex 3.5-flash allows disable | vertex key not mandatory | `validateModelSpec('vertex:gemini-3.5-flash', { thinking: 'none' })` | `ok:true` | unit | automated |
| M6 | Must | Option build skips disable when mandatory | spy/capture providerOptions | `buildProviderOptions` / LLM path with thinking none + mandatory key | no `effort: 'none'` / no disable thinking payload | unit (existing M12 style) | automated |
| M7 | Must | Alias key same policy | `openrouter:google/gemini-3.5-flash` | M2-style validate | same as M1/M2 | unit | automated |
| N1 | Need | Unsupported effort | supportedEfforts set without `xhigh` | `?reason=xhigh` | issue or clamp per agreed policy | unit | automated |
| N2 | Need | validateLLMConfiguration warns | SysEnv field with OR 3.5-flash | `validateLLMConfiguration()` | warning mentions mandatory / suggestion | unit | automated |
| N3 | Need | Unknown model still fails | unregistered key | validateModelSpec | `UNKNOWN_MODEL` | unit | automated |
| N4 | Need | Provider not configured | mandatory key, no API key | validateModelKey / validateModelSpec | `PROVIDER_NOT_CONFIGURED` (or existing error text preserved) | unit | automated |
| S1 | Should | CI fixture vs OR metadata | frozen models JSON | script | mandatory flags match for registered google/* openrouter keys | script test | automated-optional |
| S2 | Should | Live smoke | real keys | plain OR fail / reason=low pass / vertex pass | matches policy | live script | live-smoke |

---

## Implementation Slices

### Slice 1 — Registry truth (OR 3.5-flash)

Semantic owner: model identity / gateway policy  

Likely files:

- `features/llm/types/model.types.ts` (registry entries for openrouter 3.5-flash ± google/ alias)

Tests: M1, M7  

Failure mode eliminated: missing `reasoningRequired` while OR mandatory.

### Slice 2 — Typed validateModelSpec

Semantic owner: boundary validation  

Likely files:

- `features/llm/types/model.types.ts` (types + `validateModelSpec`)  
- `features/llm/types/model.types.spec.ts`  
- exports from `features/llm/index.ts` if needed  

Tests: M2–M5, N3  

Failure mode eliminated: no structured way to detect disable-forbidden before call.

### Slice 3 — Option build + config validation integration

Semantic owner: call path + boot config  

Likely files:

- `llm.class.ts` (ensure uses flag; optional call validate)  
- `validateModelKey` / `validateLLMConfiguration`  

Tests: M6, N2, N4  

Failure mode eliminated: config fields silently point at broken default-noThinking combos.

### Slice 4 — Policy richness + CI (optional)

Semantic owner: long-term hygiene  

- `ModelReasoningPolicy` full fields  
- frozen OR fixture check  

Tests: N1, S1, S2  

---

## Open Questions (for discussion)

1. **Default thinking intent for validate**  
   When `validateModelSpec(spec)` is called **without** `{ thinking }`, should we assume framework default `none` (catch mood/default path) or only validate explicit `?reason=`?  
   - **Proposal:** assume `none` for configuration validation (`validateLLMConfiguration`); call-site validate passes explicit intent.

2. **Unsupported effort: fail vs clamp**  
   - Fail: stricter, clearer for TPDD  
   - Clamp + warning: closer to OpenRouter “nearest level” behavior  
   - **Proposal:** Need = warning + clamp for runtime parse; Must validate can still report `REASONING_EFFORT_UNSUPPORTED` as warning not hard error.

3. **`preferredAlternativeWhenDisabling` population**  
   Manual twin map (openrouter:X → vertex:X) vs naming convention?  
   - **Proposal:** explicit field on registry for known twins; no magic rename.

4. **Hard error vs warning in production `validateLLMConfiguration`**  
   - **Proposal:** warnings only in Must; apps may promote to error via their own boot policy.

5. **Scope of mandatory backfill**  
   Only gemini-3.5-flash OR keys in this PR, or all openrouter keys with `reasoning.mandatory` in fixture?  
   - **Proposal:** Must = 3.5-flash (+ alias); Should = fixture-driven list.

6. **Compat**  
   Keep `reasoningRequired` forever vs migrate to `reasoning.mandatory` only?  
   - **Proposal:** both; `reasoningRequired` remains source of truth if structured block absent.

---

## Definition Of Done (discussion exit)

This draft is **TPDD-complete for planning** when:

- Goal / non-goals / invariant agreed  
- Open Questions 1–2 answered  
- Must Test Plan A accepted  

Implementation starts only after that; first red tests = M2/M5 against current registry (M2 should **fail today** because flag missing / no validate API).

---

## TPDD Self-Review Checklist

| Check | Status |
|---|---|
| Goal explicit and evidence-backed | ✅ live + OR API + code |
| Consumer chain complete | ✅ |
| Must / Need / Should present | ✅ |
| Every Must has Test Plan A row | ✅ M1–M7 |
| Negative/failure scenarios | ✅ M2, N3 |
| Manual/live separated | ✅ S2 live-smoke |
| Contract/boundary named | ✅ registry + validateModelSpec |
| Deferrals explicit | ✅ silent failover, full query typing |
| Another engineer can implement without product decisions | ⚠️ after Open Questions 1–2 |

## Discussion Prompt

Please decide:

1. validate without intent → assume `thinking=none`? (Proposal: yes for config validation)  
2. unsupported effort → warn+clamp vs hard fail? (Proposal: warn+clamp runtime; issue as warning)  
3. Must scope = only OR gemini-3.5-flash this PR? (Proposal: yes)  

Once agreed, implementation order: Slice 1 → 2 → 3.
