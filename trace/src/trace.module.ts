import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { DynamicModule, Logger, Module } from '@nestjs/common';
import { compact, map } from 'lodash';

import { BatchSpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrismaInstrumentation } from '@prisma/instrumentation';
import { LoggerInjector } from './logger.injector';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { Injector } from './injector';
import { Response } from 'express';
import { SysEnv } from '@app/env';
import { AppEnvs } from '@/env';
import { f } from '@app/utils';

interface TraceModuleOptions {
  exporters?: {
    aiExporter?: SpanExporter;
  };
}

@Module({})
export class TraceModule {
  private static readonly logger = new Logger('TraceModule');

  static forRootAsync({ exporters }: TraceModuleOptions): DynamicModule {
    this.logger.log(`run tracing...`);
    this.sdkStart(exporters);
    return {
      module: TraceModule,
      imports: [],
      providers: [
        LoggerInjector,
        /*
        {
          provide: TraceService,
          useFactory: async (configService: ConfigService) => {
            const serviceName = configService.get<string>('SERVICE_NAME', 'api-server');
            Logger.log(`[TraceModule] serviceName: ${serviceName}`);
            const service = new TraceService();
            // service.start();
            return service;
          },
          inject: [ConfigService],
        },*/
        {
          provide: 'injectors',
          useFactory: async (...injectors: Injector[]) => {
            for (const injector of injectors) await injector.inject();
          },
          inject: [
            // DecoratorInjector,
            // ...(injectors as Function[]),
            LoggerInjector,
          ],
        },
      ],
    };
  }

  static sdkStart({ aiExporter }: TraceModuleOptions['exporters'] = {}) {
    // For troubleshooting, set the log level to DiagLogLevel.DEBUG
    // diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    if (SysEnv.TRACING_ENABLED) {
      const serviceName = SysEnv.SERVICE_NAME ?? `api-server`;
      const exporterUrl = SysEnv.TRACING_EXPORTER_URL ?? 'http://localhost:4318/v1/traces';
      this.logger.log(`#sdkStart Tracing enabled. Service name: ${serviceName}, exporter url: ${exporterUrl}`);
      const traceExporter = new OTLPTraceExporter({ url: exporterUrl });
      // const metricExporter = new OTLPMetricExporter({ url: exporterUrl });
      // const spanProcessor = isProduction ? new BatchSpanProcessor(traceExporter) : new SimpleSpanProcessor(traceExporter);
      const autoInstrumentations = getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          responseHook: (span, response) => {
            const traceID = span.spanContext().traceId;
            (response as Response).setHeader('X-Trace-Id', traceID);
          },
        },
      });
      this.logger.debug(
        f`#sdkStart autoInstrumentations: ${map(autoInstrumentations, 'instrumentationName').join(', ')}`,
      );

      if (aiExporter) this.logger.log(`#sdkStart Langfuse exporter enabled. to: ${AppEnvs.LANGFUSE_HOST}`);

      const sdk = new NodeSDK({
        serviceName,
        spanProcessors: compact([
          new BatchSpanProcessor(traceExporter),
          aiExporter && new BatchSpanProcessor(aiExporter),
        ]),
        // traceExporter: new MultiSpanProcessor([traceExporter, langfuseExporter]), // 使用 LangfuseExporter
        // metricReader: new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() }),
        instrumentations: [autoInstrumentations, new PrismaInstrumentation()],
      });
      sdk.start();
      this.logger.log(`#sdkStart sdk start.`);
    } else {
      this.logger.log(`#sdkStart Tracing disabled.`);
    }
  }
}
