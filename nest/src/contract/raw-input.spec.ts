import { getRawInputExemption, RAW_INPUT_METADATA_KEY, RawInput } from './raw-input';

import { describe, expect, it } from 'bun:test';

describe('@RawInput Decorator', () => {
  it('應成功記錄參數的豁免理由', () => {
    class FileUploadController {
      uploadFile(
        @RawInput('Binary multipart stream handled directly')
        req: any,
        normalParam: string,
      ) {
        return { req, normalParam };
      }
    }

    const proto = FileUploadController.prototype;
    const exemption0 = getRawInputExemption(proto, 'uploadFile', 0);
    const exemption1 = getRawInputExemption(proto, 'uploadFile', 1);

    expect(exemption0).toBe('Binary multipart stream handled directly');
    expect(exemption1).toBeUndefined();
  });

  it('支援同一方法內多個參數分別標記不同的豁免理由', () => {
    class MultiRawController {
      handleWebhook(
        @RawInput('Raw HMAC signature header')
        signature: string,
        @RawInput('Raw unmodified payload bytes for verification')
        rawBody: any,
      ) {
        return { signature, rawBody };
      }
    }

    const proto = MultiRawController.prototype;
    expect(getRawInputExemption(proto, 'handleWebhook', 0)).toBe('Raw HMAC signature header');
    expect(getRawInputExemption(proto, 'handleWebhook', 1)).toBe('Raw unmodified payload bytes for verification');
  });

  it('傳入空字串或純空白字串時應拋出異常 (Fail-Fast)', () => {
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

  it('查詢未標記方法或空對象時應安全返回 undefined', () => {
    class EmptyController {
      hello(name: string) {}
    }

    expect(getRawInputExemption(EmptyController.prototype, 'hello', 0)).toBeUndefined();
    expect(getRawInputExemption({}, 'nonExistent', 0)).toBeUndefined();
  });
});
