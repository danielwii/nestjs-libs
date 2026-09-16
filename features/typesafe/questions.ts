import { loadTypeSafeSdk } from './client';

import type { TypeSafeSdk } from './client';

export function noul(...args: Parameters<TypeSafeSdk['noul']>): ReturnType<TypeSafeSdk['noul']> {
  return loadTypeSafeSdk().noul(...args);
}

export function choice(...args: Parameters<TypeSafeSdk['choice']>): ReturnType<TypeSafeSdk['choice']> {
  return loadTypeSafeSdk().choice(...args);
}

export function score(...args: Parameters<TypeSafeSdk['score']>): ReturnType<TypeSafeSdk['score']> {
  return loadTypeSafeSdk().score(...args);
}
