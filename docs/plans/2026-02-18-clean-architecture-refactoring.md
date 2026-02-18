# Clean Architecture & SOLID Refactoring

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Refactorer inwire pour respecter pleinement Clean Architecture, SOLID et Clean Code — sans changer l'API publique.

**Architecture:** Décomposer `Resolver` (5 responsabilités) en collaborateurs SRP. Extraire `Preloader` et `Disposer` comme Use Cases applicatifs. Introduire des interfaces domaine (`IResolver`) pour respecter le DIP. Alléger `container-proxy.ts` en pur assembleur de Proxy.

**Tech Stack:** TypeScript strict, Vitest, tsdown (ESM), biome

---

## Principes directeurs

- **Aucun changement d'API publique** — les tests existants DOIVENT passer sans modification
- **TDD pour les nouveaux fichiers** — test unitaire d'abord, implémentation ensuite
- **Les tests existants = filet de sécurité** — les lancer après chaque étape
- **Commit après chaque tâche verte**

## Architecture cible

```
src/
├── domain/                             # Contrats purs — AUCUNE dépendance externe
│   ├── types.ts                        # + IResolver, IDependencyTracker, ICycleDetector
│   ├── errors.ts                       # Inchangé
│   ├── lifecycle.ts                    # Inchangé
│   └── validation.ts                   # Inchangé
│
├── application/                        # Use Cases — orchestration
│   ├── container-builder.ts            # Inchangé (dépend de IResolver via infra)
│   ├── container-proxy.ts              # ALLÉGÉ — Proxy + dispatch seulement
│   ├── introspection.ts               # Dépend de IResolver (pas Resolver)
│   ├── preloader.ts                    # NEW — Use Case preload (Kahn + onInit)
│   └── disposer.ts                     # NEW — Use Case dispose (reverse + onDestroy)
│
├── infrastructure/                     # Implémentations concrètes
│   ├── resolver.ts                     # ALLÉGÉ — résolution + cache + parent chain
│   ├── cycle-detector.ts              # NEW — détection de cycles
│   ├── dependency-tracker.ts          # NEW — tracking proxy + depGraph
│   └── transient.ts                    # Inchangé
```

---

## Task 1: Définir les interfaces domaine (DIP)

**Fichiers:**
- Modify: `src/domain/types.ts`
- Test: lancer les tests existants (non-régression)

**Pourquoi:** Le Dependency Inversion Principle dit que les modules de haut niveau ne doivent pas dépendre des modules de bas niveau — les deux doivent dépendre d'abstractions. Aujourd'hui `container-proxy.ts` et `introspection.ts` dépendent directement de la classe `Resolver`. On crée les contrats dans le domaine.

**Step 1: Ajouter les interfaces dans `src/domain/types.ts`**

Ajouter après l'interface `IValidator` existante (ligne 229) :

```typescript
/**
 * Tracks which dependencies each factory accesses at resolution time.
 * Builds the dependency graph automatically via a tracking Proxy.
 */
export interface IDependencyTracker {
  createTrackingProxy(deps: string[], chain: string[], resolve: (key: string, chain: string[]) => unknown): unknown;
  getDepGraph(): Map<string, string[]>;
  recordDeps(key: string, deps: string[]): void;
  clearDepGraph(...keys: string[]): void;
  clearAllDepGraph(): void;
}

/**
 * Detects circular dependencies during resolution.
 */
export interface ICycleDetector {
  enter(key: string): void;
  leave(key: string): void;
  isResolving(key: string): boolean;
}

/**
 * Core resolver contract — resolves dependencies by key.
 * Used by application layer (Introspection, Preloader, Disposer, ContainerProxy).
 */
export interface IResolver {
  resolve(key: string, chain?: string[]): unknown;
  isResolved(key: string): boolean;
  getFactories(): Map<string, Factory>;
  getCache(): Map<string, unknown>;
  getDepGraph(): Map<string, string[]>;
  getResolvedKeys(): string[];
  getWarnings(): AnyWarning[];
  getAllRegisteredKeys(): string[];
  getName(): string | undefined;

  // Lifecycle delegation
  setDeferOnInit(defer: boolean): void;
  callOnInit(key: string): Promise<void>;
  getInitCalled(): Set<string>;
  clearInitState(...keys: string[]): void;
  clearAllInitState(): void;
  clearWarnings(): void;
  clearWarningsForKeys(...keys: string[]): void;
  clearDepGraph(...keys: string[]): void;
  clearAllDepGraph(): void;
}
```

Note: `AnyWarning` est importé depuis `./errors.js` — ajouter l'import `type` en haut du fichier.

**Step 2: Lancer les tests existants**

