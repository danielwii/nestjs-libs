import { SysEnv } from '@app/env';
import { Oops } from '@app/nest/exceptions/oops';

/**
 * Read the TypeSafe API key from SysEnv.
 *
 * Official SDK reads TYPESAFE_API_KEY; nestjs-libs owns AI_TYPESAFE_API_KEY.
 * Callers pass the return value into TypeSafeClient({ apiKey }).
 */
export function getTypeSafeApiKey(): string {
  const key = SysEnv.AI_TYPESAFE_API_KEY?.trim();
  if (!key) {
    throw Oops.Panic.Config('AI_TYPESAFE_API_KEY is not configured');
  }
  return key;
}
