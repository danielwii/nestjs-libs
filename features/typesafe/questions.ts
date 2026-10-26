import { loadTypeSafeSdk } from './client';

import type { TypeSafeSdk } from './client';

export const noul: TypeSafeSdk['noul'] = ((...args: [unknown, unknown?]) =>
  (loadTypeSafeSdk().noul as (...a: unknown[]) => unknown)(...args)) as TypeSafeSdk['noul'];

export const choice: TypeSafeSdk['choice'] = ((...args: [unknown, unknown]) =>
  (loadTypeSafeSdk().choice as (...a: unknown[]) => unknown)(...args)) as TypeSafeSdk['choice'];

export const score: TypeSafeSdk['score'] = ((...args: [unknown, unknown]) =>
  (loadTypeSafeSdk().score as (...a: unknown[]) => unknown)(...args)) as TypeSafeSdk['score'];

export const box: TypeSafeSdk['box'] = ((...args: [unknown?]) =>
  (loadTypeSafeSdk().box as (...a: unknown[]) => unknown)(...args)) as TypeSafeSdk['box'];
