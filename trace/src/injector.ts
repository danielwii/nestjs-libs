export interface Injector {
  inject(): Promise<void> | void;
}
