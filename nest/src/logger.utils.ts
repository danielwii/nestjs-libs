import { ConsoleLogger } from '@nestjs/common';

import { onelineStack } from '@app/utils';

export function initStackTraceFormatter() {
  ConsoleLogger.prototype.warn = wrapPrototype(ConsoleLogger.prototype.warn);
  ConsoleLogger.prototype.error = wrapPrototype(ConsoleLogger.prototype.error);
}

export function wrapPrototype(prototype) {
  return {
    [prototype.name]: function (...args: any[]) {
      if (args.length === 3 && args[1]) {
        args[0] = args[0] + ' ' + onelineStack(args[1]);
        args[1] = undefined;
        // console.log('args 1 is', { args1: args[1] });
      }
      prototype.apply(this, args);
    },
  }[prototype.name];
}
