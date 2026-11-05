/**
 * Runs a real Nest app (Express adapter, global prefix) with otelTraceMiddleware, LoggerInterceptor, AnyExceptionFilter and
 * the LogTape Nest logger under a real tracer provider, sends requests that carry a token in the path and the query string, and
 * prints the exported spans and the `spanName` every log line was written with.
 *
 * A separate process because registering a global tracer provider would leak into every other spec in the run.
 */
import 'reflect-metadata';

import {
  Controller,
  Get,
  Logger,
  Module,
  NotFoundException,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AnyExceptionFilter } from '@app/nest/exceptions/any-exception.filter';
import { LoggerInterceptor } from '@app/nest/interceptors/logger.interceptor';
import { LogtapeNestLogger } from '@app/nest/logging/nest-logger';

import { otelTraceMiddleware } from './otel-trace.middleware';

import { configure } from '@logtape/logtape';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import type { LogRecord } from '@logtape/logtape';
import type { CanActivate } from '@nestjs/common';
import type { AddressInfo } from 'node:net';

const [pathToken = 'path-token', queryToken = 'query-token'] = process.argv.slice(2);

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

const records: LogRecord[] = [];
await configure({
  reset: true,
  sinks: {
    memory: (record) => {
      if (record.category[0] !== 'logtape') records.push(record);
    },
  },
  loggers: [{ category: [], sinks: ['memory'], lowestLevel: 'debug' }],
});

class RejectingGuard implements CanActivate {
  private readonly logger = new Logger('RejectingGuard');

  canActivate(): boolean {
    this.logger.log('guard ran');
    throw new UnauthorizedException();
  }
}

@Controller()
class InviteController {
  private readonly logger = new Logger('InviteController');

  @Get('invites/:token')
  get(): { ok: boolean } {
    this.logger.log('handler ran');
    return { ok: true };
  }

  @Get('members/:id')
  member(): never {
    throw new NotFoundException('Member not found');
  }

  @Post('members/:token/withdraw-invite')
  @UseGuards(RejectingGuard)
  withdraw(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({ controllers: [InviteController] })
class FixtureModule {}

const app = await NestFactory.create(FixtureModule, { logger: new LogtapeNestLogger() });
app.setGlobalPrefix('api');
app.use(otelTraceMiddleware);
app.useGlobalInterceptors(new LoggerInterceptor());
// as bootstrap does in api mode: the filter logs a 404 for an unknown path at warning level
app.useGlobalFilters(new AnyExceptionFilter(app));
await app.listen(0, '127.0.0.1');
const baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

const statuses: number[] = [];
const requests: Array<[string, string]> = [
  ['GET', `/api/invites/${pathToken}?token=${queryToken}`],
  ['POST', `/api/members/${pathToken}/withdraw-invite?token=${queryToken}`],
  ['GET', `/api/unknown/segment?token=${queryToken}`],
  ['GET', `/outside/segment?token=${queryToken}`],
  ['GET', `/api/members/m_1?token=${queryToken}`],
];
for (const [method, path] of requests) {
  const response = await fetch(`${baseUrl}${path}`, { method });
  await response.arrayBuffer();
  statuses.push(response.status);
}

// spans end from the response's finish callback, which can land after the client has read the response
for (let i = 0; i < 100 && exporter.getFinishedSpans().length < requests.length; i++) await Bun.sleep(5);
await app.close();
await provider.forceFlush();

const spans = exporter.getFinishedSpans().map((span) => ({ name: span.name, attributes: span.attributes }));
const logs = records.map((record) => ({
  message: record.message.map(String).join(''),
  spanName: record.properties.spanName,
  properties: record.properties,
}));

process.stdout.write(`${JSON.stringify({ statuses, spans, logs })}\n`);
await provider.shutdown();
