import { Oops } from '@app/nest/exceptions/oops';

import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { StandardSchemaV1 } from '@standard-schema/spec';

export type CompatibleValidationSchema<T = unknown> =
  | StandardSchemaV1<unknown, T>
  | {
      parse: (val: unknown) => T;
      safeParse?: (val: unknown) => { success: boolean; data?: T; error?: unknown };
    };

/**
 * 現代化驗證管道：優先遵循 @standard-schema/spec 規範（原生相容 Zod、ArkType、Valibot），
 * 同時向下相容任何帶有 .parse() 方法的舊式 Schema 物件。
 *
 * 失敗時自動將 issues 規格化轉換並拋出領域標準的 Oops.Validation 異常。
 */
export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: CompatibleValidationSchema) {}

  async transform(value: unknown, _metadata?: ArgumentMetadata) {
    // 1. 優先使用 Standard Schema 標準協議 (~standard)
    if ('~standard' in this.schema) {
      const standard = this.schema['~standard'];
      const result = await standard.validate(value);

      if (result.issues) {
        const firstIssue = result.issues[0];
        const pathStr =
          firstIssue?.path && firstIssue.path.length > 0
            ? `[${firstIssue.path.map((p) => (typeof p === 'object' ? String(p.key) : String(p))).join('.')}] `
            : '';
        const message = `${pathStr}${firstIssue?.message ?? 'Validation failed'}`;
        const details = JSON.stringify(result.issues);

        throw Oops.Validation(message, details);
      }

      return result.value;
    }

    // 2. 回落支援傳統 parse 方法
    try {
      return (this.schema as { parse: (val: unknown) => unknown }).parse(value);
    } catch (error) {
      // ZodError 會被 AnyExceptionFilter 直接識別處理，
      // 但如果 filter 沒生效（如 microservice），這裡 fallback 到 Oops.Validation
      throw error instanceof Error
        ? Oops.Validation('Validation failed', error.message)
        : Oops.Validation('Validation failed');
    }
  }
}

// 別名導出，提供現代標準語義
export { ZodValidationPipe as StandardValidationPipe };