Run: `pnpm vitest run`
Expected: tous les tests passent (on n'a rien cassé, on a seulement ajouté des types)

**Step 3: Commit**

```bash
git add src/domain/types.ts
git commit -m "refactor: add IResolver, ICycleDetector, IDependencyTracker interfaces to domain"
```

---

## Task 2: Extraire CycleDetector (SRP)

**Fichiers:**
- Create: `src/infrastructure/cycle-detector.ts`
- Create: `tests/cycle-detector.test.ts`

**Pourquoi:** La détection de cycles est une responsabilité distincte du `Resolver`. C'est un garde-fou stateful (`resolving` Set) qui mérite sa propre classe testable.

**Step 1: Écrire les tests unitaires**

Créer `tests/cycle-detector.test.ts` :

```typescript
import { describe, expect, it } from 'vitest';
import { CycleDetector } from '../src/infrastructure/cycle-detector.js';

describe('CycleDetector', () => {
  it('tracks entering and leaving resolution', () => {
    const detector = new CycleDetector();

    expect(detector.isResolving('a')).toBe(false);
    detector.enter('a');
    expect(detector.isResolving('a')).toBe(true);
    detector.leave('a');
    expect(detector.isResolving('a')).toBe(false);
  });

  it('detects a cycle when entering a key already being resolved', () => {
    const detector = new CycleDetector();

    detector.enter('a');
    detector.enter('b');
    expect(detector.isResolving('a')).toBe(true);
    // Caller (Resolver) will check isResolving before enter and throw
  });

  it('handles independent resolution chains', () => {
    const detector = new CycleDetector();

    detector.enter('a');
    detector.leave('a');
    detector.enter('b');
    expect(detector.isResolving('a')).toBe(false);
    expect(detector.isResolving('b')).toBe(true);
    detector.leave('b');
  });
});
```

**Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run tests/cycle-detector.test.ts`
Expected: FAIL — module not found

**Step 3: Implémenter CycleDetector**

Créer `src/infrastructure/cycle-detector.ts` :

```typescript
import type { ICycleDetector } from '../domain/types.js';

/**
 * Tracks which keys are currently being resolved to detect circular dependencies.
 * Uses a Set<string> internally — enter/leave must be balanced (use try/finally).
 */
export class CycleDetector implements ICycleDetector {
  private readonly resolving = new Set<string>();

  enter(key: string): void {
    this.resolving.add(key);
  }

  leave(key: string): void {
    this.resolving.delete(key);
  }

  isResolving(key: string): boolean {
    return this.resolving.has(key);
  }
}
```

**Step 4: Lancer les tests**

Run: `pnpm vitest run tests/cycle-detector.test.ts`
Expected: PASS

**Step 5: Lancer TOUS les tests (non-régression)**

Run: `pnpm vitest run`
Expected: tous les tests passent

**Step 6: Commit**

```bash
git add src/infrastructure/cycle-detector.ts tests/cycle-detector.test.ts
git commit -m "refactor: extract CycleDetector from Resolver (SRP)"
```

---

## Task 3: Extraire DependencyTracker (SRP)

**Fichiers:**
- Create: `src/infrastructure/dependency-tracker.ts`
- Create: `tests/dependency-tracker.test.ts`

**Pourquoi:** Le tracking proxy et le depGraph sont une responsabilité de "suivi du graphe de dépendances" — distinct de la résolution elle-même.

**Step 1: Écrire les tests unitaires**

Créer `tests/dependency-tracker.test.ts` :

```typescript
import { describe, expect, it } from 'vitest';
import { DependencyTracker } from '../src/infrastructure/dependency-tracker.js';

describe('DependencyTracker', () => {
  it('records deps via tracking proxy', () => {
    const tracker = new DependencyTracker();
    const deps: string[] = [];
    const resolved = new Map<string, unknown>([['db', 'db-instance'], ['logger', 'logger-instance']]);

    const proxy = tracker.createTrackingProxy(deps, [], (key) => resolved.get(key));

    // Access properties on the proxy
    (proxy as Record<string, unknown>).db;
    (proxy as Record<string, unknown>).logger;

    expect(deps).toEqual(['db', 'logger']);
  });

  it('stores and retrieves dependency graph', () => {
    const tracker = new DependencyTracker();

    tracker.recordDeps('service', ['db', 'logger']);
    tracker.recordDeps('handler', ['service']);

    const graph = tracker.getDepGraph();
    expect(graph.get('service')).toEqual(['db', 'logger']);
    expect(graph.get('handler')).toEqual(['service']);
  });

  it('clears specific keys from dep graph', () => {
    const tracker = new DependencyTracker();
    tracker.recordDeps('a', ['b']);
    tracker.recordDeps('c', ['d']);

    tracker.clearDepGraph('a');

    const graph = tracker.getDepGraph();
    expect(graph.has('a')).toBe(false);
    expect(graph.get('c')).toEqual(['d']);
  });

  it('clears all dep graph', () => {
    const tracker = new DependencyTracker();
    tracker.recordDeps('a', ['b']);
    tracker.recordDeps('c', ['d']);

    tracker.clearAllDepGraph();

    expect(tracker.getDepGraph().size).toBe(0);
  });

  it('ignores symbol property access on tracking proxy', () => {
    const tracker = new DependencyTracker();
    const deps: string[] = [];
    const proxy = tracker.createTrackingProxy(deps, [], () => undefined);

    (proxy as any)[Symbol.toPrimitive];

    expect(deps).toEqual([]);
  });
});
```

**Step 2: Lancer le test pour vérifier qu'il échoue**

Run: `pnpm vitest run tests/dependency-tracker.test.ts`
Expected: FAIL

**Step 3: Implémenter DependencyTracker**

Créer `src/infrastructure/dependency-tracker.ts` :

```typescript
import type { IDependencyTracker } from '../domain/types.js';

/**
 * Tracks dependencies accessed by each factory via a Proxy.
 * Builds the dependency graph automatically from runtime access patterns.
 */
export class DependencyTracker implements IDependencyTracker {
  private readonly depGraph = new Map<string, string[]>();

  /**
   * Creates a Proxy that records every property access into `deps`
   * and delegates resolution to the provided `resolve` callback.
   */
  createTrackingProxy(
    deps: string[],
    chain: string[],
    resolve: (key: string, chain: string[]) => unknown,
  ): unknown {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop === 'symbol') return undefined;
          const depKey = prop as string;
          deps.push(depKey);
          return resolve(depKey, chain);
        },
      },
    );
  }

  getDepGraph(): Map<string, string[]> {
    return new Map(this.depGraph);
  }

  recordDeps(key: string, deps: string[]): void {
    this.depGraph.set(key, deps);
  }

  clearDepGraph(...keys: string[]): void {
    for (const key of keys) this.depGraph.delete(key);
  }

  clearAllDepGraph(): void {
    this.depGraph.clear();
  }
}
```

**Step 4: Lancer les tests**

Run: `pnpm vitest run tests/dependency-tracker.test.ts`
Expected: PASS

**Step 5: Non-régression**

Run: `pnpm vitest run`
Expected: tous les tests passent

**Step 6: Commit**

```bash
git add src/infrastructure/dependency-tracker.ts tests/dependency-tracker.test.ts
git commit -m "refactor: extract DependencyTracker from Resolver (SRP)"
```

---

## Task 4: Refactorer Resolver pour utiliser les collaborateurs

**Fichiers:**
- Modify: `src/infrastructure/resolver.ts`

**Pourquoi:** Le Resolver a actuellement 5 responsabilités. Après extraction de CycleDetector et DependencyTracker, on le refactore pour déléguer. Il ne garde que : résolution, cache, parent chain, warnings, lifecycle onInit.

**Step 1: Refactorer `src/infrastructure/resolver.ts`**

Le Resolver reçoit maintenant ses collaborateurs par injection de constructeur :

```typescript
import type { AnyWarning } from '../domain/errors.js';
import {
  AsyncInitErrorWarning,
  CircularDependencyError,
  FactoryError,
  ProviderNotFoundError,
  ScopeMismatchWarning,
  UndefinedReturnError,
} from '../domain/errors.js';
import { hasOnInit } from '../domain/lifecycle.js';
import type { Factory, ICycleDetector, IDependencyTracker, IResolver } from '../domain/types.js';
import { Validator } from '../domain/validation.js';
import { isTransient } from './transient.js';

