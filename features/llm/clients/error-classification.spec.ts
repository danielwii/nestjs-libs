import 'reflect-metadata';

import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { Oops } from '@app/nest/exceptions/oops';

import { LLM } from './llm.class';

import { describe, expect, it } from 'bun:test';

import type { LLMModelSpec } from '../types/model.types';

describe('LLM internal input error classification', () => {
  it('classifies an invalid configured model key as Panic.Config', () => {
    let thrown: unknown;

    try {
      LLM.model('missing-provider-separator' as LLMModelSpec);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Oops.Panic);
    expect(thrown).toMatchObject({
      httpStatus: 500,
      errorCode: ErrorCodes.SYSTEM_INTERNAL_ERROR,
      internalDetails:
        'Configuration error: Invalid model key format: missing-provider-separator, expected "provider:model"',
    });
  });

  it('classifies empty text reaching the embedding core as Panic.Invariant', async () => {
    let thrown: unknown;

    try {
      await LLM.embedding({
        id: 'empty-text-regression',
        model: 'openai:text-embedding-3-small',
        text: '   ',
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Oops.Panic);
    expect(thrown).toMatchObject({
      httpStatus: 500,
      errorCode: ErrorCodes.SYSTEM_LOGIC_ERROR,
      oopsCode: 'GN08',
      internalDetails:
        'Invariant violation: Embedding input text is empty: id=empty-text-regression type=string length=3',
    });
  });
});
