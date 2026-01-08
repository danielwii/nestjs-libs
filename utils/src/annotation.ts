export const METADATA_KEYS = {
  NAMED: 'app:named',
};

export const named: MethodDecorator = (_target, propertyKey, descriptor) => {
  const originalMethod = descriptor.value;
  // @ts-expect-error -- descriptor.value type is unknown in MethodDecorator
  descriptor.value = function (...args: unknown[]) {
    // @ts-expect-error -- originalMethod is untyped from descriptor.value
    return Reflect.apply(originalMethod, this, [...args, propertyKey]);
  };

  Reflect.defineMetadata(METADATA_KEYS.NAMED, String(propertyKey), descriptor.value as (...args: unknown[]) => unknown);
  return descriptor;
};
