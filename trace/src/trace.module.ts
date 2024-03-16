import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SentryPropagator, SentrySpanProcessor } from '@sentry/opentelemetry-node';

import { DynamicModule, Logger, Module } from '@nestjs/common';

import { AppEnv } from '@app/env';

import { Injector } from './injector';
import { LoggerInjector } from './logger.injector';

interface TraceModuleOptions {}

@Module({})
export class TraceModule {
  static forRootAsync({}: TraceModuleOptions): DynamicModule {
    Logger.log(`run tracing...`, 'TraceModule');
    this.runTracing();
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

  static runTracing() {
    // For troubleshooting, set the log level to DiagLogLevel.DEBUG
    // diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);
    if (AppEnv.TRACING_ENABLED) {
      const serviceName = AppEnv.SERVICE_NAME ?? `api-server`;
      const exporterUrl = AppEnv.TRACING_EXPORTER_URL ?? 'http://localhost:4318/v1/traces';
      Logger.log(`<OTEL> Tracing enabled. Service name: ${serviceName}, exporter url: ${exporterUrl}`);
      const traceExporter = new OTLPTraceExporter({ url: exporterUrl });
      // const metricExporter = new OTLPMetricExporter({ url: exporterUrl });
      // const spanProcessor = isProduction ? new BatchSpanProcessor(traceExporter) : new SimpleSpanProcessor(traceExporter);
      const sdk = new NodeSDK({
        serviceName,
        traceExporter,
        // metricReader: new PeriodicExportingMetricReader({ exporter: new ConsoleMetricExporter() }),
        instrumentations: [getNodeAutoInstrumentations()],
        spanProcessor: new SentrySpanProcessor(),
        textMapPropagator: new SentryPropagator(),
      });
      sdk.start();
    } else {
      Logger.log(`<OTEL> Tracing disabled.`);
    }
  }
}
