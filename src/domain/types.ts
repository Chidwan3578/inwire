/**
 * A factory function that receives the container and returns an instance.
 *
 * @example
 * ```typescript
 * const factory: Factory<MyService> = (c) => new MyService(c.db);
 * ```
 */
export type Factory<T = any> = (container: any) => T;

/**
 * An object of factory functions — the definition of a container.
 * Each key maps to a factory that produces the dependency.
 *
 * @example
 * ```typescript
 * const deps: DepsDefinition = {
 *   logger: () => new LoggerService(),
 *   db: () => new Database(process.env.DB_URL!),
 *   userRepo: (c) => new PgUserRepo(c.db),
 * };
 * ```
 */
export type DepsDefinition = Record<string, Factory>;

/**
 * Extracts the resolved types from a deps definition.
 * Maps each key to the return type of its factory function.
 *
 * @example
 * ```typescript
 * type Resolved = ResolvedDeps<{ logger: () => LoggerService }>;
 * // { logger: LoggerService }
 * ```
 */
export type ResolvedDeps<T extends DepsDefinition> = {
  readonly [K in keyof T]: ReturnType<T[K]>;
};

/**
 * Reserved method names on the container that cannot be used as dependency keys.
 */
export const RESERVED_KEYS = [
  'scope',
  'extend',
  'preload',
  'reset',
  'inspect',
  'describe',
  'health',
  'dispose',
  'toString',
] as const;

export type ReservedKey = (typeof RESERVED_KEYS)[number];

/**
 * Options for creating a scoped container.
 */
export interface ScopeOptions {
  /** Optional name for the scope, useful for debugging and introspection. */
  name?: string;
}

/**
 * Full container type exposed to the user.
 * Combines resolved dependencies with container methods.
 *
 * @example
 * ```typescript
 * const container: Container<{ logger: LoggerService }> = createContainer({
 *   logger: () => new LoggerService(),
 * });
 * container.logger; // LoggerService
 * container.inspect(); // ContainerGraph
 * ```
 */
export type Container<T extends Record<string, any> = Record<string, any>> =
  T & IContainer<T>;

/**
 * Container methods interface. Defines the API available on every container.
 */
export interface IContainer<T extends Record<string, any> = Record<string, any>> {
  /**
   * Creates a child container with additional dependencies.
   * Child inherits all parent singletons and can add/override deps.
   *
   * @example
   * ```typescript
   * const request = app.scope({
   *   requestId: () => crypto.randomUUID(),
   *   currentUser: () => extractUser(req),
   * });
   * request.requestId; // scoped singleton
   * request.logger;    // inherited from parent
   * ```
   */
  scope<E extends DepsDefinition>(extra: E, options?: ScopeOptions): Container<T & ResolvedDeps<E>>;

  /**
   * Returns a new container with additional dependencies.
   * Existing singletons are shared. The original container is not modified.
   *
   * @example
   * ```typescript
   * const appWithAuth = app.extend(authDeps);
   * ```
   */
  extend<E extends DepsDefinition>(extra: E): Container<T & ResolvedDeps<E>>;

  /**
   * Pre-resolves dependencies (warm-up).
   * Call with specific keys to resolve only those, or without arguments to resolve all.
   *
   * @example
   * ```typescript
   * await container.preload('db', 'cache'); // specific deps
   * await container.preload();              // all deps
   * ```
   */
  preload(...keys: (keyof T)[]): Promise<void>;

  /**
   * Returns the full dependency graph as a serializable JSON object.
   * Useful for AI analysis of the architecture.
   *
   * @example
   * ```typescript
   * container.inspect();
   * // { providers: { logger: { key: 'logger', resolved: true, deps: [], scope: 'singleton' } } }
   * ```
   */
  inspect(): ContainerGraph;

  /**
   * Returns detailed information about a specific provider.
   *
   * @example
   * ```typescript
   * container.describe('userService');
   * // { key: 'userService', resolved: true, deps: ['userRepo', 'logger'], scope: 'singleton' }
   * ```
   */
  describe(key: keyof T): ProviderInfo;

  /**
   * Returns container health status and warnings.
   *
   * @example
   * ```typescript
   * container.health();
   * // { totalProviders: 12, resolved: ['db', 'logger'], unresolved: ['cache'], warnings: [] }
   * ```
   */
  health(): ContainerHealth;

  /**
   * Invalidates cached singletons, forcing re-creation on next access.
   * Does not affect parent scopes.
   *
   * @example
   * ```typescript
   * container.reset('db');       // reset one
   * container.reset('db', 'cache'); // reset multiple
   * ```
   */
  reset(...keys: (keyof T)[]): void;

  /**
   * Disposes the container. Calls `onDestroy()` on all resolved instances
   * that implement it, in reverse resolution order.
   *
   * @example
   * ```typescript
   * await container.dispose();
   * ```
   */
  dispose(): Promise<void>;
}

/**
 * Full dependency graph of the container.
 */
export interface ContainerGraph {
  name?: string;
  providers: Record<string, ProviderInfo>;
}

/**
 * Detailed information about a single provider/dependency.
 */
export interface ProviderInfo {
  key: string;
  resolved: boolean;
  deps: string[];
  scope: 'singleton' | 'transient';
}

/**
 * Container health status with warnings.
 */
export interface ContainerHealth {
  totalProviders: number;
  resolved: string[];
  unresolved: string[];
  warnings: ContainerWarning[];
}

/**
 * A warning detected by the container's runtime analysis.
 */
export interface ContainerWarning {
  type: 'scope_mismatch' | 'duplicate_key';
  message: string;
  details: Record<string, unknown>;
}

/**
 * Interface for the resolver — the core engine behind the Proxy.
 */
export interface IResolver<T extends DepsDefinition = DepsDefinition> {
  resolve(key: string): unknown;
  isResolved(key: string): boolean;
  getDepGraph(): Map<string, string[]>;
  getResolvedKeys(): string[];
  getFactories(): Map<string, Factory>;
  getCache(): Map<string, unknown>;
}

/**
 * Interface for config and runtime validation.
 */
export interface IValidator {
  validateConfig(config: Record<string, unknown>): void;
  suggestKey(key: string, registered: string[]): string | undefined;
}
