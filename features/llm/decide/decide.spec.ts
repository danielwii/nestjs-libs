import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';

import { LLM } from '../clients/llm.class';
import { getCostFromUsage } from '../utils/cost-calculator';
import { D } from './d';
import { setDecideFetcherForTest } from './decide.client';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { DecideParams, ScoreAnswer } from './decide.types';

describe('LLM.decide & LLM.safeDecide + D.* Polymorphic Decision Engine', () => {
  const prevTypeSafeKey = SysEnv.AI_TYPESAFE_API_KEY;
  const prevGoogleKey = SysEnv.AI_GOOGLE_API_KEY;
  const prevOpenAIKey = SysEnv.AI_OPENAI_API_KEY;

  beforeEach(() => {
    SysEnv.AI_TYPESAFE_API_KEY = 'ts-test-key';
    SysEnv.AI_GOOGLE_API_KEY = 'google-test-key';
    SysEnv.AI_OPENAI_API_KEY = 'openai-test-key';
  });

  afterEach(() => {
    setDecideFetcherForTest(null);
    SysEnv.AI_TYPESAFE_API_KEY = prevTypeSafeKey;
    SysEnv.AI_GOOGLE_API_KEY = prevGoogleKey;
    SysEnv.AI_OPENAI_API_KEY = prevOpenAIKey;
  });

  it('compiles TypeSafe (typesafe:jev-1.14.0) wire request with multimodal assets, headers, and normalizes noul/choice/score/box answers + cost', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    setDecideFetcherForTest((async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          model: 'jev-1.14.0',
          answers: {
            isInvoice: { type: 'noul', noul: 0.94 },
            route: {
              type: 'choice',
              choice: 'billing',
              probabilities: { billing: 0.82, tech: 0.12, sales: 0.06 },
              confidence: 0.82,
            },
            urgency: {
              type: 'score',
              score: 1.7,
              probabilities: { '0': 0.05, '1': 0.2, '2': 0.75 },
              confidence: 0.75,
            },
            totalAmountBox: {
              type: 'box',
              box: { top: 0.12, bottom: 0.18, left: 0.65, right: 0.88 },
              confidence: 0.91,
            },
          },
          usage: { input_tokens: 2000 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch);

    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    const result = await LLM.decide({
      id: 'ts-multimodal-test',
      model: 'typesafe:jev-1.14.0',
      input: [
        D.text('Inspect the attached receipt image:'),
        D.image(pngBytes, { mediaType: 'image/png', key: 'receipt_img' }),
      ],
      questions: {
        isInvoice: D.noul('Is this document an invoice?', {
          yes: 'Contains line items and total due',
          no: 'General correspondence',
        }),
        route: D.choice('Which department owns this?', {
          billing: {
            description: 'Invoices and payment issues',
            notFor: 'API bugs',
            examples: ['Refund request'],
          },
          tech: 'Technical troubleshooting',
          sales: null,
        }),
        urgency: D.score('Rate urgency from 0 to 2', ['Low', 'Medium', 'Critical']),
        totalAmountBox: D.box('Locate the total due amount on the receipt'),
      },
      providerOptions: {
        typesafe: { longContext: true },
      },
    });

    expect(capturedUrl).toBe('https://api.typesafe.ai/v1/systemone');
    expect(capturedHeaders['Authorization']).toBe('Bearer ts-test-key');
    expect(capturedHeaders['TypeSafe-Danger-Zone-Images']).toBe('true');
    expect(capturedHeaders['TypeSafe-Danger-Zone-Long-Context']).toBe('true');

    expect(capturedBody).toEqual({
      model: 'jev-1.14.0',
      state: 'Inspect the attached receipt image:\n<asset:receipt_img>',
      assets: {
        receipt_img: `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`,
      },
      questions: {
        isInvoice: {
          type: 'noul',
          instructions: 'Is this document an invoice?',
          criteria: {
            true: 'Contains line items and total due',
            false: 'General correspondence',
          },
        },
        route: {
          type: 'choice',
          instructions: 'Which department owns this?',
          criteria: {
            billing: {
              description: 'Invoices and payment issues',
              not_for: 'API bugs',
              examples: ['Refund request'],
            },
            tech: 'Technical troubleshooting',
            sales: null,
          },
        },
        urgency: {
          type: 'score',
          instructions: 'Rate urgency from 0 to 2',
          criteria: ['Low', 'Medium', 'Critical'],
        },
        totalAmountBox: {
          type: 'box',
          instructions: 'Locate the total due amount on the receipt',
        },
      },
    });

    expect(result.model).toBe('jev-1.14.0');
    expect(result.answers.isInvoice).toEqual({
      type: 'noul',
      probability: 0.94,
    });
    expect(result.answers.route.type).toBe('choice');
    expect(result.answers.route.choice).toBe('billing');
    expect(result.answers.route.topProbability).toBeCloseTo(0.82, 6);
    expect(result.answers.route.margin).toBeCloseTo(0.7, 6);

    expect(result.answers.urgency).toEqual({
      type: 'score',
      score: 1.7,
      normalizedScore: 0.85,
      probabilities: [0.05, 0.2, 0.75],
    });

    // Verify JSON round-trip preserves exact ScoreAnswer shape (readonly number[], no stringified keys)
    const roundTripped = JSON.parse(JSON.stringify(result.answers.urgency)) as ScoreAnswer;
    expect(roundTripped).toEqual(result.answers.urgency);
    expect(Array.isArray(roundTripped.probabilities)).toBe(true);

    expect(result.answers.totalAmountBox).toEqual({
      type: 'box',
      box: { top: 0.12, bottom: 0.18, left: 0.65, right: 0.88 },
      confidence: 0.91,
    });

    // 2000 tokens * $0.05 / 1M = $0.0001
    expect(result.usage.inputTokens).toBe(2000);
    expect(result.usage.outputTokens).toBe(0);
    expect(result.usage.cost).toBeCloseTo(0.0001, 8);
  });

  it('compiles Google (google:gemini-decision-1) wire request with PDF + fileUri parts, strips symmetric confidence on noul, and bills cached tokens at $0.006/1M', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    setDecideFetcherForTest((async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          model: 'gemini-decision-1',
          answers: {
            hasSignature: {
              type: 'noul',
              noul: 0.88,
              confidence: 0.76, // Symmetric 2 * |0.88 - 0.5| — must be stripped
            },
            docType: {
              type: 'choice',
              choice: 'contract',
              probabilities: { contract: 0.75, nda: 0.2, invoice: 0.05 },
              confidence: 0.75,
            },
            quality: {
              type: 'score',
              score: 2.4,
              probabilities: [0.0, 0.1, 0.4, 0.5],
              confidence: 0.5,
            },
          },
          usage: {
            total_input_tokens: 10_000,
            total_cached_tokens: 6_000,
            total_tokens: 10_000,
            total_output_tokens: 0,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch);

    const pdfBytes = Buffer.from('%PDF-1.7 fake content');
    const result = await LLM.decide({
      id: 'google-multimodal-test',
      model: 'google:gemini-decision-1',
      input: [
        D.text('Verify contract execution status:'),
        D.pdf(pdfBytes, { resolution: 'high' }),
        D.fileUri('gs://corp-contracts/annex-a.mp4', {
          mediaType: 'video/mp4',
          resolution: 'low',
        }),
      ],
      questions: {
        hasSignature: D.noul('Is the contract signed by both parties?', {
          yes: 'Both signature blocks contain ink or digital signatures',
          no: 'One or both signature blocks are blank',
        }),
        docType: D.choice('Classify document type', ['contract', 'nda', 'invoice'] as const),
        quality: D.score('Scan legibility', ['Unreadable', 'Poor', 'Good', 'Crisp']),
      },
    });

    expect(capturedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/decisions');
    expect(capturedHeaders['x-goog-api-key']).toBe('google-test-key');
    expect(capturedBody).toEqual({
      model: 'gemini-decision-1',
      input: [
        { text: 'Verify contract execution status:' },
        {
          inline_data: {
            mime_type: 'application/pdf',
            data: pdfBytes.toString('base64'),
          },
          media_resolution: 'high',
        },
        {
          file_data: {
            mime_type: 'video/mp4',
            file_uri: 'gs://corp-contracts/annex-a.mp4',
          },
          media_resolution: 'low',
        },
      ],
      questions: {
        hasSignature: {
          type: 'noul',
          instructions:
            'Is the contract signed by both parties?\nCriteria for YES (true): Both signature blocks contain ink or digital signatures\nCriteria for NO (false): One or both signature blocks are blank',
        },
        docType: {
          type: 'choice',
          instructions: 'Classify document type',
          criteria: { contract: '', nda: '', invoice: '' },
        },
        quality: {
          type: 'score',
          instructions: 'Scan legibility',
          criteria: ['Unreadable', 'Poor', 'Good', 'Crisp'],
        },
      },
    });

    // Verify symmetric `confidence` is stripped from NoulAnswer
    expect(result.answers.hasSignature).toEqual({
      type: 'noul',
      probability: 0.88,
    });
    expect('confidence' in result.answers.hasSignature).toBe(false);

    expect(result.answers.docType.choice).toBe('contract');
    expect(result.answers.docType.topProbability).toBeCloseTo(0.75, 6);
    expect(result.answers.docType.margin).toBeCloseTo(0.55, 6);

    expect(result.answers.quality).toEqual({
      type: 'score',
      score: 2.4,
      normalizedScore: 0.8,
      probabilities: [0.0, 0.1, 0.4, 0.5],
    });

    // 4000 uncached * $0.06/1M ($0.00024) + 6000 cached * $0.006/1M ($0.000036) = $0.000276
    expect(result.usage.inputTokens).toBe(10_000);
    expect(result.usage.inputTokenDetails?.noCacheTokens).toBe(4_000);
    expect(result.usage.inputTokenDetails?.cacheReadTokens).toBe(6_000);
    expect(result.usage.cost).toBeCloseTo(0.000276, 8);
  });

  it('compiles OpenAI (openai:gpt-6-luna) Record questions into named predicate/choice/score array, re-indexes answers, and bills cached tokens at $0.01/1M', async () => {
    let capturedBody: Record<string, unknown> = {};

    setDecideFetcherForTest((async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          id: 'dec_123',
          model: 'gpt-6-luna-2026-10',
          answers: [
            {
              type: 'predicate',
              name: 'needsEscalation',
              probability: 0.15,
            },
            {
              type: 'choice',
              name: 'intent',
              choice: 'refund',
              probabilities: [
                { value: 'refund', probability: 0.6 },
                { value: 'exchange', probability: 0.35 },
                { value: 'cancel', probability: 0.05 },
              ],
              confidence: 0.6,
            },
            {
              type: 'score',
              name: 'sentiment',
              score: 0.5,
              probabilities: [
                { value: 0, label: '0', probability: 0.6 },
                { value: 1, label: '1', probability: 0.3 },
                { value: 2, label: '2', probability: 0.1 },
              ],
              confidence: 0.6,
            },
          ],
          usage: {
            input_tokens: 5_000,
            input_tokens_details: { cached_tokens: 2_000 },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch);

    const safeResult = await LLM.safeDecide({
      id: 'openai-test',
      model: 'openai:gpt-6-luna',
      input: { customerId: 'cust_42', message: 'I want my money back' },
      questions: {
        needsEscalation: D.noul('Does this message threaten legal action?'),
        intent: D.choice('Primary customer intent', {
          refund: 'Wants money returned',
          exchange: 'Wants replacement item',
          cancel: null,
        }),
        sentiment: D.score('Customer satisfaction', ['Angry', 'Neutral', 'Happy']),
      },
    });

    expect(safeResult.isOk()).toBe(true);
    const result = safeResult._unsafeUnwrap();

    expect(capturedBody).toEqual({
      model: 'gpt-6-luna',
      input: JSON.stringify({ customerId: 'cust_42', message: 'I want my money back' }),
      questions: [
        {
          type: 'predicate',
          name: 'needsEscalation',
          instructions: 'Does this message threaten legal action?',
        },
        {
          type: 'choice',
          name: 'intent',
          instructions: 'Primary customer intent',
          choices: [
            { value: 'refund', description: 'Wants money returned' },
            { value: 'exchange', description: 'Wants replacement item' },
            { value: 'cancel' },
          ],
        },
        {
          type: 'score',
          name: 'sentiment',
          instructions: 'Customer satisfaction',
          levels: [
            { label: '0', description: 'Angry' },
            { label: '1', description: 'Neutral' },
            { label: '2', description: 'Happy' },
          ],
        },
      ],
    });

    expect(result.answers.needsEscalation).toEqual({
      type: 'noul',
      probability: 0.15,
    });
    expect(result.answers.intent).toEqual({
      type: 'choice',
      choice: 'refund',
      probabilities: { refund: 0.6, exchange: 0.35, cancel: 0.05 },
      topProbability: 0.6,
      margin: 0.25,
    });
    expect(result.answers.sentiment).toEqual({
      type: 'score',
      score: 0.5,
      normalizedScore: 0.25,
      probabilities: [0.6, 0.3, 0.1],
    });

    // 3000 uncached * $0.10/1M ($0.0003) + 2000 cached * $0.01/1M ($0.00002) = $0.00032
    expect(result.usage.cost).toBeCloseTo(0.00032, 8);
  });

  it('evaluates polarity-neutral D.band and D.choiceBand thresholds and rejects invalid thresholds', () => {
    expect(D.band({ probability: 0.12 }, { low: 0.2, high: 0.8 })).toBe('low');
    expect(D.band({ probability: 0.5 }, { low: 0.2, high: 0.8 })).toBe('abstain');
    expect(D.band({ probability: 0.8 }, { low: 0.2, high: 0.8 })).toBe('high');
    expect(D.band({ normalizedScore: 0.9 }, { low: 0.3, high: 0.75 })).toBe('high');
    expect(D.band(0.05, { low: 0.1, high: 0.9 })).toBe('low');

    expect(() => D.band(0.5, { low: 0.8, high: 0.2 })).toThrow(Oops.Block);

    expect(D.choiceBand({ topProbability: 0.72, margin: 0.35 }, { minProbability: 0.7, minMargin: 0.2 })).toBe(
      'confident',
    );
    expect(D.choiceBand({ topProbability: 0.72, margin: 0.12 }, { minProbability: 0.7, minMargin: 0.2 })).toBe(
      'abstain',
    );
  });

  it('classifies HTTP 402/429 as RateLimited, Google HTTP 400 SAFETY as AI03 Block, invalid HTTP 400 as GN01 Validation, and OpenAI refusal as AI03 Block via safeDecide', async () => {
    // 1. TypeSafe HTTP 402 quota exhausted -> AIModelRateLimited (AI02)
    setDecideFetcherForTest(
      async () =>
        new Response(JSON.stringify({ message: 'Insufficient credits' }), {
          status: 402,
        }),
    );

    const quotaRes = await LLM.safeDecide({
      id: 'err-402',
      model: 'typesafe:jev-1.14.0',
      input: 'hello',
      questions: { q: D.noul('test') },
    });
    expect(quotaRes.isErr()).toBe(true);
    const quotaErr = quotaRes._unsafeUnwrapErr();
    expect(quotaErr).toBeInstanceOf(Oops.Block);
    expect(quotaErr.oopsCode).toBe('AI02');
    expect(quotaErr.httpStatus).toBe(429);

    // 2. Google HTTP 400 structured SAFETY block -> AI03 Block
    setDecideFetcherForTest(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              status: 'INVALID_ARGUMENT',
              message: 'Request blocked by SAFETY filter',
              details: [{ reason: 'SAFETY' }],
            },
          }),
          { status: 400 },
        ),
    );

    const safetyRes = await LLM.safeDecide({
      id: 'err-google-safety',
      model: 'google:gemini-decision-1',
      input: 'test',
      questions: { q: D.noul('test') },
    });
    expect(safetyRes.isErr()).toBe(true);
    expect(safetyRes._unsafeUnwrapErr().oopsCode).toBe('AI03');

    // 2b. HTTP 400 with free-text 'safety' in validation message (F2 regression) -> GN01 Validation (NOT AI03)
    setDecideFetcherForTest(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              status: 'INVALID_ARGUMENT',
              message: "Invalid schema for question 'safety': options must be non-empty",
            },
          }),
          { status: 400 },
        ),
    );

    const freeTextSafetyRes = await LLM.safeDecide({
      id: 'err-google-validation-with-safety-word',
      model: 'google:gemini-decision-1',
      input: 'test',
      questions: { safety: D.noul('test') },
    });
    expect(freeTextSafetyRes.isErr()).toBe(true);
    expect(freeTextSafetyRes._unsafeUnwrapErr().oopsCode).toBe('GN01');

    // 2c. OpenAI HTTP 400 structured content_policy_violation code -> AI03 Block
    setDecideFetcherForTest(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'content_policy_violation',
              type: 'invalid_request_error',
              message: 'Blocked by policy',
            },
          }),
          { status: 400 },
        ),
    );

    const openaiPolicyRes = await LLM.safeDecide({
      id: 'err-openai-policy-code',
      model: 'openai:gpt-6-luna',
      input: 'test',
      questions: { q: D.noul('test') },
    });
    expect(openaiPolicyRes.isErr()).toBe(true);
    expect(openaiPolicyRes._unsafeUnwrapErr().oopsCode).toBe('AI03');

    // 3. Google HTTP 400 malformed schema -> GN01 Validation
    setDecideFetcherForTest(
      async () =>
        new Response(
          JSON.stringify({
            error: { status: 'INVALID_ARGUMENT', message: 'questions field is malformed' },
          }),
          { status: 400 },
        ),
    );

    const validationRes = await LLM.safeDecide({
      id: 'err-google-validation',
      model: 'google:gemini-decision-1',
      input: 'test',
      questions: { q: D.noul('test') },
    });
    expect(validationRes.isErr()).toBe(true);
    expect(validationRes._unsafeUnwrapErr().oopsCode).toBe('GN01');

    // 4. OpenAI refusal item -> AI03 Block (and LLM.decide throws it)
    setDecideFetcherForTest(
      async () =>
        new Response(
          JSON.stringify({
            model: 'gpt-6-luna',
            answers: [{ type: 'refusal', name: 'q', reason: 'Policy violation' }],
            usage: { input_tokens: 10 },
          }),
          { status: 200 },
        ),
    );

    const refusalRes = await LLM.safeDecide({
      id: 'err-openai-refusal',
      model: 'openai:gpt-6-luna',
      input: 'test',
      questions: { q: D.noul('test') },
    });
    expect(refusalRes.isErr()).toBe(true);
    expect(refusalRes._unsafeUnwrapErr().oopsCode).toBe('AI03');

    await expect(
      LLM.decide({
        id: 'err-openai-refusal-throw',
        model: 'openai:gpt-6-luna',
        input: 'test',
        questions: { q: D.noul('test') },
      }),
    ).rejects.toMatchObject({ oopsCode: 'AI03' });
  });

  it('fails fast with Oops.Panic.ExternalService (GN10) when upstream decision answers are malformed or missing probability fields (F3)', async () => {
    // 1. Missing probability on noul answer
    setDecideFetcherForTest(
      async () =>
        new Response(
          JSON.stringify({
            model: 'jev-1.14.0',
            answers: { q: {} },
            usage: { input_tokens: 10 },
          }),
          { status: 200 },
        ),
    );

    const missingNoulRes = await LLM.safeDecide({
      id: 'err-f3-missing-noul',
      model: 'typesafe:jev-1.14.0',
      input: 'test',
      questions: { q: D.noul('test') },
    });
    expect(missingNoulRes.isErr()).toBe(true);
    expect(missingNoulRes._unsafeUnwrapErr().oopsCode).toBe('GN10');

    // 2. Missing probabilities map on choice answer
    setDecideFetcherForTest(
      async () =>
        new Response(
          JSON.stringify({
            model: 'jev-1.14.0',
            answers: { c: { choice: 'a' } },
            usage: { input_tokens: 10 },
          }),
          { status: 200 },
        ),
    );

    const missingChoiceProbsRes = await LLM.safeDecide({
      id: 'err-f3-missing-choice-probs',
      model: 'typesafe:jev-1.14.0',
      input: 'test',
      questions: { c: D.choice('pick', ['a', 'b'] as const) },
    });
    expect(missingChoiceProbsRes.isErr()).toBe(true);
    expect(missingChoiceProbsRes._unsafeUnwrapErr().oopsCode).toBe('GN10');

    // 3. Missing score level in probabilities map on score answer
    setDecideFetcherForTest(
      async () =>
        new Response(
          JSON.stringify({
            model: 'jev-1.14.0',
            answers: { s: { score: 1, probabilities: { '0': 0.5 } } },
            usage: { input_tokens: 10 },
          }),
          { status: 200 },
        ),
    );

    const missingScoreLevelRes = await LLM.safeDecide({
      id: 'err-f3-missing-score-level',
      model: 'typesafe:jev-1.14.0',
      input: 'test',
      questions: { s: D.score('rate', ['low', 'high'] as const) },
    });
    expect(missingScoreLevelRes.isErr()).toBe(true);
    expect(missingScoreLevelRes._unsafeUnwrapErr().oopsCode).toBe('GN10');
  });

  it('disambiguates domain JSON arrays with type="text" or type="file" from branded D.* multimodal parts (F4 / #4549863171)', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    setDecideFetcherForTest(async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: 'gemini-decision-1',
          answers: { ok: { probability: 0.9 } },
          usage_metadata: { prompt_token_count: 12 },
        }),
        { status: 200 },
      );
    });

    // 1. Domain JSON array starting with { type: 'file', id: 'doc_1' } on Google must be JSON-serialized as input string
    const domainFileArray = [{ type: 'file', id: 'doc_1' }];
    await LLM.decide({
      id: 'f4-domain-file-array',
      model: 'google:gemini-decision-1',
      input: domainFileArray,
      questions: { ok: D.noul('is valid?') },
    });
    expect(capturedBody?.input).toBe(JSON.stringify(domainFileArray));

    // 2. Mixed JSON array [{ type: 'text', text: 'x' }, { type: 'event', value: 1 }] on TypeSafe must be passed as state without assets
    const mixedDomainArray = [
      { type: 'text', text: 'x' },
      { type: 'event', value: 1 },
    ];
    await LLM.decide({
      id: 'f4-mixed-domain-array',
      model: 'typesafe:jev-1.14.0',
      input: mixedDomainArray,
      questions: { ok: D.noul('is valid?') },
    });
    expect(capturedBody?.state).toEqual(mixedDomainArray);
    expect(capturedBody?.assets).toBeUndefined();
  });

  it('keeps decision models isolated from generative LLMModelRegistry while computing cost for both prefixed and bare decision model keys', () => {
    expect(getCostFromUsage({ inputTokens: 1_000_000, outputTokens: 0 }, 'typesafe:jev-1.14.0')).toBeCloseTo(0.05, 6);
    expect(getCostFromUsage({ inputTokens: 1_000_000, outputTokens: 0 }, 'typesafe:jev-latest')).toBeCloseTo(0.05, 6);
    expect(getCostFromUsage({ inputTokens: 1_000_000, outputTokens: 0 }, 'google:gemini-decision-1')).toBeCloseTo(
      0.06,
      6,
    );
    expect(getCostFromUsage({ inputTokens: 1_000_000, outputTokens: 0 }, 'openai:gpt-6-luna')).toBeCloseTo(0.1, 6);
  });

  it('enforces compile-time capability matrix via @ts-expect-error when unsupported media or question types are paired with a model family', () => {
    // 1. D.box is rejected on google:* and openai:*
    const _invalidGoogleBox: DecideParams<'google:gemini-decision-1'> = {
      id: 'compile-check-1',
      model: 'google:gemini-decision-1',
      input: 'hello',
      questions: {
        // @ts-expect-error D.box is only supported on typesafe:* models
        loc: D.box('find button'),
      },
    };

    const _invalidOpenAIBox: DecideParams<'openai:gpt-6-luna'> = {
      id: 'compile-check-2',
      model: 'openai:gpt-6-luna',
      input: 'hello',
      questions: {
        // @ts-expect-error D.box is only supported on typesafe:* models
        loc: D.box('find button'),
      },
    };

    // 2. D.pdf, D.audio, D.video, D.fileUri are rejected on typesafe:* and openai:*
    const _invalidTypeSafePdf: DecideParams<'typesafe:jev-1.14.0'> = {
      id: 'compile-check-3',
      model: 'typesafe:jev-1.14.0',
      // @ts-expect-error D.pdf is only supported on google:* models
      input: [D.pdf(new Uint8Array([1, 2, 3]))],
      questions: { ok: D.noul('is valid?') },
    };

    const _invalidOpenAIAudio: DecideParams<'openai:gpt-6-luna'> = {
      id: 'compile-check-4',
      model: 'openai:gpt-6-luna',
      // @ts-expect-error D.audio is only supported on google:* models
      input: [D.audio(new Uint8Array([1, 2, 3]), { mediaType: 'audio/mp3' })],
      questions: { ok: D.noul('is valid?') },
    };

    const _invalidTypeSafeFileUri: DecideParams<'typesafe:jev-1.14.0'> = {
      id: 'compile-check-5',
      model: 'typesafe:jev-1.14.0',
      // @ts-expect-error D.fileUri is only supported on google:* models
      input: [D.fileUri('gs://bucket/img.png', { mediaType: 'image/png' })],
      questions: { ok: D.noul('is valid?') },
    };

    expect(_invalidGoogleBox.model).toBe('google:gemini-decision-1');
    expect(_invalidOpenAIBox.model).toBe('openai:gpt-6-luna');
    expect(_invalidTypeSafePdf.model).toBe('typesafe:jev-1.14.0');
    expect(_invalidOpenAIAudio.model).toBe('openai:gpt-6-luna');
    expect(_invalidTypeSafeFileUri.model).toBe('typesafe:jev-1.14.0');
  });
});
