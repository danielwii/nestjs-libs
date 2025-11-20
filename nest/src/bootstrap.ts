import {
  DynamicModule,
  ForwardReference,
  INestApplication,
  Logger,
  LogLevel,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { CorsOptions, CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';

import { SysEnv } from '@app/env';
import { AnyExceptionFilter } from '@app/nest/any-exception.filter';
import { GraphqlAwareClassSerializerInterceptor } from '@app/nest/graphql-aware-class-serializer.interceptor';
import { runApp } from '@app/nest/lifecycle';
import { LoggerInterceptor } from '@app/nest/logger.interceptor';
import { initStackTraceFormatter } from '@app/nest/logger.utils';
import { VisitorInterceptor } from '@app/nest/visitor.interceptor';
import { maskSecret } from '@app/utils';

import { AppEnvs } from '@/env';

import os from 'node:os';

import { stripIndent } from 'common-tags';
import compression from 'compression';
import { RedisStore } from 'connect-redis';
import cookieParser from 'cookie-parser';
import { json } from 'express';
import session from 'express-session';
import { graphqlUploadExpress } from 'graphql-upload-ts';
import helmet from 'helmet';
import Redis from 'ioredis';
import { DateTime } from 'luxon';
import morgan from 'morgan';
import responseTime from 'response-time';

type IEntryNestModule = Type<any> | DynamicModule | ForwardReference | Promise<IEntryNestModule>;

const allLogLevels: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

export interface BootstrapOptions {
  packageJson?: {
    name: string;
    version: string;
  };
}

export async function simpleBootstrap(AppModule: IEntryNestModule, onInit?: (app: INestApplication) => Promise<void>) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  if (onInit) await onInit(app);
  await runApp(app).listen(SysEnv.PORT ?? 3100);
  return app;
}

export async function bootstrap(
  AppModule: IEntryNestModule,
  onInit?: (app: INestApplication) => Promise<void>,
  options?: BootstrapOptions,
) {
  if (!process.env.NODE_ENV) throw new Error('NODE_ENV is not set');

  const now = Date.now();
  const logLevel: LogLevel = SysEnv.LOG_LEVEL || 'debug';
  const levels = allLogLevels.slice(allLogLevels.indexOf(logLevel), allLogLevels.length);

  const notShowLogLevels = allLogLevels.slice(0, allLogLevels.indexOf(logLevel));
  Logger.log(`[Config] Log level set to "${SysEnv.LOG_LEVEL}" - Enabled levels: ${levels.join(', ')}`, 'Bootstrap');
  if (notShowLogLevels.length) {
    Logger.warn(`[Config] Disabled log levels: ${notShowLogLevels.join(', ')}`, 'Bootstrap');
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: levels,
  });
  app.set('query parser', 'extended');

  app.useGlobalPipes(new ValidationPipe({ enableDebugMessages: true, transform: true, whitelist: true }));

  // 先使用无翻译功能的过滤器，稍后通过应用引用注入
  app.useGlobalFilters(new AnyExceptionFilter(app));
  Logger.log('[Config] AnyExceptionFilter initialized with app reference for lazy i18n support', 'Bootstrap');

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
  const corsOptions: CorsOptions | CorsOptionsDelegate<any> = {
    credentials: true,
    origin: true, // reflect from req.header('Origin') TODO dynamic from a function with whitelist
    // allowedHeaders: '*',
    // methods: '*',
  };
  Logger.log(`[Config] CORS enabled with options: ${JSON.stringify(corsOptions)}`, 'Bootstrap');
  app.enableCors(corsOptions);

  // see https://expressjs.com/en/guide/behind-proxies.html
  // 设置以后，req.ips 是 ip 数组；如果未经过代理，则为 []. 若不设置，则 req.ips 恒为 []
  // app.set('trust proxy', true);
  app.set('trust proxy', 1);
  if (SysEnv.SESSION_SECRET) {
    const client = new Redis(AppEnvs.REDIS_URL, { maxRetriesPerRequest: 3 });
    Logger.log(`[Config] Session enabled with secret: "${maskSecret(SysEnv.SESSION_SECRET)}"`, 'Bootstrap');
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
  app.use(morgan('combined'));

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
      Logger.log(
        stripIndent`🦋 [Server] API Server started successfully
          ENV: ${SysEnv.environment.env} [IsProd: ${SysEnv.environment.isProd}, NODE: ${process.env.NODE_ENV}|${SysEnv.NODE_ENV}, DOPPLER: ${SysEnv.DOPPLER_ENVIRONMENT}]
          App Version: ${options?.packageJson?.name ?? 'unknown'}-v${options?.packageJson?.version ?? 'unknown'}
          Host: ${os.hostname()}
          Node Name: ${SysEnv.NODE_NAME}
          Bind: ${bindAddress}
          Port: ${port}
          PID: ${process.pid}
          Platform: ${process.platform}
          Node Version: ${process.version}
          SysEnv.TZ Time: ${startTime.setZone(SysEnv.TZ).toFormat('yyyy-MM-dd EEEE HH:mm:ss')} (${startTime.setZone(SysEnv.TZ).zoneName})
          Local Time: ${startTime.setZone('local').toFormat('yyyy-MM-dd EEEE HH:mm:ss')} (${startTime.setZone('local').zoneName})
          UTC Time: ${startTime.toFormat('yyyy-MM-dd EEEE HH:mm:ss')}
          Startup Time: ${Date.now() - now}ms
        `,
        'Bootstrap',
      );
      initStackTraceFormatter();
    });

  return app;
}
