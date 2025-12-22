import { BadRequestException } from '@nestjs/common';

import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata) {
    try {
      const parsedValue = this.schema.parse(value);
      return parsedValue;
    } catch (_error) {
      throw new BadRequestException('Validation failed');
    }
  }
}
