import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';

import { SysEnv } from '@app/env';
import { validateLLMConfiguration } from '@app/features/llm';
import { BootModule } from '@app/nest/boot/boot.module';
import { runApp } from '@app/nest/boot/lifecycle';
import { AnyExceptionFilter } from '@app/nest/exceptions/any-exception.filter';
import { GraphqlAwareClassSerializerInterceptor } from '@app/nest/interceptors/graphql-aware-class-serializer.interceptor';
import { LoggerInterceptor } from '@app/nest/interceptors/logger.interceptor';
import { VisitorInterceptor } from '@app/nest/interceptors/visitor.interceptor';
import { configureLogging, LogtapeNestLogger } from '@app/nest/logging';
import { otelTraceMiddleware } from '@app/nest/middleware/otel-trace.middleware';
import { maskSecret } from '@app/utils/security';

import os from 'node:os';

import { getAppLogger } from '@app/utils/app-logger';
import compression from 'compression';
import { RedisStore } from 'connect-redis';
import cookieParser from 'cookie-parser';
import dedent from 'dedent';
import { json } from 'express';
import session from 'express-session';
import { graphqlUploadExpress } from 'graphql-upload-ts';
import helmet from 'helmet';
import Redis from 'ioredis';
import { DateTime } from 'luxon';
import morgan from 'morgan';
import responseTime from 'response-time';