/**
 * Core resolver — lazy singleton resolution with parent chain support.
 * Delegates cycle detection and dependency tracking to injected collaborators.
 */
export class Resolver implements IResolver {
  private readonly factories: Map<string, Factory>;
  private readonly cache: Map<string, unknown>;
  private readonly warnings: AnyWarning[] = [];
  private readonly validator = new Validator();
  private readonly initCalled: Set<string>;
  private deferOnInit = false;

  private readonly parent?: Resolver;
  private readonly name?: string;
  private readonly cycleDetector: ICycleDetector;
  private readonly dependencyTracker: IDependencyTracker;

  constructor(
    factories: Map<string, Factory>,
    cache?: Map<string, unknown>,
    parent?: Resolver,
    name?: string,
    initCalled?: Set<string>,
    cycleDetector?: ICycleDetector,
    dependencyTracker?: IDependencyTracker,
  ) {
    this.factories = factories;
    this.cache = cache ?? new Map();
    this.parent = parent;
    this.name = name;
    this.initCalled = initCalled ? new Set(initCalled) : new Set();
    this.cycleDetector = cycleDetector ?? new (require('./cycle-detector.js').CycleDetector)();
    this.dependencyTracker = dependencyTracker ?? new (require('./dependency-tracker.js').DependencyTracker)();
  }
  // ...
```

**STOP — PROBLÈME:** On ne peut pas faire de `require()` en ESM. Et on ne veut pas de dépendance par défaut en dur dans le constructeur (ça casserait le DIP).

**Approche corrigée:** Le Resolver prend les collaborateurs en paramètre obligatoire. Le seul endroit qui instancie un Resolver est `container-builder.ts` et `container-proxy.ts` — c'est eux la Composition Root. Ce pattern s'appelle **Pure DI** (Mark Seemann) : l'assemblage se fait au point d'entrée, pas dans les classes.

Voici le Resolver refactoré complet :

```typescript
import type { AnyWarning } from '../domain/errors.js';
import {
  AsyncInitErrorWarning,
  CircularDependencyError,
  FactoryError,
  ProviderNotFoundError,
  ScopeMismatchWarning,
  UndefinedReturnError,
} from '../domain/errors.js';
import { hasOnInit } from '../domain/lifecycle.js';
import type { Factory, ICycleDetector, IDependencyTracker, IResolver } from '../domain/types.js';
import { Validator } from '../domain/validation.js';
import { isTransient } from './transient.js';

export interface ResolverDeps {
  factories: Map<string, Factory>;
  cache?: Map<string, unknown>;
  parent?: Resolver;
  name?: string;
  initCalled?: Set<string>;
  cycleDetector: ICycleDetector;
  dependencyTracker: IDependencyTracker;
}

/**
 * Core resolver — lazy singleton resolution with parent chain support.
 * Delegates cycle detection and dependency tracking to injected collaborators.
 */
export class Resolver implements IResolver {
  private readonly factories: Map<string, Factory>;
  private readonly cache: Map<string, unknown>;
  private readonly warnings: AnyWarning[] = [];
  private readonly validator = new Validator();
  private readonly initCalled: Set<string>;
  private deferOnInit = false;

