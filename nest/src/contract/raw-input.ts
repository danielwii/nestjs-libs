import 'reflect-metadata';

/**
 * RawInput 顯式豁免元數據符號。
 */
export const RAW_INPUT_METADATA_KEY: unique symbol = Symbol.for('@danielwii/libs:raw-input');

export interface RawInputMetadataEntry {
  parameterIndex: number;
  reason: string;
}

/**
 * 顯式入站契約豁免裝飾器。
 *
 * 適用場景：
 * 當入站請求參數確實無法或無需透過 Standard Schema 進行結構化校驗時（例如：二進制檔案流、第三方未簽名的 Raw Webhook Body 等），
 * 必須使用此裝飾器顯式標記並給出不可省略的審計理由。
 *
 * @param reason 豁免理由（必須為非空且有意義的字串，嚴禁空白）
 *
 * @example
 * ```ts
 * @Post('upload')
 * async uploadFile(
 *   @RawInput('Binary file stream handled directly via stream piping')
 *   @Req() req: Request,
 * ) {}
 * ```
 */
export function RawInput(reason: string): ParameterDecorator {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error(
      '[@RawInput] A valid, non-empty reason must be provided to exempt an input from contract schema validation.',
    );
  }

  const cleanReason = reason.trim();

  return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    if (!propertyKey) {
      throw new Error('[@RawInput] Parameter decorator must be applied to a method parameter.');
    }

    const existing: RawInputMetadataEntry[] = Reflect.getOwnMetadata(RAW_INPUT_METADATA_KEY, target, propertyKey) ?? [];

    // 避免重複索引登記
    const updated = existing.filter((item) => item.parameterIndex !== parameterIndex);
    updated.push({ parameterIndex, reason: cleanReason });

    Reflect.defineMetadata(RAW_INPUT_METADATA_KEY, updated, target, propertyKey);
  };
}

/**
 * 取得指定方法上特定參數的 @RawInput 豁免理由。
 *
 * @param target 控制器原型（prototype）或類
 * @param propertyKey 方法名稱
 * @param parameterIndex 參數索引
 * @returns 豁免理由字串，若未豁免則返回 undefined
 */
export function getRawInputExemption(
  target: object,
  propertyKey: string | symbol,
  parameterIndex: number,
): string | undefined {
  const metadata: RawInputMetadataEntry[] | undefined =
    Reflect.getOwnMetadata(RAW_INPUT_METADATA_KEY, target, propertyKey) ??
    Reflect.getMetadata(RAW_INPUT_METADATA_KEY, target, propertyKey);

  if (!metadata || !Array.isArray(metadata)) {
    return undefined;
  }

  const found = metadata.find((item) => item.parameterIndex === parameterIndex);
  return found?.reason;
}