import type { DynamicModule, ForwardReference, INestApplication, LogLevel, Type } from '@nestjs/common';
import type { CorsOptions, CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

const bootstrapLogger = getAppLogger('boot', 'Bootstrap');

type IEntryNestModule = Type<unknown> | DynamicModule | ForwardReference | Promise<IEntryNestModule>;

/**
 * 包装用户的 AppModule，自动注入 BootModule
 */
function wrapWithBootModule(AppModule: IEntryNestModule): Type<unknown> {
  @Module({
    imports: [BootModule, AppModule as Type<unknown>],
  })
  class WrappedAppModule {}
  return WrappedAppModule;
}

const allLogLevels: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

export interface BootstrapOptions {
  packageJson?: {
    name: string;
    version: string;
  };
}

export async function simpleBootstrap(
  AppModule: IEntryNestModule,
  onInit?: (app: INestApplication) => Promise<void>,
  options?: BootstrapOptions,
) {
  const now = Date.now();
  await configureLogging();
  const app = await NestFactory.create<NestExpressApplication>(wrapWithBootModule(AppModule), {
    logger: new LogtapeNestLogger(),
  });
  if (onInit) await onInit(app);
  await runApp(app)
    .listen(SysEnv.PORT)
    .then(() => {
      const server = app.getHttpServer();
      const address = server.address();
      const bindAddress = address
        ? typeof address === 'string'
          ? address
          : `${address.address}:${address.port}`
        : 'unknown';

      const startTime = DateTime.utc();
      const nodeVersion = process.version;
      const bunVersion =
        'Bun' in globalThis ? (globalThis as unknown as { Bun: { version: string } }).Bun.version : null;
      const runtimeVersions = bunVersion ? `Node ${nodeVersion} / Bun ${bunVersion}` : `Node ${nodeVersion}`;

      const runtimeModeDesc =
        process.env.NODE_ENV === 'production'
          ? '生产模式(代码优化)'
          : process.env.NODE_ENV === 'development'
            ? '开发模式(热重载)'
            : process.env.NODE_ENV === 'test'
              ? '测试模式'
              : '未知模式';

      const businessEnvDesc = SysEnv.environment.isProd
        ? '生产环境(真实数据)'
        : SysEnv.environment.env === 'stg'
          ? '预发布环境(测试数据)'
          : '开发环境(测试数据)';

      bootstrapLogger.info`${dedent`🦋 [Server] API Server started successfully
          ┌─ 环境配置 ─────────────────────────────────────────────
          │ Node Runtime (NODE_ENV): ${process.env.NODE_ENV ?? 'N/A'} - ${runtimeModeDesc}
          │ Business Env (ENV): ${SysEnv.environment.env} - ${businessEnvDesc} → isProd=${SysEnv.environment.isProd}
          │ Doppler Env: ${SysEnv.DOPPLER_ENVIRONMENT ?? 'N/A'}
          ├─ 应用信息 ─────────────────────────────────────────────
          │ App Version: ${options?.packageJson?.name ?? 'unknown'}-v${options?.packageJson?.version ?? 'unknown'}
          │ Host: ${os.hostname()}
          │ Node Name: ${SysEnv.NODE_NAME}
          │ Bind: ${bindAddress}
          │ Port: ${SysEnv.PORT}
          │ PID: ${process.pid}
          ├─ 运行时信息 ───────────────────────────────────────────
          │ Platform: ${process.platform}
          │ Runtime: ${runtimeVersions}
          │ SysEnv.TZ Time: ${startTime.setZone(SysEnv.TZ).toFormat('yyyy-MM-dd EEEE HH:mm:ss')} (${startTime.setZone(SysEnv.TZ).zoneName})
          │ Local Time: ${startTime.setZone('local').toFormat('yyyy-MM-dd EEEE HH:mm:ss')} (${startTime.setZone('local').zoneName})
          │ UTC Time: ${startTime.toFormat('yyyy-MM-dd EEEE HH:mm:ss')}
          └─ Startup Time: ${Date.now() - now}ms
        `}`;
    });
  return app;
}

export async function bootstrap(
  AppModule: IEntryNestModule,
  onInit?: (app: INestApplication) => Promise<void>,
  options?: BootstrapOptions,
) {
  if (!process.env.NODE_ENV) throw new Error('NODE_ENV is not set');

  const now = Date.now();
  const logLevel: LogLevel = SysEnv.LOG_LEVEL;
  const levels = allLogLevels.slice(allLogLevels.indexOf(logLevel), allLogLevels.length);

  const notShowLogLevels = allLogLevels.slice(0, allLogLevels.indexOf(logLevel));
  bootstrapLogger.info`[Config] Log level set to "${SysEnv.LOG_LEVEL}" - Enabled levels: ${levels.join(', ')}`;
  if (notShowLogLevels.length) {
    bootstrapLogger.warning`[Config] Disabled log levels: ${notShowLogLevels.join(', ')}`;
  }

  // LLM 配置验证（自动验证所有 @LLMModelField 标记的字段）
  const llmValidation = validateLLMConfiguration();
  if (!llmValidation.valid) {
    throw new Error(`LLM configuration invalid: ${llmValidation.errors.join(', ')}`);
  }
  llmValidation.warnings.forEach((w: string) => {
    bootstrapLogger.warning`[LLM] ${w}`;
  });

  await configureLogging(logLevel);
  const app = await NestFactory.create<NestExpressApplication>(wrapWithBootModule(AppModule), {
    logger: new LogtapeNestLogger(),
  });
  app.set('query parser', 'extended');

  app.useGlobalPipes(new ValidationPipe({ enableDebugMessages: true, transform: true, whitelist: true }));

  // 先使用无翻译功能的过滤器，稍后通过应用引用注入
  app.useGlobalFilters(new AnyExceptionFilter(app));
  bootstrapLogger.info`[Config] AnyExceptionFilter initialized with app reference for lazy i18n support`;

  app.useGlobalInterceptors(new GraphqlAwareClassSerializerInterceptor(app.get(Reflector)));
  app.useGlobalInterceptors(new VisitorInterceptor());
  app.useGlobalInterceptors(new LoggerInterceptor());
  app.enableShutdownHooks();

  /*
  https://github.com/expressjs/cors#configuration-options
  https://github.com/expressjs/cors#configuring-cors-asynchronously
    不要盲目反射 Origin 头
    严格校验 Origin 头，避免出现权限泄露
    不要配置 Access-Control-Allow-Origin: null
    HTTPS 网站不要信任 HTTP 域
    不要信任全部自身子域，减少攻击面
    不要配置 Origin:* 和 Credentials: true，CORS 规定无法同时使用
    增加 Vary: Origin 头来区分不同来源的缓存
   */
  const corsOptions: CorsOptions | CorsOptionsDelegate<unknown> = {
    credentials: true,
    origin: true, // reflect from req.header('Origin') TODO dynamic from a function with whitelist
    // allowedHeaders: '*',
    // methods: '*',
  };
  bootstrapLogger.info`[Config] CORS enabled with options: ${JSON.stringify(corsOptions)}`;
  app.enableCors(corsOptions);

  // see https://expressjs.com/en/guide/behind-proxies.html
  // 设置以后，req.ips 是 ip 数组；如果未经过代理，则为 []. 若不设置，则 req.ips 恒为 []
  // app.set('trust proxy', true);
  app.set('trust proxy', 1);

  // OTel tracing middleware — 仅在 HttpInstrumentation 禁用时使用
  // 替代 HttpInstrumentation，只创建 span + context.with()，不 patch EventEmitter
  if (process.env.OTEL_HTTP_INSTRUMENTATION === 'false') {
    bootstrapLogger.info`[Config] OTel HTTP instrumentation disabled, using lightweight otelTraceMiddleware`;
    app.use(otelTraceMiddleware);
  }

  if (SysEnv.SESSION_SECRET) {
    if (!SysEnv.INFRA_REDIS_URL) throw new Error('INFRA_REDIS_URL is not set and required for session storage');
    const client = new Redis(SysEnv.INFRA_REDIS_URL, { maxRetriesPerRequest: 3 });
    bootstrapLogger.info`[Config] Session enabled with secret: "${maskSecret(SysEnv.SESSION_SECRET)}"`;

    app.use(
      session({
        store: new RedisStore({ client }),
        secret: SysEnv.SESSION_SECRET,
        resave: false,
        saveUninitialized: true,
        cookie: SysEnv.environment.isProd ? { secure: true } : {},
      }),
    );
  }
  // app.use((req, res, next) => {
  //   const ip = getClientIp(req);
  //   Object.defineProperty(req, 'clientIp', { get: () => ip, configurable: true });
  //   next();
  // });

  // https://helmetjs.github.io/
  // Helmet helps secure Express apps by setting HTTP response headers.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'default-src': ["'self'"],
          'base-uri': ["'self'"],
          'block-all-mixed-content': [],
          'font-src': ["'self'", 'https:', 'data:'],
          'frame-ancestors': ["'self'"],
          // load all domains' images
          'img-src': ["'self'", 'data:', '*'],
          'object-src': ["'none'"],
          // 'unsafe-inline' used to run some iframe script like payment api
          'script-src': ["'self'", "'unsafe-inline'", '*'],
          'script-src-attr': ["'none'"],
          'style-src': ["'self'", 'https:', "'unsafe-inline'"],
          'upgrade-insecure-requests': [],
        },
      },
      referrerPolicy: {
        // IMPORTANT no-referrer is the default, but some payment api will not work
        /*
        no-referrer	整个 Referer 报头会被移除。访问来源信息不随着请求一起发送。
        no-referrer-when-downgrade 默认值	在没有指定任何策略的情况下用户代理的默认行为。在同等安全级别的情况下，引用页面的地址会被发送(HTTPS->HTTPS)，但是在降级的情况下不会被发送 (HTTPS->HTTP)。
        origin	在任何情况下，仅发送文件的源作为引用地址。例如 https://example.com/page.html 会将 https://example.com/ 作为引用地址。
        origin-when-cross-origin	对于同源的请求，会发送完整的URL作为引用地址，但是对于非同源请求仅发送文件的源。
        same-origin	对于同源的请求会发送引用地址，但是对于非同源请求则不发送引用地址信息。
        strict-origin	在同等安全级别的情况下，发送文件的源作为引用地址(HTTPS->HTTPS)，但是在降级的情况下不会发送 (HTTPS->HTTP)。
        strict-origin-when-cross-origin	于同源的请求，会发送完整的URL作为引用地址；在同等安全级别的情况下，发送文件的源作为引用地址(HTTPS->HTTPS)；在降级的情况下不发送此报头 (HTTPS->HTTP)。
        unsafe-url	无论是同源请求还是非同源请求，都发送完整的 URL（移除参数信息之后）作为引用地址。
         */
        policy: 'unsafe-url',
      },
    }),
  );

  app.use(cookieParser());

  app.disable('x-powered-by');

  // 标准化 X-Forwarded-For header
  // Node.js 会把多个同名 header 合并成数组，但 morgan 的 forwarded 库期望字符串
  // 按 RFC 7239，多个 header 应视为逗号分隔的列表，第一个 IP 是真实客户端
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const xff = req.headers['x-forwarded-for'];
    if (Array.isArray(xff)) {
      req.headers['x-forwarded-for'] = xff.join(', ');
    }
    next();
  });

  // combined 格式 + response-time（毫秒）
  // 格式：:remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":response-time ms" ":referrer" ":user-agent"
  app.use(
    morgan(
      ':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":response-time ms" ":referrer" ":user-agent"',
      {
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- boolean OR, not nullish fallback
        skip: (req) => req.url?.startsWith('/health') || req.url === '/',
      },
    ),
  );

  app.use(
    compression({
      filter: (req, res) => {
        // 设计意图：SSE 需要逐块推送，任何压缩都会导致代理/IOT 端缓存整包再吐出
        // 原先只判断精确的 text/event-stream，忽略了我们追加 charset 后的情况，导致被压缩
        const contentTypeHeader = res.getHeader('Content-Type');
        const contentType = Array.isArray(contentTypeHeader)
          ? contentTypeHeader.join(';')
          : typeof contentTypeHeader === 'string'
            ? contentTypeHeader
            : '';
        if (contentType.toLowerCase().includes('text/event-stream')) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );
  app.use(responseTime());
  app.use(json({ limit: '1mb' }));

  // 只对 GraphQL 端点启用文件上传中间件，避免影响 REST API 的 multipart 处理
  app.use(
    '/graphql',
    graphqlUploadExpress({
      maxFileSize: 10 * 1024 * 1024,
      maxFiles: 10,
    }),
  );

  const port = SysEnv.PORT;

  if (onInit) await onInit(app);

  await runApp(app)
    .listen(port)
    .then(() => {
      const server = app.getHttpServer();
      const address = server.address();
      const bindAddress = address
        ? typeof address === 'string'
          ? address
          : `${address.address}:${address.port}`
        : 'unknown';

      const startTime = DateTime.utc();

      // 环境配置安全检查：生产模式下必须明确指定业务环境
      // 设计意图：防止在生产模式(NODE_ENV=production)下误用默认的 dev 环境，导致数据混乱或安全问题
      if (process.env.NODE_ENV === 'production') {
        if (!SysEnv.ENV && !SysEnv.DOPPLER_ENVIRONMENT) {
          bootstrapLogger.warning`[Security] NODE_ENV=production 但未设置 ENV 或 DOPPLER_ENVIRONMENT，将使用默认值 "dev"`;
          bootstrapLogger.warning`建议：在 .env.production 中明确设置 ENV=prd (生产) 或 ENV=stg (预发布)`;
          bootstrapLogger.warning`风险：当前配置可能导致生产模式代码连接到测试环境数据，或测试代码连接到生产数据`;
        }
      }

      // 环境信息说明：
      // - NODE_ENV: Node.js 运行模式（技术层面）- 控制代码优化、日志详细度、热重载等
      // - ENV: 业务环境标识（业务层面）- 控制连接哪个数据库、是否真实支付、发送真实通知等
      const runtimeModeDesc =
        process.env.NODE_ENV === 'production'
          ? '生产模式(代码优化)'
          : process.env.NODE_ENV === 'development'
            ? '开发模式(热重载)'
            : '测试模式';

      const businessEnvDesc = SysEnv.environment.isProd
        ? '生产环境(真实数据)'
        : SysEnv.environment.env === 'stg'
          ? '预发布环境(测试数据)'
          : '开发环境(测试数据)';

      // 获取运行时版本信息
      const nodeVersion = process.version;
      // Bun 运行时检测：在 Bun 环境下 globalThis.Bun 存在
      const bunVersion =
        'Bun' in globalThis ? (globalThis as unknown as { Bun: { version: string } }).Bun.version : null;
      const runtimeVersions = bunVersion ? `Node ${nodeVersion} / Bun ${bunVersion}` : `Node ${nodeVersion}`;

      bootstrapLogger.info`${dedent`🦋 [Server] API Server started successfully
          ┌─ 环境配置 ─────────────────────────────────────────────
          │ Node Runtime (NODE_ENV): ${process.env.NODE_ENV} - ${runtimeModeDesc}
          │ Business Env (ENV): ${SysEnv.environment.env} - ${businessEnvDesc} → isProd=${SysEnv.environment.isProd}
          │ Doppler Env: ${SysEnv.DOPPLER_ENVIRONMENT ?? 'N/A'}
          ├─ 应用信息 ─────────────────────────────────────────────
          │ App Version: ${options?.packageJson?.name ?? 'unknown'}-v${options?.packageJson?.version ?? 'unknown'}
          │ Host: ${os.hostname()}
          │ Node Name: ${SysEnv.NODE_NAME}
          │ Bind: ${bindAddress}
          │ Port: ${port}
          │ PID: ${process.pid}
          ├─ 运行时信息 ───────────────────────────────────────────
          │ Platform: ${process.platform}
          │ Runtime: ${runtimeVersions}
          │ SysEnv.TZ Time: ${startTime.setZone(SysEnv.TZ).toFormat('yyyy-MM-dd EEEE HH:mm:ss')} (${startTime.setZone(SysEnv.TZ).zoneName})
          │ Local Time: ${startTime.setZone('local').toFormat('yyyy-MM-dd EEEE HH:mm:ss')} (${startTime.setZone('local').zoneName})
          │ UTC Time: ${startTime.toFormat('yyyy-MM-dd EEEE HH:mm:ss')}
          └─ Startup Time: ${Date.now() - now}ms
        `}`;
    });

  return app;
}
