import { ConsoleLogger } from '@nestjs/common';

import { onelineStack } from '@app/utils/error';

export function initStackTraceFormatter() {
  // eslint-disable-next-line @typescript-eslint/unbound-method
  ConsoleLogger.prototype.warn = wrapPrototype(ConsoleLogger.prototype.warn);
  // eslint-disable-next-line @typescript-eslint/unbound-method
  ConsoleLogger.prototype.error = wrapPrototype(ConsoleLogger.prototype.error);
}

export function wrapPrototype<T extends (...args: unknown[]) => unknown>(prototype: T): T {
  const p = prototype as unknown as (...args: unknown[]) => unknown;
  const name = (prototype as { name?: string }).name || 'anonymous';

  const wrapped = function (this: unknown, ...args: unknown[]) {
    if (args.length === 3 && args[1]) {
      args[0] = `${args[0] as string} ${onelineStack(args[1] as string)}`;
      args[1] = undefined;
    }
    return p.apply(this, args);
  };

  Object.defineProperty(wrapped, 'name', { value: name });
  return wrapped as unknown as T;
}
