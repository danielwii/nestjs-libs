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