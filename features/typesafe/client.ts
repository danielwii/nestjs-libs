import { Oops } from '@app/nest/exceptions/oops';

import { getTypeSafeApiKey } from './api-key';

import { createRequire } from 'node:module';

import type * as TypeSafeSdkModule from '@typesafe-ai/sdk';
import type { TypeSafeClient } from '@typesafe-ai/sdk';

export type TypeSafeSdk = typeof TypeSafeSdkModule;

let sdk: TypeSafeSdk | null = null;
let client: TypeSafeClient | null = null;

export function loadTypeSafeSdk(): TypeSafeSdk {
  if (!sdk) {
    try {
      const req = createRequire(import.meta.url);
      sdk = req('@typesafe-ai/sdk') as TypeSafeSdk;
    } catch {
      throw Oops.Panic.Config(
        'LLM.systemOne requires the optional peer "@typesafe-ai/sdk". Install it first (e.g. bun add @typesafe-ai/sdk).',
      );
    }
  }
  return sdk;
}

export function resetTypeSafeClient(): void {
  client = null;
}

/** Test seam: inject a fake client so LLM.systemOne does not hit the network. */
export function setTypeSafeClientForTest(next: TypeSafeClient | null): void {
  client = next;
}

export function getTypeSafeClient(): TypeSafeClient {
  if (!client) {
    const { TypeSafeClient } = loadTypeSafeSdk();
    client = new TypeSafeClient({
      apiKey: getTypeSafeApiKey(),
      logLevel: 'off',
    });
  }
  return client;
}
