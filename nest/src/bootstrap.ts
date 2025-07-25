import {
  ClassSerializerInterceptor,
  DynamicModule,
  ForwardReference,
  INestApplication,
  Logger,
  LogLevel,
  Type,
  ValidationPipe,
} from '@nestjs/common';
import { CorsOptions, CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import { NestExpressApplication } from '@nestjs/platform-express';
import { RedisStore } from 'connect-redis';
import { stripIndent } from 'common-tags';
import responseTime from 'response-time';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import compression from 'compression';
import { DateTime } from 'luxon';
import Redis from 'ioredis';
import helmet from 'helmet';

import { AnyExceptionFilter } from '@app/nest/any-exception.filter';
import { VisitorInterceptor } from '@app/nest/visitor.interceptor';
import { LoggerInterceptor } from '@app/nest/logger.interceptor';
import { initStackTraceFormatter } from '@app/nest/logger.utils';
import { NestFactory, Reflector } from '@nestjs/core';
import { runApp } from '@app/nest/lifecycle';
import { doMigration } from './migration';
import { maskSecret } from '@app/utils';
import { SysEnv } from '@app/env';
import { AppEnvs } from '@/env';
import { json } from 'express';
import morgan from 'morgan';
import os from 'node:os';

type IEntryNestModule = Type<any> | DynamicModule | ForwardReference | Promise<IEntryNestModule>;

const allLogLevels: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

export async function simpleBootstrap(AppModule: IEntryNestModule, onInit?: (app: INestApplication) => Promise<void>) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  if (onInit) await onInit(app);
  await runApp(app).listen(SysEnv.PORT ?? 3100);
  return app;
}

export async function bootstrap(AppModule: IEntryNestModule, onInit?: (app: INestApplication) => Promise<void>) {
  await doMigration();

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
  app.useGlobalFilters(new AnyExceptionFilter());
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
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
        // 不压缩 event-stream 响应，因为 event-stream 响应是流式响应，压缩后会导致响应流式响应中断，目前主要是遇到了 AI-SDK 直接返回了最终结果，没有流式响应
        if (res.getHeader('Content-Type') === 'text/event-stream') {
          return false;
        }
        return compression.filter(req, res);
      },
    }),
  );
  app.use(responseTime());
  app.use(json({ limit: '1mb' }));

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