  private readonly parent?: Resolver;
  private readonly name?: string;
  private readonly cycleDetector: ICycleDetector;
  private readonly dependencyTracker: IDependencyTracker;

  constructor(deps: ResolverDeps) {
    this.factories = deps.factories;
    this.cache = deps.cache ?? new Map();
    this.parent = deps.parent;
    this.name = deps.name;
    this.initCalled = deps.initCalled ? new Set(deps.initCalled) : new Set();
    this.cycleDetector = deps.cycleDetector;
    this.dependencyTracker = deps.dependencyTracker;
  }

  getName(): string | undefined {
    return this.name;
  }

  resolve(key: string, chain: string[] = []): unknown {
    const factory = this.factories.get(key);

    if (factory && !isTransient(factory) && this.cache.has(key)) {
      return this.cache.get(key);
    }

    if (!factory) {
      if (this.parent) {
        return this.parent.resolve(key, chain);
      }
      const allKeys = this.getAllRegisteredKeys();
      const suggestion = this.validator.suggestKey(key, allKeys);
      throw new ProviderNotFoundError(key, chain, allKeys, suggestion);
    }

    if (this.cycleDetector.isResolving(key)) {
      throw new CircularDependencyError(key, [...chain]);
    }

    this.cycleDetector.enter(key);
    const currentChain = [...chain, key];

    try {
      const deps: string[] = [];
      const trackingProxy = this.dependencyTracker.createTrackingProxy(
        deps,
        currentChain,
        (depKey, depChain) => this.resolve(depKey, depChain),
      );

      const instance = factory(trackingProxy);

      if (instance === undefined) {
        throw new UndefinedReturnError(key, currentChain);
      }

      this.dependencyTracker.recordDeps(key, deps);

      if (!isTransient(factory)) {
        for (const dep of deps) {
          const depFactory = this.getFactory(dep);
          if (depFactory && isTransient(depFactory)) {
            this.warnings.push(new ScopeMismatchWarning(key, dep));
          }
        }
      }

      if (!isTransient(factory)) {
        this.cache.set(key, instance);
      }

      if (!this.deferOnInit && !this.initCalled.has(key) && hasOnInit(instance)) {
        this.initCalled.add(key);
        const initResult = instance.onInit();
        if (initResult instanceof Promise) {
          initResult.catch((error) => {
            this.warnings.push(new AsyncInitErrorWarning(key, error));
          });
        }
      }

      return instance;
    } catch (error) {
      if (
        error instanceof CircularDependencyError ||
        error instanceof ProviderNotFoundError ||
        error instanceof UndefinedReturnError ||
        error instanceof FactoryError
      ) {
        throw error;
      }
      throw new FactoryError(key, currentChain, error);
    } finally {
      this.cycleDetector.leave(key);
    }
  }

  isResolved(key: string): boolean {
    return this.cache.has(key);
  }

  getDepGraph(): Map<string, string[]> {
    return this.dependencyTracker.getDepGraph();
  }

  getResolvedKeys(): string[] {
    return [...this.cache.keys()];
  }

  getFactories(): Map<string, Factory> {
    return this.factories;
  }

  getCache(): Map<string, unknown> {
    return this.cache;
  }

  getWarnings(): AnyWarning[] {
    return [...this.warnings];
  }

  getAllRegisteredKeys(): string[] {
    const keys = new Set<string>(this.factories.keys());
    if (this.parent) {
      for (const key of this.parent.getAllRegisteredKeys()) {
        keys.add(key);
      }
    }
    return [...keys];
  }

  setDeferOnInit(defer: boolean): void {
    this.deferOnInit = defer;
  }

  async callOnInit(key: string): Promise<void> {
    if (this.initCalled.has(key)) return;
    if (!this.cache.has(key)) return;
    const instance = this.cache.get(key);
    if (hasOnInit(instance)) {
      await instance.onInit();
    }
    this.initCalled.add(key);
  }

  clearInitState(...keys: string[]): void {
    for (const key of keys) {
      this.initCalled.delete(key);
    }
  }

  clearAllInitState(): void {
    this.initCalled.clear();
  }

