export function withObject<T, R>(o: T, fn: (o: T) => R): R {
  return fn(o);
}
