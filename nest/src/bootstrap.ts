import { ClassSerializerInterceptor, INestApplication, Logger, LogLevel, ValidationPipe } from '@nestjs/common';
import { CorsOptions, CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory, Reflector } from '@nestjs/core';
import responseTime from 'response-time';
import { oneLine } from 'common-tags';
import compression from 'compression';
import { format } from 'date-fns';
import { DateTime } from 'luxon';
import helmet from 'helmet';

import { AnyExceptionFilter } from '@app/nest/any-exception.filter';
import { VisitorInterceptor } from '@app/nest/visitor.interceptor';
import { LoggerInterceptor } from '@app/nest/logger.interceptor';
import { initStackTraceFormatter } from '@app/nest/logger.utils';
import { f, TimeSensitivity } from '@app/utils';
import { runApp } from '@app/nest/lifecycle';
import { AppEnv } from '@app/env';
import os from 'node:os';

const allLogLevels: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];

export async function bootstrap(AppModule: any, onInit?: (app: INestApplication) => Promise<void>) {
  const now = Date.now();
  const levels = allLogLevels.slice(
    allLogLevels.indexOf((AppEnv.LOG_LEVEL || 'debug') as LogLevel),
    allLogLevels.length,
  );

  Logger.log(f`setup log level ${AppEnv.LOG_LEVEL} - ${levels}`, 'Bootstrap');
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: levels,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      enableDebugMessages: true,
      transform: true,
      whitelist: true,
    }),
  );
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
  Logger.log(f`setup cors ${corsOptions}`, 'Bootstrap');
  app.enableCors(corsOptions);

  // see https://expressjs.com/en/guide/behind-proxies.html
  // 设置以后，req.ips 是 ip 数组；如果未经过代理，则为 []. 若不设置，则 req.ips 恒为 []
  app.set('trust proxy', true);
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

  app.disable('x-powered-by');

  app.use(compression());
  app.use(responseTime());

  const port = AppEnv.PORT ?? 3100;

  if (onInit) await onInit(app);

  await runApp(app)
    .listen(port)
    .then(() => {
      Logger.log(
        oneLine`
          🦋 (${os.hostname()}) Listening on port ${port}. in ${Date.now() - now}ms,
          pid:${process.pid} platform:${process.platform} node_version:${process.version}
          at ${format(DateTime.now().setZone(AppEnv.TZ).toJSDate(), TimeSensitivity.Minute)} |
          ${DateTime.now().setZone(AppEnv.TZ).toLocaleString(DateTime.DATETIME_FULL)} | ${AppEnv.TZ}.
        `,
        'Bootstrap',
      );
      initStackTraceFormatter();
    });

  return app;
}