  clearDepGraph(...keys: string[]): void {
    this.dependencyTracker.clearDepGraph(...keys);
  }

  clearAllDepGraph(): void {
    this.dependencyTracker.clearAllDepGraph();
  }

  clearWarnings(): void {
    this.warnings.length = 0;
  }

  clearWarningsForKeys(...keys: string[]): void {
    const keySet = new Set(keys);
    const keep = this.warnings.filter((w) => {
      if (w.type === 'async_init_error') return !keySet.has(w.details.key);
      if (w.type === 'scope_mismatch') {
        return !keySet.has(w.details.singleton) && !keySet.has(w.details.transient);
      }
      return true;
    });
    this.warnings.length = 0;
    this.warnings.push(...keep);
  }

  getInitCalled(): Set<string> {
    return this.initCalled;
  }

  /** Expose collaborators for child resolvers (scope/extend) */
  getCycleDetector(): ICycleDetector {
    return this.cycleDetector;
  }

  getDependencyTracker(): IDependencyTracker {
    return this.dependencyTracker;
  }

  private getFactory(key: string): Factory | undefined {
    return this.factories.get(key) ?? this.parent?.getFactory(key);
  }
}
```

**Step 2: Mettre à jour `container-builder.ts` (Composition Root)**

Le `build()` doit instancier les collaborateurs et les passer au Resolver :

```typescript
// Ajouts en haut du fichier :
import { CycleDetector } from '../infrastructure/cycle-detector.js';
import { DependencyTracker } from '../infrastructure/dependency-tracker.js';

// Modification du build() :
build(): Container<TBuilt> {
  const resolver = new Resolver({
    factories: new Map(this.factories),
    cycleDetector: new CycleDetector(),
    dependencyTracker: new DependencyTracker(),
  });
  return buildContainerProxy(resolver, () => new ContainerBuilder()) as Container<TBuilt>;
}
```

**Step 3: Mettre à jour `container-proxy.ts`**

Ajuster les appels à `new Resolver(...)` dans `scope()` et `extend()` pour utiliser le nouvel objet deps et propager les collaborateurs :

Dans `scope()` :
```typescript
scope: (extra: Record<string, (c: unknown) => unknown>, options?: ScopeOptions) => {
  validator.validateConfig(extra);
  const childFactories = new Map<string, Factory>();
  for (const [key, factory] of Object.entries(extra)) {
    childFactories.set(key, factory as Factory);
  }
  const childResolver = new Resolver({
    factories: childFactories,
    parent: resolver,
    name: options?.name,
    cycleDetector: new CycleDetector(),
    dependencyTracker: new DependencyTracker(),
  });
  return buildContainerProxy(childResolver, builderFactory);
},
```

Dans `extend()` :
```typescript
extend: (extra: Record<string, (c: unknown) => unknown>) => {
  validator.validateConfig(extra);
  const merged = new Map(resolver.getFactories());
  for (const [key, factory] of Object.entries(extra)) {
    merged.set(key, factory as Factory);
  }
  const newResolver = new Resolver({
    factories: merged,
    cache: new Map(resolver.getCache()),
    initCalled: resolver.getInitCalled(),
    cycleDetector: new CycleDetector(),
    dependencyTracker: new DependencyTracker(),
  });
  return buildContainerProxy(newResolver, builderFactory);
},
```

Ajouter les imports en haut de `container-proxy.ts` :
```typescript
import { CycleDetector } from '../infrastructure/cycle-detector.js';
import { DependencyTracker } from '../infrastructure/dependency-tracker.js';
```

**Step 4: Lancer TOUS les tests**

Run: `pnpm vitest run`
Expected: tous les 16 fichiers de tests passent

**Step 5: Commit**

```bash
git add src/infrastructure/resolver.ts src/application/container-builder.ts src/application/container-proxy.ts
git commit -m "refactor: inject CycleDetector and DependencyTracker into Resolver (DIP)"
```

---

## Task 5: Extraire Preloader (SRP — Use Case)

**Fichiers:**
- Create: `src/application/preloader.ts`
- Create: `tests/preloader.test.ts`
- Modify: `src/application/container-proxy.ts` (retirer preload, déléguer)

**Pourquoi:** `preload()` est un Use Case complet : résoudre en mode différé, trier topologiquement, initialiser par niveaux. C'est ~50 lignes de logique qui n'a rien à faire dans le Proxy.

**Step 1: Écrire les tests unitaires**

Créer `tests/preloader.test.ts` :

```typescript
import { describe, expect, it } from 'vitest';
import { topologicalLevels } from '../src/application/preloader.js';

describe('topologicalLevels', () => {
  it('returns independent keys in a single level', () => {
    const depGraph = new Map<string, string[]>([
      ['a', []],
      ['b', []],
      ['c', []],
    ]);
    const keys = new Set(['a', 'b', 'c']);

    const levels = topologicalLevels(depGraph, keys);

    expect(levels).toHaveLength(1);
    expect(levels[0]).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('orders dependencies before dependents', () => {
    const depGraph = new Map<string, string[]>([
      ['db', []],
      ['repo', ['db']],
      ['service', ['repo']],
    ]);
    const keys = new Set(['db', 'repo', 'service']);

    const levels = topologicalLevels(depGraph, keys);

    expect(levels).toHaveLength(3);
    expect(levels[0]).toEqual(['db']);
    expect(levels[1]).toEqual(['repo']);
    expect(levels[2]).toEqual(['service']);
  });

  it('groups independent deps at same level', () => {
    const depGraph = new Map<string, string[]>([
      ['db', []],
      ['cache', []],
      ['service', ['db', 'cache']],
    ]);
    const keys = new Set(['db', 'cache', 'service']);

    const levels = topologicalLevels(depGraph, keys);

    expect(levels).toHaveLength(2);
    expect(levels[0]).toEqual(expect.arrayContaining(['db', 'cache']));
    expect(levels[1]).toEqual(['service']);
  });

  it('throws on incomplete sort (likely cycle)', () => {
    const depGraph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const keys = new Set(['a', 'b']);

    expect(() => topologicalLevels(depGraph, keys)).toThrow(/Incomplete topological sort/);
  });
});
```

**Step 2: Lancer pour vérifier l'échec**

Run: `pnpm vitest run tests/preloader.test.ts`
Expected: FAIL

**Step 3: Implémenter Preloader**

Créer `src/application/preloader.ts` :

```typescript
import type { IResolver } from '../domain/types.js';

/**
 * Groups keys into topological levels using Kahn's algorithm (BFS).
 * Each level can be initialized in parallel; levels must run sequentially.
 */
export function topologicalLevels(depGraph: Map<string, string[]>, keys: Set<string>): string[][] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const key of keys) {
    inDegree.set(key, 0);
  }

  for (const key of keys) {
    const deps = depGraph.get(key) ?? [];
    for (const dep of deps) {
      if (keys.has(dep)) {
        inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
        const list = dependents.get(dep) ?? [];
        list.push(key);
        dependents.set(dep, list);
      }
    }
  }

  const levels: string[][] = [];
  let queue = [...keys].filter((k) => inDegree.get(k) === 0);

  while (queue.length > 0) {
    levels.push(queue);
    const next: string[] = [];
    for (const key of queue) {
      for (const dep of dependents.get(key) ?? []) {
        const d = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, d);
        if (d === 0) next.push(dep);
      }
    }
    queue = next;
  }

