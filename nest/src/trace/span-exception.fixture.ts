import 'reflect-metadata';

import { ErrorCodes } from '@app/nest/exceptions/error-codes';
import { Oops } from '@app/nest/exceptions/oops';

import { openStageScope, runStageScope } from './stage-scope';
import { withTelemetrySpan } from './telemetry-span';
import { Trace } from './trace.decorator';

import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const probe = process.argv[2] ?? 'probe';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
provider.register();

class Traced {
  @Trace('decorated.fail')
  async fail(): Promise<void> {
    throw new RangeError(`${probe} decorated message`);
  }
}

// An error whose constructor getter throws: describing it must not replace it with a different failure.
const hostile = Object.defineProperty(new TypeError(`${probe} hostile message`), 'constructor', {
  get() {
    throw new RangeError(`${probe} constructor getter`);
  },
});
let hostilePropagated = false;

const attempts: Array<() => Promise<unknown>> = [
  () =>
    runStageScope('fixture', 'stage.fail', async () => {
      throw new TypeError(`${probe} stage message`, { cause: new RangeError(`${probe} stage cause`) });
    }),
  () =>
    withTelemetrySpan({
      name: 'telemetry.oops',
      executor: async () => {
        throw new Oops.Panic({
          errorCode: ErrorCodes.SYSTEM_INTERNAL_ERROR,
          oopsCode: 'SYS01',
          userMessage: `${probe} user message`,
          internalDetails: `${probe} internal details`,
        });
      },
    }),
  () =>
    withTelemetrySpan({
      name: 'telemetry.coded',
      executor: async () => {
        throw Object.assign(new Error(`${probe} coded message`, { cause: new TypeError(`${probe} coded cause`) }), {
          code: 'ECONNRESET',
        });
      },
    }),
  () =>
    withTelemetrySpan({
      name: 'telemetry.string',
      executor: async () => {
        // the case under test is a thrown value that is not an Error
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw `${probe} thrown string`;
      },
    }),
  async () => {
    const scope = openStageScope('fixture', 'stage.manual');
    scope.end(Object.assign(new Error(`${probe} manual message`), { code: `${probe} free text code` }));
  },
  () => new Traced().fail(),
  async () => {
    try {
      await runStageScope('fixture', 'stage.hostile', async () => {
        throw hostile;
      });
    } catch (caught) {
      hostilePropagated = caught === hostile;
      throw caught;
    }
  },
];

for (const attempt of attempts) {
  try {
    await attempt();
  } catch {
    // each attempt is expected to fail; the exported span is what the spec inspects
  }
}

await provider.forceFlush();

const spans = exporter.getFinishedSpans().map((span) => ({
  name: span.name,
  attributes: span.attributes,
  status: span.status,
  events: span.events.map((event) => ({ name: event.name, attributes: event.attributes })),
}));

process.stdout.write(`${JSON.stringify({ spans, hostilePropagated })}\n`);
await provider.shutdown();
