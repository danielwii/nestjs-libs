/**
 * I18N 服务接口
 * 用于 AnyExceptionFilter 的依赖注入，避免直接依赖具体实现
 */
export interface II18nService {
  /**
   * 获取指定语言的消息
   */
  getMessagesByLocale(locale: string): Promise<Record<string, any>>;

  /**
   * 翻译消息
   */
  translateMessage(params: {
    key: string;
    description?: string;
    sourceMessage: string;
    targetLanguage: string;
  }): Promise<string>;

  /**
   * 翻译错误消息（简化接口）
   * 
   * 【设计意图】
   * - 框架层专用的错误消息翻译接口
   * - 接收任意格式的 targetLanguage（包括 null/undefined）
   * - 内部统一处理语言解析、缓存、翻译、fallback
   * - 源语言是中文，目标语言由 targetLanguage 指定（null 表示使用默认语言）
   * 
   * @param key - 错误键（如 'errors.USER_NOT_FOUND'）
   * @param sourceMessage - 源消息（中文）
   * @param targetLanguage - 目标语言（'zh-Hans', 'zh-hans', 'en', 'zh', null 等任意格式）
   * @returns 翻译后的消息，失败时返回源消息
   */
  translateErrorMessage(options: {
    key: string;
    sourceMessage: string;
    targetLanguage?: string | null;
  }): Promise<string>;

  /**
   * Prisma 客户端（用于直接数据库操作）
   */
  readonly prisma: {
    i18nTranslationKey: {
      upsert(params: any): Promise<any>;
    };
    i18nMessage: {
      upsert(params: any): Promise<any>;
    };
  };
}
