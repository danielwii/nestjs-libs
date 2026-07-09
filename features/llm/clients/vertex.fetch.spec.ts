import {
  createVertexFetch,
  isVertexGenerateContentRequest,
  normalizeVertexRequestInit,
  stripUnsupportedVertexFunctionIds,
} from './vertex.fetch';

import { describe, expect, it } from 'bun:test';

interface TestVertexPayload {
  contents: Array<{
    parts: Array<Record<string, unknown>>;
  }>;
}

function partAt(body: unknown, contentIndex: number, partIndex: number): Record<string, unknown> {
  return (body as TestVertexPayload).contents[contentIndex]!.parts[partIndex]!;
}

function vertexPayloadWithFunctionIds() {
  return {
    contents: [
      {
        role: 'user',
        parts: [{ text: 'Use the lookup tool.' }],
      },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_test_1',
              name: 'lookup',
              args: { city: 'Taipei' },
            },
            thoughtSignature: 'keep-thought-signature',
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call_test_1',
              name: 'lookup',
              response: {
                name: 'lookup',
                content: { city: 'Taipei', status: 'ok' },
              },
            },
            id: 'part-level-id-must-stay',
          },
        ],
      },
    ],
    generationConfig: { maxOutputTokens: 32 },
  };
}

describe('stripUnsupportedVertexFunctionIds', () => {
  it('removes only functionCall.id and functionResponse.id from Vertex content parts', () => {
    const input = vertexPayloadWithFunctionIds();

    const result = stripUnsupportedVertexFunctionIds(input);
    const functionCallPart = partAt(result.body, 1, 0);
    const functionResponsePart = partAt(result.body, 2, 0);

    expect(result.stripped).toBe(2);
    expect(functionCallPart.functionCall).toEqual({
      name: 'lookup',
      args: { city: 'Taipei' },
    });
    expect(functionCallPart.thoughtSignature).toBe('keep-thought-signature');
    expect(functionResponsePart.functionResponse).toEqual({
      name: 'lookup',
      response: {
        name: 'lookup',
        content: { city: 'Taipei', status: 'ok' },
      },
    });
    expect(functionResponsePart.id).toBe('part-level-id-must-stay');

    expect(partAt(input, 1, 0).functionCall).toHaveProperty('id', 'call_test_1');
    expect(partAt(input, 2, 0).functionResponse).toHaveProperty('id', 'call_test_1');
  });

  it('leaves already-compatible payloads by reference', () => {
    const input = {
      contents: [
        {
          role: 'model',
          parts: [{ functionCall: { name: 'lookup', args: { city: 'Taipei' } } }],
        },
      ],
    };

    const result = stripUnsupportedVertexFunctionIds(input);

    expect(result.stripped).toBe(0);
    expect(result.body).toBe(input);
  });
});

describe('Vertex generateContent request detection', () => {
  it('matches Vertex generate and streamGenerate endpoints', () => {
    expect(
      isVertexGenerateContentRequest(
        'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent',
      ),
    ).toBe(true);
    expect(
      isVertexGenerateContentRequest(
        'https://aiplatform.googleapis.com/v1/projects/test/locations/global/publishers/google/models/gemini-2.5-flash:streamGenerateContent?alt=sse',
      ),
    ).toBe(true);
  });

  it('does not match non-generate Vertex endpoints', () => {
    expect(
      isVertexGenerateContentRequest(
        'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:countTokens',
      ),
    ).toBe(false);
  });
});

describe('normalizeVertexRequestInit', () => {
  it('normalizes JSON bodies only for Vertex generateContent requests', () => {
    const init: RequestInit = {
      method: 'POST',
      body: JSON.stringify(vertexPayloadWithFunctionIds()),
    };

    const nextInit = normalizeVertexRequestInit(
      'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent',
      init,
    );
    const nextBody = JSON.parse(nextInit?.body as string);

    expect(nextBody.contents[1].parts[0].functionCall).not.toHaveProperty('id');
    expect(nextBody.contents[2].parts[0].functionResponse).not.toHaveProperty('id');
    expect(init.body).toContain('"id":"call_test_1"');
  });

  it('does not normalize non-generate endpoints', () => {
    const init: RequestInit = {
      method: 'POST',
      body: JSON.stringify(vertexPayloadWithFunctionIds()),
    };

    const nextInit = normalizeVertexRequestInit(
      'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:countTokens',
      init,
    );

    expect(nextInit).toBe(init);
  });
});

describe('createVertexFetch', () => {
  it('passes normalized Vertex request bodies to the base fetch', async () => {
    let capturedBody: string | undefined;
    const baseFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = init?.body as string | undefined;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const vertexFetch = createVertexFetch(baseFetch);

    await vertexFetch(
      'https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent',
      {
        method: 'POST',
        body: JSON.stringify(vertexPayloadWithFunctionIds()),
      },
    );

    const body = JSON.parse(capturedBody ?? '{}');
    expect(body.contents[1].parts[0].functionCall).not.toHaveProperty('id');
    expect(body.contents[2].parts[0].functionResponse).not.toHaveProperty('id');
  });
});
