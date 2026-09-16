import { getAppLogger } from '@app/utils/app-logger';

/** LogTape category segment for TypeSafe calls. Do not reuse `[LLM:*]` tags. */
export const TYPESAFE_LOGGER_MODULE = 'typesafe';

export const typeSafeLogger = getAppLogger(TYPESAFE_LOGGER_MODULE);
