import 'reflect-metadata';

import { LLM } from './llm.class';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('LLM.replayFromFile', () => {
  it("rejects legacy 'system' before model/provider resolution", async () => {
    const root = mkdtempSync(join(tmpdir(), 'llm-replay-'));
    tempRoots.push(root);
    const capturePath = join(root, 'legacy.request.json');
    writeFileSync(
      capturePath,
      JSON.stringify({
        id: 'legacy-capture',
        method: 'generateObject',
        model: 'provider-that-must-not-be-resolved:model',
        system: 'legacy prompt owner',
        messages: [{ role: 'user', content: 'hello' }],
        jsonSchema: { type: 'object' },
      }),
    );

    await expect(LLM.replayFromFile(capturePath)).rejects.toThrow("use 'instructions'");
  });
});
