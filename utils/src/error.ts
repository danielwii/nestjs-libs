import * as process from 'node:process';

export function errorStack(e: unknown): string | undefined {
  if (e instanceof Error) {
    return onelineStack(e.stack);
  }
  console.warn(`unresolved error type: ${typeof e}`);
  return undefined;
}

export function onelineStack(stack: string | undefined | null): string | undefined {
  if (!stack || typeof stack !== 'string') {
    return undefined;
  }

  return (
    'StackTrace: ' +
    (process.env.NODE_ENV === 'production'
      ? stack
          .replace(/^.*[\\/]node_modules[\\/].*$/gm, '')
          .split('\n')
          .slice(0, 2)
          .join('\n')
      : stack)
  );
}
