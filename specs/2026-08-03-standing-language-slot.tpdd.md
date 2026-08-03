# Standing Language Slot TPDD

> Date: 2026-08-03
>
> Repository: `danielwii/nestjs-libs` (public)
>
> Delivery: feature PR → `main`
>
> Related: product-side adoption specs are maintained privately; this document
> is self-contained.

## 1. Goal Lock

### Goal

Give the dialogue `<language>` resolver one open intake point: an optional
**standing language passage** supplied by the consuming product, rendered into
the `<language>` block. Libs owns the slot and all ranking semantics; products
own everything about how the passage is produced.

### Non-goals

- no enum/typing of languages, no validation of the passage content;
- no knowledge of any product concept (profiles, families, settings);
- no change to the shipped resolver semantics (#37–#40);
- no change to the `system-output` language policy;
- no persistence, no lifecycle, no extraction.

### Success criteria

- with no standing passage, rendered output is byte-identical to today;
- with a passage, the `<language>` block renders it in the standing tier and
  the block's own text states that a standing request outranks dominance and
  the configured fallback;
- a language request in conversation is stated to stand from its turn on,
  whether or not a stored preference exists yet;
- all existing prompt tests stay green apart from expected-render updates.

## 2. Evidence and Root Cause

| Evidence | Consequence |
| --- | --- |
| A standing request in conversation history is honored 5/5; the same request rendered as a bullet inside a user-profile data block is ignored 0/5; as a direct imperative sentence it is honored 5/5 (live probes, 2026-08-03, gemini-3-flash) | language preference needs a directive carrier; libs should render a product-supplied imperative passage at the resolver point rather than leaving products to data-shaped bullets |
| Extraction into a stored artifact lags the request by 1–2 turns | the resolver must state that a conversational request stands from its turn on, without waiting for any stored preference |
| One product produces the passage from a static setting, another from typed extraction of explicit requests | the slot must be product-agnostic text, not a typed API |

## 3. Boundary Contract

### The slot

`PromptData` gains one optional field (working name `languageStanding`):

- type: `string | undefined` — a short product-written passage, rendered
  verbatim into the `<language>` block;
- absent → byte-identical render to today;
- libs never parses, rewrites, or interprets it.

### Producer contract (who fills it, how)

A field is only half a contract without a specified producer. Libs ships a
canonical formatter so "how to fill" has a standard answer while libs stays
product-agnostic:

```ts
renderStandingLanguagePreference('en')
// → "The user explicitly asked you to speak English with them — treat this as a standing request."
```

| Product shape | Source of truth | When filled |
| --- | --- | --- |
| typed artifact written only from explicit user requests | per-turn: read artifact → formatter → inject; omitted when no artifact |
| static language setting | per-turn: read setting → formatter → inject |
| any other mechanism | same shape |

Products MAY write their own passage text instead of using the formatter;
the contract is the slot, not the wording.

### Resolver text (dialogue policy, appended behavior)

When `languageStanding` is present, the `<language>` block additionally states
(owned by libs, not the product):

- the passage below is a standing explicit request: it takes precedence over
  the dominant language of the current message and over the configured
  fallback, until the user makes a new explicit request;
- a request made in conversation stands from that turn on, whether or not a
  stored preference exists yet.

The passage itself carries the fact (who asked for what); the block carries
the ranking. One resolver, no second authority.

### `languagePolicy` selection (context note)

The policy is chosen by the **caller per generation purpose**
(`PromptBuilder.language(lang, policy)`, default `'dialogue'`):
`dialogue` covers conversational replies (dominant/standing semantics);
`system-output` covers generated artifacts for storage/cards/UI (stable
configured language, no mirroring). No known call site passes `system-output`
today — everything runs the dialogue default. `languageStanding` applies to
the dialogue branch only.

### Output contract

No schema/persistence change. `system-output` policy untouched.

## 4. Development Promise

### Must Have

- [ ] M1: optional `languageStanding` field on `PromptData` + `PromptBuilder`
      chain pass-through.
- [ ] M2: `<language>` block renders the passage verbatim when present, plus
      the libs-owned standing-tier sentences (above).
- [ ] M3: the in-conversation-stands sentence is present in the dialogue
      instruction regardless of the slot.
- [ ] M4: canonical `renderStandingLanguagePreference(language)` formatter
      exported for product skills (optional to use).
- [ ] M5: `prompt.spec.ts` expected renders updated; new renders with the slot
      populated covered.

### Need Have

- [ ] N1: `bun run typecheck`, `bun test`, `bun run lint` green.
- [ ] N2: PR body uses only generic examples (public repo).

### Explicit deferrals

- any producer (extraction lanes, settings adapters) — product-side specs;
- passage content guidelines beyond one sentence of doc-comment.

## 5. Test Plan A

| ID | Priority | Given | When | Then | Evidence |
| --- | --- | --- | --- | --- | --- |
| L-M01 | Must | no standing passage | render | byte-identical to current expected renders | prompt.spec |
| L-M02 | Must | standing passage set | render | block contains passage verbatim + standing-tier sentences | prompt.spec |
| L-M03 | Must | any dialogue render | inspect | in-conversation-stands sentence present | prompt.spec |
| L-M04 | Must | system-output policy | render | unchanged | prompt.spec |

## 6. Minimal Implementation Slice

1. Add the optional field and pass-through.
2. Extend the dialogue language instruction construction for the two new
   sentence groups.
3. Add the canonical formatter export.
4. Update/add spec renders; run gates.

Anything beyond this slice returns to the plan for re-scoping.

## 7. Definition of Done

- diff limited to `utils/src/prompt.xml.ts`, `utils/src/prompt.spec.ts`, and
  the builder type surface for the new field + formatter;
- all gates green; Codex review clean;
- merge to `main` separately authorized.
