import 'reflect-metadata';

/**
 * RawInput 顯式豁免元數據符號。
 */
export const RAW_INPUT_METADATA_KEY: unique symbol = Symbol.for('@danielwii/libs:raw-input');

export interface RawInputMetadataEntry {
  parameterIndex: number;
  reason: string;
  exitCondition?: string;
}

/**
 * 顯式入站契約豁免裝飾器。
 *
 * 適用場景：
 * 當入站請求參數確實無法或無需透過 Standard Schema 進行結構化校驗時（例如：二進制檔案流、第三方未簽名的 Raw Webhook Body 等），
 * 必須使用此裝飾器顯式標記並給出不可省略的審計理由與退場條件。
 *
 * @param reason 豁免理由（必須為非空且有意義的字串，嚴禁空白）
 * @param exitCondition 可選的退場條件（若提供必須為非空字串，例如：'待第三方 Webhook 釋出官方 Typed Schema 後移除'）
 *
 * @example
 * ```ts
 * @Post('upload')
 * async uploadFile(
 *   @RawInput('Binary file stream handled directly via stream piping', '待切換至專屬 S3 Presigned URL 後退場')
 *   @Req() req: Request,
 * ) {}
 * ```
 */
export function RawInput(reason: string, exitCondition?: string): ParameterDecorator {
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    throw new Error(
      '[@RawInput] A valid, non-empty reason must be provided to exempt an input from contract schema validation.',
    );
  }

  const cleanReason = reason.trim();
  let cleanExitCondition: string | undefined;

  if (exitCondition !== undefined) {
    if (typeof exitCondition !== 'string' || exitCondition.trim().length === 0) {
      throw new Error('[@RawInput] When provided, exitCondition must be a non-empty string.');
    }
    cleanExitCondition = exitCondition.trim();
  }

  return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    if (!propertyKey) {
      throw new Error('[@RawInput] Parameter decorator must be applied to a method parameter.');
    }

    const existing: RawInputMetadataEntry[] = Reflect.getOwnMetadata(RAW_INPUT_METADATA_KEY, target, propertyKey) ?? [];

    // 避免重複索引登記
    const updated = existing.filter((item) => item.parameterIndex !== parameterIndex);
    updated.push({ parameterIndex, reason: cleanReason, exitCondition: cleanExitCondition });

    Reflect.defineMetadata(RAW_INPUT_METADATA_KEY, updated, target, propertyKey);
  };
}

/**
 * 取得指定方法上特定參數的 @RawInput 豁免元數據條目。
 *
 * @param target 控制器原型（prototype）或類
 * @param propertyKey 方法名稱
 * @param parameterIndex 參數索引
 * @returns 豁免元數據條目，若未豁免則返回 undefined
 */
export function getRawInputExemption(
  target: object,
  propertyKey: string | symbol,
  parameterIndex: number,
): RawInputMetadataEntry | undefined {
  const metadata: RawInputMetadataEntry[] | undefined =
    Reflect.getOwnMetadata(RAW_INPUT_METADATA_KEY, target, propertyKey) ??
    Reflect.getMetadata(RAW_INPUT_METADATA_KEY, target, propertyKey);

  if (!metadata || !Array.isArray(metadata)) {
    return undefined;
  }

  return metadata.find((item) => item.parameterIndex === parameterIndex);
}
