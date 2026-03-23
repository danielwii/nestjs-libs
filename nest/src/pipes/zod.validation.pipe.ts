import { Oops } from '@app/nest/exceptions/oops';

import '@app/nest/exceptions/oops-factories';

import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: z.ZodType) {}

  transform(value: unknown, _metadata: ArgumentMetadata) {
    try {
      return this.schema.parse(value);
    } catch (error) {
      // ZodError 会被 AnyExceptionFilter 直接识别处理，
      // 但如果 filter 没生效（如 microservice），这里 fallback 到 Oops.Validation
      throw error instanceof Error
        ? Oops.Validation('Validation failed', error.message)
        : Oops.Validation('Validation failed');
    }
  }
}
