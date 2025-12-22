import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContextStore = Map<string, unknown>;

export class RequestContext {
  private static storage = new AsyncLocalStorage<RequestContextStore>();

  static run<T>(initial: Record<string, unknown> | undefined, callback: () => T): T {
    const store = new Map<string, unknown>(initial ? Object.entries(initial) : undefined);
    return RequestContext.storage.run(store, callback);
  }

  static get<T>(key: string): T | undefined {
    const store = RequestContext.storage.getStore();
    if (!store) {
      return undefined;
    }
    return store.get(key) as T | undefined;
  }

  static set(key: string, value: unknown): void {
    const store = RequestContext.storage.getStore();
    if (!store) {
      return;
    }
    if (value === undefined) {
      store.delete(key);
    } else {
      store.set(key, value);
    }
  }

  static entries(): Record<string, unknown> | undefined {
    const store = RequestContext.storage.getStore();
    if (!store) {
      return undefined;
    }
    return Object.fromEntries(store.entries());
  }
}
