import { describe, expect, it } from 'vitest';
import {
  CircularDependencyError,
  container,
  FactoryError,
  ProviderNotFoundError,
} from '../src/index.js';

describe('error recovery', () => {
  it('after CircularDependencyError, other deps are still accessible', () => {
    const c = container()
      .add('a', (c: any) => c.b)
      .add('b', (c: any) => c.a)
      .add('safe', () => 42)
      .build();

    expect(() => c.a).toThrow(CircularDependencyError);
    expect(c.safe).toBe(42);
  });

  it('after FactoryError, unrelated deps still work', () => {
    const c = container()
      .add('broken', () => {
        throw new Error('boom');
      })
      .add('healthy', () => 'ok')
      .build();

    expect(() => c.broken).toThrow(FactoryError);
    expect(c.healthy).toBe('ok');
  });

  it('after FactoryError, retry re-throws (not cached)', () => {
    let callCount = 0;
    const c = container()
      .add('flaky', () => {
        callCount++;
        throw new Error(`attempt ${callCount}`);
      })
      .build();

    expect(() => c.flaky).toThrow('attempt 1');
    expect(() => c.flaky).toThrow('attempt 2');
    expect(callCount).toBe(2);
  });

  it('after ProviderNotFoundError, container is still functional', () => {
    const c = container()
      .add('db', () => 'postgres')
      .build();

    expect(() => (c as any).missing).toThrow(ProviderNotFoundError);
    expect(c.db).toBe('postgres');
  });

  it('reset after error allows re-resolution', () => {
    let shouldFail = true;
    const c = container()
      .add('service', () => {
        if (shouldFail) throw new Error('not ready');
        return 'ready';
      })
      .build();

    expect(() => c.service).toThrow(FactoryError);

    shouldFail = false;
    c.reset('service');
    expect(c.service).toBe('ready');
  });

  it('preload with one failing key — other keys still resolved', async () => {
    let goodFactoryCount = 0;
    const c = container()
      .add('good', () => {
        goodFactoryCount++;
        return {
          value: 'ok',
          onInit() {},
        };
      })
      .add('bad', () => ({
        async onInit() {
          throw new Error('init failed');
        },
      }))
      .build();

    await expect(c.preload()).rejects.toThrow('init failed');
    // good was resolved during preload (factory ran once), not on lazy access below
    expect(goodFactoryCount).toBe(1);
    expect(c.good.value).toBe('ok');
    expect(goodFactoryCount).toBe(1); // still 1 — cached from preload, not re-created
  });

  it('CircularDependencyError does not block resolving set (finally cleanup)', () => {
    const c = container()
      .add('a', (c: any) => c.b)
      .add('b', (c: any) => c.a)
      .add('standalone', () => 'works')
      .build();

    expect(() => c.a).toThrow(CircularDependencyError);
    // If resolving set was not cleaned, this would throw CircularDependencyError
    expect(() => c.a).toThrow(CircularDependencyError);
    expect(c.standalone).toBe('works');
  });

  it('nested factory error — FactoryError propagated with chain', () => {
    const c = container()
      .add('inner', () => {
        throw new Error('deep failure');
      })
      .add('outer', (c) => c.inner)
      .build();

    try {
      c.outer;
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(FactoryError);
      const err = e as FactoryError;
      expect(err.message).toContain('deep failure');
    }
  });
});