  const processedCount = levels.reduce((sum, l) => sum + l.length, 0);
  if (processedCount < keys.size) {
    const processedSet = new Set(levels.flat());
    const remaining = [...keys].filter((k) => !processedSet.has(k));
    throw new Error(
      `Incomplete topological sort: [${remaining.join(', ')}] could not be ordered. This may indicate a cycle in the dependency graph.`,
    );
  }

  return levels;
}

/**
 * Use Case: pre-resolve and initialize container dependencies in topological order.
 * Independent deps at the same depth level are initialized in parallel.
 */
export class Preloader {
  constructor(private readonly resolver: IResolver) {}

  async preload(...keys: string[]): Promise<void> {
    const toResolve = keys.length > 0 ? keys : [...this.resolver.getFactories().keys()];

    const cacheKeysBefore = new Set(this.resolver.getCache().keys());
    this.resolver.setDeferOnInit(true);
    try {
      for (const key of toResolve) {
        this.resolver.resolve(key);
      }
    } catch (error) {
      const cache = this.resolver.getCache();
      for (const key of cache.keys()) {
        if (!cacheKeysBefore.has(key)) cache.delete(key);
      }
      throw error;
    } finally {
      this.resolver.setDeferOnInit(false);
    }

    const depGraph = this.resolver.getDepGraph();
    const allKeys = new Set<string>();
    const collectDeps = (key: string) => {
      if (allKeys.has(key)) return;
      allKeys.add(key);
      for (const dep of depGraph.get(key) ?? []) {
        collectDeps(dep);
      }
    };
    for (const key of toResolve) {
      collectDeps(key);
    }

    const levels = topologicalLevels(depGraph, allKeys);
    const initErrors: unknown[] = [];
    for (const level of levels) {
      const results = await Promise.allSettled(level.map((k) => this.resolver.callOnInit(k)));
      for (const result of results) {
        if (result.status === 'rejected') initErrors.push(result.reason);
      }
    }
    if (initErrors.length === 1) throw initErrors[0];
    if (initErrors.length > 1) {
      throw new AggregateError(
        initErrors,
        `preload() encountered ${initErrors.length} onInit errors`,
      );
    }
  }
}
```

**Step 4: Lancer les tests unitaires du Preloader**

Run: `pnpm vitest run tests/preloader.test.ts`
Expected: PASS

**Step 5: Rewire container-proxy.ts**

Dans `container-proxy.ts`, remplacer le `preload` inline et la fonction `topologicalLevels` par la délégation au `Preloader` :

- Supprimer la fonction `topologicalLevels` (lignes 13-59)
- Ajouter `import { Preloader } from './preloader.js';`
- Dans `buildContainerProxy`, créer `const preloader = new Preloader(resolver);`
- Remplacer la méthode `preload` par : `preload: (...keys: string[]) => preloader.preload(...keys),`

**Step 6: Lancer TOUS les tests**

Run: `pnpm vitest run`
Expected: tous les tests passent (notamment `tests/preload.test.ts`)

**Step 7: Commit**

```bash
git add src/application/preloader.ts tests/preloader.test.ts src/application/container-proxy.ts
git commit -m "refactor: extract Preloader use case from container-proxy (SRP)"
```

---

## Task 6: Extraire Disposer (SRP — Use Case)

**Fichiers:**
- Create: `src/application/disposer.ts`
- Create: `tests/disposer.test.ts`
- Modify: `src/application/container-proxy.ts` (retirer dispose, déléguer)

**Pourquoi:** Le dispose est un Use Case indépendant : itérer en reverse, appeler onDestroy, collecter les erreurs, nettoyer. C'est une responsabilité distincte de la construction du Proxy.

**Step 1: Écrire les tests unitaires**

Créer `tests/disposer.test.ts` :

```typescript
import { describe, expect, it, vi } from 'vitest';
import { Disposer } from '../src/application/disposer.js';

