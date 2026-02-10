import { describe, it, expect, expectTypeOf } from 'vitest';
import { createContainer, transient, ContainerConfigError, ProviderNotFoundError, CircularDependencyError, FactoryError, UndefinedReturnError, ReservedKeyError } from '../src/index.js';
import type { DepsDefinition } from '../src/index.js';

describe('TypeScript type inference', () => {
  it('infers correct types for simple factories', () => {
    const container = createContainer({
      num: () => 42,
      str: () => 'hello',
      obj: () => ({ x: 1, y: 2 }),
    });

    expectTypeOf(container.num).toEqualTypeOf<number>();
    expectTypeOf(container.str).toEqualTypeOf<string>();
    expectTypeOf(container.obj).toEqualTypeOf<{ x: number; y: number }>();
  });

  it('infers types through dependency chains', () => {
    const container = createContainer({
      base: () => 10,
      doubled: (c) => c.base * 2,
    });

    // doubled's type is inferred from the return of the factory
    expect(typeof container.doubled).toBe('number');
  });

  it('respects explicit return type annotations (interface-first)', () => {
    interface Repository {
      findById(id: string): string;
    }

    class PgRepo implements Repository {
      findById(id: string) { return `pg:${id}`; }
      pgSpecific() { return 'pg'; }
    }

    const container = createContainer({
      repo: (): Repository => new PgRepo(),
    });

    // The type is Repository, not PgRepo
    expectTypeOf(container.repo).toEqualTypeOf<Repository>();

    // This would be a type error:
    // container.repo.pgSpecific(); // Property 'pgSpecific' does not exist on type 'Repository'
  });

  it('transient preserves return type', () => {
    const container = createContainer({
      id: transient(() => crypto.randomUUID()),
    });

    expectTypeOf(container.id).toEqualTypeOf<string>();
  });

  it('satisfies DepsDefinition constraint', () => {
    const deps = {
      logger: () => ({ log: (msg: string) => console.log(msg) }),
      db: () => 'connection-string',
    } satisfies DepsDefinition;

    const container = createContainer(deps);
    expect(container.db).toBe('connection-string');
  });

  it('scope extends the container type', () => {
    const parent = createContainer({
      db: () => 'postgres',
    });

    const child = parent.scope({
      requestId: () => 'req-123',
    });

    expectTypeOf(child.db).toEqualTypeOf<string>();
    expectTypeOf(child.requestId).toEqualTypeOf<string>();
  });

  it('extend extends the container type', () => {
    const base = createContainer({
      a: () => 1,
    });

    const extended = base.extend({
      b: () => 'hello',
    });

    expectTypeOf(extended.a).toEqualTypeOf<number>();
    expectTypeOf(extended.b).toEqualTypeOf<string>();
  });

  it('scope override replaces type instead of intersecting', () => {
    const parent = createContainer({
      value: () => 'hello',
    });

    const child = parent.scope({
      value: () => 42,
    });

    expectTypeOf(child.value).toEqualTypeOf<number>();
  });

  it('extend override replaces type instead of intersecting', () => {
    const base = createContainer({
      value: () => 'hello',
    });

    const extended = base.extend({
      value: () => 42,
    });

    expectTypeOf(extended.value).toEqualTypeOf<number>();
  });

  it('error details have correct types', () => {
    const configError = new ContainerConfigError('key', 'string');
    expectTypeOf(configError.details.key).toBeString();
    expectTypeOf(configError.details.actualType).toBeString();

    const notFoundError = new ProviderNotFoundError('key', ['a'], ['b'], 'c');
    expectTypeOf(notFoundError.details.key).toBeString();
    expectTypeOf(notFoundError.details.chain).toEqualTypeOf<string[]>();
    expectTypeOf(notFoundError.details.registered).toEqualTypeOf<string[]>();
    expectTypeOf(notFoundError.details.suggestion).toEqualTypeOf<string | undefined>();

    const circularError = new CircularDependencyError('key', ['a']);
    expectTypeOf(circularError.details.key).toBeString();
    expectTypeOf(circularError.details.chain).toEqualTypeOf<string[]>();
    expectTypeOf(circularError.details.cycle).toBeString();

    const factoryError = new FactoryError('key', ['a'], new Error('test'));
    expectTypeOf(factoryError.details.key).toBeString();
    expectTypeOf(factoryError.details.chain).toEqualTypeOf<string[]>();
    expectTypeOf(factoryError.details.originalError).toBeString();

    const undefinedError = new UndefinedReturnError('key', ['a']);
    expectTypeOf(undefinedError.details.key).toBeString();
    expectTypeOf(undefinedError.details.chain).toEqualTypeOf<string[]>();

    const reservedError = new ReservedKeyError('scope', ['scope']);
    expectTypeOf(reservedError.details.key).toBeString();
    expectTypeOf(reservedError.details.reserved).toEqualTypeOf<string[]>();
  });

  it('preload and reset accept keyof T', () => {
    const container = createContainer({
      db: () => 'postgres',
      cache: () => new Map(),
    });

    // These should compile — keyof T restricts to 'db' | 'cache'
    expectTypeOf(container.preload).parameter(0).toEqualTypeOf<'db' | 'cache'>();
    expectTypeOf(container.reset).parameter(0).toEqualTypeOf<'db' | 'cache'>();
  });

  it('createContainer with empty object produces typed container', () => {
    const container = createContainer({});

    // Container methods still exist on empty container
    expectTypeOf(container.inspect).toBeFunction();
    expectTypeOf(container.dispose).toBeFunction();
    expectTypeOf(container.health).toBeFunction();
  });
});
