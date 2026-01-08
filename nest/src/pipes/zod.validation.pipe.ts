import { BadRequestException } from '@nestjs/common';

import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

export class ZodValidationPipe implements PipeTransform {
  constructor(private schema: z.ZodType) {}

  transform(value: unknown, _metadata: ArgumentMetadata) {
    try {
      const parsedValue = this.schema.parse(value);
      return parsedValue;
    } catch {
      throw new BadRequestException('Validation failed');
    }
  }
}