describe('Disposer', () => {
  it('calls onDestroy in reverse resolution order', async () => {
    const order: string[] = [];
    const cache = new Map<string, unknown>([
      ['first', { onDestroy: () => { order.push('first'); } }],
      ['second', { onDestroy: () => { order.push('second'); } }],
      ['third', { onDestroy: () => { order.push('third'); } }],
    ]);

    const resolver = {
      getCache: () => cache,
      clearAllInitState: vi.fn(),
      clearAllDepGraph: vi.fn(),
      clearWarnings: vi.fn(),
    };

    const disposer = new Disposer(resolver as any);
    await disposer.dispose();

    expect(order).toEqual(['third', 'second', 'first']);
  });

  it('continues on error and throws AggregateError', async () => {
    const cache = new Map<string, unknown>([
      ['a', { onDestroy: () => { throw new Error('fail-a'); } }],
      ['b', { onDestroy: () => { /* ok */ } }],
      ['c', { onDestroy: () => { throw new Error('fail-c'); } }],
    ]);

    const resolver = {
      getCache: () => cache,
      clearAllInitState: vi.fn(),
      clearAllDepGraph: vi.fn(),
      clearWarnings: vi.fn(),
    };

    const disposer = new Disposer(resolver as any);
    await expect(disposer.dispose()).rejects.toThrow(AggregateError);
  });

  it('clears all state after dispose', async () => {
    const cache = new Map<string, unknown>([['a', {}]]);
    const clearAllInitState = vi.fn();
    const clearAllDepGraph = vi.fn();
    const clearWarnings = vi.fn();

    const resolver = {
      getCache: () => cache,
      clearAllInitState,
      clearAllDepGraph,
      clearWarnings,
    };

    const disposer = new Disposer(resolver as any);
    await disposer.dispose();

    expect(cache.size).toBe(0);
    expect(clearAllInitState).toHaveBeenCalled();
    expect(clearAllDepGraph).toHaveBeenCalled();
    expect(clearWarnings).toHaveBeenCalled();
  });

  it('skips instances without onDestroy', async () => {
    const cache = new Map<string, unknown>([
      ['plain', { value: 42 }],
      ['destroyable', { onDestroy: vi.fn() }],
    ]);

    const resolver = {
      getCache: () => cache,
      clearAllInitState: vi.fn(),
      clearAllDepGraph: vi.fn(),
      clearWarnings: vi.fn(),
    };

    const disposer = new Disposer(resolver as any);
    await disposer.dispose(); // should not throw
  });
});
```

**Step 2: Lancer pour vérifier l'échec**

Run: `pnpm vitest run tests/disposer.test.ts`
Expected: FAIL

**Step 3: Implémenter Disposer**

Créer `src/application/disposer.ts` :

```typescript
import { hasOnDestroy } from '../domain/lifecycle.js';
import type { IResolver } from '../domain/types.js';

/**
 * Use Case: dispose all resolved instances in reverse resolution order.
 * Calls onDestroy() on each, collects errors, clears all state.
 */
export class Disposer {
  constructor(private readonly resolver: IResolver) {}

