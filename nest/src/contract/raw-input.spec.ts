import { getRawInputExemption, RAW_INPUT_METADATA_KEY, RawInput } from './raw-input';

import { describe, expect, it } from 'bun:test';

describe('@RawInput Decorator', () => {
  it('應成功記錄參數的豁免理由與可選退場條件', () => {
    class FileUploadController {
      uploadFile(
        @RawInput('Binary multipart stream handled directly', '待遷移至專屬 Presigned S3 上傳服務後退場')
        req: any,
        normalParam: string,
      ) {
        return { req, normalParam };
      }
    }

    const proto = FileUploadController.prototype;
    const exemption0 = getRawInputExemption(proto, 'uploadFile', 0);
    const exemption1 = getRawInputExemption(proto, 'uploadFile', 1);

    expect(exemption0).toBeDefined();
    expect(exemption0?.reason).toBe('Binary multipart stream handled directly');
    expect(exemption0?.exitCondition).toBe('待遷移至專屬 Presigned S3 上傳服務後退場');
    expect(exemption1).toBeUndefined();
  });

  it('支援同一方法內多個參數分別標記不同的豁免理由與退場條件', () => {
    class MultiRawController {
      handleWebhook(
        @RawInput('Raw HMAC signature header')
        signature: string,
        @RawInput('Raw unmodified payload bytes for verification', '待第三方 Webhook 提供標準 JSON Schema 後退場')
        rawBody: any,
      ) {
        return { signature, rawBody };
      }
    }

    const proto = MultiRawController.prototype;
    const ex0 = getRawInputExemption(proto, 'handleWebhook', 0);
    const ex1 = getRawInputExemption(proto, 'handleWebhook', 1);

    expect(ex0?.reason).toBe('Raw HMAC signature header');
    expect(ex0?.exitCondition).toBeUndefined();

    expect(ex1?.reason).toBe('Raw unmodified payload bytes for verification');
    expect(ex1?.exitCondition).toBe('待第三方 Webhook 提供標準 JSON Schema 後退場');
  });

  it('傳入空字串或純空白理由時應拋出異常 (Fail-Fast)', () => {
    expect(() => {
      class InvalidController {
        action(@RawInput('') param: any) {}
      }
    }).toThrow('[@RawInput] A valid, non-empty reason must be provided');

    expect(() => {
      class InvalidController {
        action(@RawInput('   \t\n  ') param: any) {}
      }
    }).toThrow('[@RawInput] A valid, non-empty reason must be provided');

    expect(() => {
      class InvalidController {
        action(@RawInput(null as any) param: any) {}
      }
    }).toThrow('[@RawInput] A valid, non-empty reason must be provided');
  });

  it('若傳入 exitCondition 且為空字串或純空白時應拋出異常 (Fail-Fast)', () => {
    expect(() => {
      class InvalidController {
        action(@RawInput('Valid reason', '') param: any) {}
      }
    }).toThrow('[@RawInput] When provided, exitCondition must be a non-empty string.');

    expect(() => {
      class InvalidController {
        action(@RawInput('Valid reason', '   \t  ') param: any) {}
      }
    }).toThrow('[@RawInput] When provided, exitCondition must be a non-empty string.');
  });

  it('查詢未標記方法或空對象時應安全返回 undefined', () => {
    class EmptyController {
      hello(name: string) {}
    }

    expect(getRawInputExemption(EmptyController.prototype, 'hello', 0)).toBeUndefined();
    expect(getRawInputExemption({}, 'nonExistent', 0)).toBeUndefined();
  });

  describe('Type-level contract assertions', () => {
    it('編譯期型別約束驗證', () => {
      // 正常呼叫：單參數 reason 或雙參數 reason + exitCondition
      const decorator1 = RawInput('reason');
      const decorator2 = RawInput('reason', 'exitCondition');

      // @ts-expect-error 缺少必填參數 reason
      const _badOmitted = () => RawInput();

      // @ts-expect-error reason 必須是 string
      const _badReasonType = () => RawInput(123);

      // @ts-expect-error exitCondition 必須是 string
      const _badExitType = () => RawInput('reason', 123);

      void [decorator1, decorator2];
    });
  });
});
