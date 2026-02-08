import type { Container, DepsDefinition, Factory, ScopeOptions } from '../domain/types.js';
import { Resolver } from '../infrastructure/proxy-handler.js';
import { buildContainerProxy } from './create-container.js';

/**
 * Creates a child (scoped) container that inherits the parent's singletons
 * and can add/override dependencies. Scoped singletons are independent from the parent.
 *
 * @example
 * ```typescript
 * const request = createScope(parentResolver, {
 *   requestId: () => crypto.randomUUID(),
 *   currentUser: () => extractUser(req),
 * }, { name: 'request-123' });
 * ```
 */
export function createScope<
  TExtra extends DepsDefinition,
>(
  parentResolver: Resolver,
  extra: TExtra,
  options?: ScopeOptions,
): Container<any> {
  const childFactories = new Map<string, Factory>();
  for (const [key, factory] of Object.entries(extra)) {
    childFactories.set(key, factory as Factory);
  }

  const childResolver = new Resolver(childFactories, new Map(), parentResolver, options?.name);
  return buildContainerProxy(childResolver);
}
