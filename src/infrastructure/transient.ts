import type { Factory } from '../domain/types.js';

/**
 * Symbol used to mark a factory as transient.
 * Transient factories create a new instance on every access.
 */
export const TRANSIENT_MARKER = Symbol.for('inwire:transient');

/**
 * A factory wrapper that marks it as transient.
 */
export interface TransientFactory<T = unknown> {
  (container: unknown): T;
  [TRANSIENT_MARKER]: true;
}

/**
 * Wraps a factory function to produce a new instance on every access,
 * instead of the default singleton behavior.
 *
 * @example
 * ```typescript
 * import { container, transient } from 'inwire';
 *
 * const app = container()
 *   .add('logger', () => new LoggerService())                 // singleton (default)
 *   .addTransient('requestId', () => crypto.randomUUID())     // new instance every access
 *   .build();
 *
 * app.requestId; // 'abc-123'
 * app.requestId; // 'def-456' (different!)
 * ```
 */
export function transient<T>(factory: Factory<T>): Factory<T> {
  const wrapper = ((container: unknown) => factory(container)) as TransientFactory<T>;
  wrapper[TRANSIENT_MARKER] = true;
  return wrapper;
}

/** Checks if a factory is marked as transient. */
export function isTransient(factory: unknown): factory is TransientFactory {
  return (
    typeof factory === 'function' &&
    TRANSIENT_MARKER in factory &&
    (factory as Record<symbol, unknown>)[TRANSIENT_MARKER] === true
  );
}
