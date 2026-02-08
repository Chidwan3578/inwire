import { describe, it, expect } from 'vitest';
import { createContainer } from '../src/index.js';

describe('reset', () => {
  it('reset forces re-creation on next access', () => {
    let callCount = 0;

    const container = createContainer({
      db: () => {
        callCount++;
        return { id: callCount };
      },
    });

    expect(container.db.id).toBe(1);
    expect(container.db.id).toBe(1); // cached

    container.reset('db');

    expect(container.db.id).toBe(2); // new instance
    expect(callCount).toBe(2);
  });

  it('reset does not affect other singletons', () => {
    let dbCount = 0;
    let cacheCount = 0;

    const container = createContainer({
      db: () => ({ id: ++dbCount }),
      cache: () => ({ id: ++cacheCount }),
    });

    container.db;
    container.cache;

    container.reset('db');

    expect(container.db.id).toBe(2); // re-created
    expect(container.cache.id).toBe(1); // untouched
  });

  it('reset on unresolved key is a silent no-op', () => {
    const container = createContainer({
      db: () => 'database',
    });

    // Should not throw
    container.reset('db');
  });

  it('reset + onInit: next access calls onInit again', () => {
    let initCount = 0;

    const container = createContainer({
      service: () => ({
        value: 'svc',
        onInit() { initCount++; },
      }),
    });

    container.service;
    expect(initCount).toBe(1);

    container.reset('service');

    container.service;
    expect(initCount).toBe(2);
  });

  it('reset in scope does not affect parent cache', () => {
    let parentCount = 0;

    const parent = createContainer({
      db: () => ({ id: ++parentCount }),
    });

    // Resolve in parent
    expect(parent.db.id).toBe(1);

    const child = parent.scope({
      db: () => ({ id: 999 }),
    });

    expect(child.db.id).toBe(999);

    child.reset('db');

    // Child re-creates its own
    expect(child.db.id).toBe(999);
    // Parent untouched
    expect(parent.db.id).toBe(1);
    expect(parentCount).toBe(1);
  });
});