  async dispose(): Promise<void> {
    const cache = this.resolver.getCache();
    const entries = [...cache.entries()].reverse();
    const errors: unknown[] = [];

    for (const [, instance] of entries) {
      if (hasOnDestroy(instance)) {
        try {
          await instance.onDestroy();
        } catch (error) {
          errors.push(error);
        }
      }
    }

    cache.clear();
    this.resolver.clearAllInitState();
    this.resolver.clearAllDepGraph();
    this.resolver.clearWarnings();

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `dispose() encountered ${errors.length} errors`);
    }
  }
}
```

**Step 4: Lancer les tests unitaires**

Run: `pnpm vitest run tests/disposer.test.ts`
Expected: PASS

**Step 5: Rewire container-proxy.ts**

- Ajouter `import { Disposer } from './disposer.js';`
- Retirer l'import `{ hasOnDestroy }` (plus utilisé ici)
- Dans `buildContainerProxy`, créer `const disposer = new Disposer(resolver);`
- Remplacer la méthode `dispose` par : `dispose: () => disposer.dispose(),`

**Step 6: Lancer TOUS les tests**

Run: `pnpm vitest run`
Expected: tous les tests passent (notamment `tests/lifecycle.test.ts`)

**Step 7: Commit**

```bash
git add src/application/disposer.ts tests/disposer.test.ts src/application/container-proxy.ts
git commit -m "refactor: extract Disposer use case from container-proxy (SRP)"
```

---

## Task 7: Typer container-proxy.ts sur IResolver (DIP final)

**Fichiers:**
- Modify: `src/application/container-proxy.ts`
- Modify: `src/application/introspection.ts`

**Pourquoi:** Dernière étape du DIP — la couche application ne doit plus connaître la classe concrète `Resolver`. Elle dépend de `IResolver`.

**Step 1: Modifier `introspection.ts`**

Changer le constructeur pour accepter `IResolver` :

```typescript
import type { IResolver } from '../domain/types.js';
// Retirer: import type { Resolver } from '../infrastructure/resolver.js';

export class Introspection {
  constructor(private readonly resolver: IResolver) {}
  // ... reste identique
}
```

**Step 2: Modifier `container-proxy.ts`**

Changer la signature de `buildContainerProxy` :

```typescript
import type { Container, Factory, IResolver, ScopeOptions } from '../domain/types.js';
// Retirer: import { Resolver } from '../infrastructure/resolver.js';
// Note: Resolver est toujours importé car on l'instancie dans scope/extend.
// C'est acceptable : container-proxy.ts est une Composition Root (elle assemble).
// Alternative propre : recevoir une factory de Resolver en paramètre.
```

En fait, `container-proxy.ts` **doit** instancier des Resolvers (pour scope/extend). C'est son rôle de Composition Root interne. Le DIP est respecté pour `Introspection`, `Preloader`, et `Disposer` qui dépendent de `IResolver`.

Pour aller au bout du DIP sur container-proxy, on peut passer une `resolverFactory` :

```typescript
export type ResolverFactory = (deps: {
  factories: Map<string, Factory>;
  cache?: Map<string, unknown>;
  parent?: IResolver;
  name?: string;
  initCalled?: Set<string>;
}) => IResolver;

export function buildContainerProxy(
  resolver: IResolver,
  builderFactory?: () => { _toRecord(): Record<string, (c: unknown) => unknown> },
  resolverFactory?: ResolverFactory,
): Container<Record<string, unknown>> {
```

**C'est un choix de design — à toi de décider si c'est nécessaire ou over-engineering pour cette lib.** Le plan le laisse en option.

**Step 3: Lancer TOUS les tests**

Run: `pnpm vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/application/introspection.ts src/application/container-proxy.ts
git commit -m "refactor: depend on IResolver interface in application layer (DIP)"
```

---

## Task 8: Mettre à jour les exports et vérifier le build

**Fichiers:**
- Verify: `src/index.ts` (rien à changer normalement — les nouveaux fichiers sont internes)
- Run: build + tests + coverage

**Step 1: Vérifier que l'API publique n'a pas changé**

`src/index.ts` ne devrait exporter aucun des nouveaux fichiers (`CycleDetector`, `DependencyTracker`, `Preloader`, `Disposer`) — ce sont des détails d'implémentation.

**Step 2: Build**

Run: `pnpm build`
Expected: build réussi, pas d'erreur TS

**Step 3: Tests + coverage**

Run: `pnpm vitest run --coverage`
Expected: tous les tests passent, coverage >= 90% sur les 4 métriques

**Step 4: Commit final**

```bash
git add -A
git commit -m "refactor: complete clean architecture refactoring (SOLID, SRP, DIP)"
```

---

## Résumé des fichiers

| Action | Fichier | Raison |
|--------|---------|--------|
| Modify | `src/domain/types.ts` | +IResolver, +ICycleDetector, +IDependencyTracker |
| Create | `src/infrastructure/cycle-detector.ts` | SRP extraction |
| Create | `src/infrastructure/dependency-tracker.ts` | SRP extraction |
| Modify | `src/infrastructure/resolver.ts` | Injection des collaborateurs |
| Create | `src/application/preloader.ts` | Use Case extraction |
| Create | `src/application/disposer.ts` | Use Case extraction |
| Modify | `src/application/container-proxy.ts` | Allégé, délègue |
| Modify | `src/application/container-builder.ts` | Composition Root |
| Modify | `src/application/introspection.ts` | Dépend de IResolver |
| Create | `tests/cycle-detector.test.ts` | Unit tests |
| Create | `tests/dependency-tracker.test.ts` | Unit tests |
| Create | `tests/preloader.test.ts` | Unit tests |
| Create | `tests/disposer.test.ts` | Unit tests |

**Fichiers inchangés:** `domain/errors.ts`, `domain/lifecycle.ts`, `domain/validation.ts`, `infrastructure/transient.ts`, `index.ts`, les 16 fichiers de tests existants.
