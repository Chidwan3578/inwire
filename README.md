# inwire

Type-safe dependency injection for TypeScript. Builder pattern, full inference, no decorators, no tokens. Built-in introspection for AI tooling and debugging.

[![NPM Version](https://img.shields.io/npm/v/inwire)](https://www.npmjs.com/package/inwire)
[![CI](https://img.shields.io/github/actions/workflow/status/axelhamil/inwire/ci.yml)](https://github.com/axelhamil/inwire/actions)
[![Bundle size](https://img.shields.io/bundlephobia/minzip/inwire)](https://bundlephobia.com/package/inwire)
[![NPM Downloads](https://img.shields.io/npm/dm/inwire)](https://www.npmjs.com/package/inwire)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/npm/l/inwire)](https://github.com/axelhamil/inwire/blob/main/LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/inwire)

## Install

```bash
npm i inwire
```

## Quick Start

```typescript
import { container } from 'inwire';

const app = container()
  .add('logger', () => new LoggerService())
  .add('db', (c) => new Database(c.logger))
  .add('userService', (c) => new UserService(c.db, c.logger))
  .build();

app.userService; // lazy, singleton, fully typed
// c.logger in the db factory is typed as LoggerService
```

Each `.add()` accumulates the type — `c` in every factory knows about all previously registered dependencies.

## Contract Mode (Interface-First)

Pass an interface to the builder to constrain keys and return types at compile time:

```typescript
interface AppDeps {
  ILogger: Logger;
  IDatabase: Database;
  IUserService: UserService;
}

const app = container<AppDeps>()
  .add('ILogger', () => new ConsoleLogger())         // key: autocomplete keyof AppDeps
  .add('IDatabase', (c) => new PgDatabase(c.ILogger)) // return must be Database
  .add('IUserService', (c) => new UserService(c.IDatabase, c.ILogger))
  .build();

app.ILogger; // typed as Logger (not ConsoleLogger)
```

The string key acts as a token (like NestJS), but type-safe at compile time.

## Instance Values (Eager)

Non-function values are registered eagerly:

```typescript
const app = container()
  .add('config', { port: 3000, host: 'localhost' })  // object, not factory — eager
  .add('db', (c) => new Database(c.config))           // factory — lazy
  .build();
```

Convention: `typeof value === 'function'` → factory (lazy). Otherwise → instance (eager, wrapped in `() => value`).
To register a function as a value: `.add('fn', () => myFunction)`.

## Async Lifecycle

Property access on the container is **synchronous**. If your service implements `onInit()` with an async function, it will be called but **not awaited** — errors are silently swallowed and your service may be used before it's ready.

**`preload()` is the only way to safely initialize async services.**

```typescript
class Database implements OnInit {
  async onInit() { await this.connect(); }
}

const app = container()
  .add('db', () => new Database())
  .build();

// BAD — onInit() fires but is NOT awaited, errors are lost
app.db;

// GOOD — onInit() is awaited, errors surface immediately
await app.preload('db');
app.db; // safe to use, fully initialized
```

## Why use a DI container?

- **Testability** — swap any dependency for a mock at creation time, no monkey-patching or `jest.mock`
- **Decoupling** — program against interfaces, not concrete imports; swap implementations without touching consumers
- **Visibility** — inspect the full dependency graph at runtime, catch scope mismatches, and monitor container health

## Features

### Lazy Singletons (default)

```typescript
const app = container()
  .add('db', () => new Database(process.env.DB_URL!))
  .build();

app.db; // creates Database
app.db; // same instance (cached)
```

### Transient

Fresh instance on every access via `addTransient()`:

```typescript
import { container } from 'inwire';

const app = container()
  .add('logger', () => new LoggerService())
  .addTransient('requestId', () => crypto.randomUUID())
  .build();

app.logger === app.logger;         // true  — singleton
app.requestId === app.requestId;   // false — new every time
```

`transient()` wrapper is still available for `scope()`/`extend()`:

```typescript
import { transient } from 'inwire';

const extended = app.extend({
  timestamp: transient(() => Date.now()),
});
```

### Scopes

Create child containers for request-level isolation:

```typescript
const app = container()
  .add('logger', () => new LoggerService())
  .add('db', () => new Database())
  .build();

const request = app.scope({
  requestId: () => crypto.randomUUID(),
  handler: (c) => new Handler(c.logger),  // c typed as typeof app
});

request.requestId; // scoped singleton
request.logger;    // inherited from parent
```

#### Named Scopes

```typescript
const request = app.scope(
  { requestId: () => crypto.randomUUID() },
  { name: 'request-123' },
);

String(request);        // "Scope(request-123) { requestId (pending) }"
request.inspect().name; // "request-123"
```

### Lifecycle (onInit / onDestroy / dispose)

```typescript
import type { OnInit, OnDestroy } from 'inwire';

class Database implements OnInit, OnDestroy {
  async onInit() { await this.connect(); }
  async onDestroy() { await this.disconnect(); }
}

const app = container()
  .add('db', () => new Database())
  .build();

app.db;               // resolves + calls onInit()
await app.dispose();  // calls onDestroy() on all resolved instances (LIFO order)
```

### Extend

Add dependencies to an existing container without mutating it:

```typescript
const base = container()
  .add('logger', () => new LoggerService())
  .build();

const extended = base.extend({
  db: (c) => new Database(c.logger),  // c typed as typeof base
});

extended.logger; // shared singleton from base
extended.db;     // new dependency
```

> **scope vs extend:** `scope()` creates a parent-child chain. `extend()` creates a flat container with merged factories and shared cache. Use `scope()` for per-request isolation, `extend()` for additive composition.

### Modules

A module is a function `(builder) => builder` that chains `.add()` calls. `c` is fully typed in every factory.

#### Pre-build: `addModule()` on the builder

```typescript
import { container, ContainerBuilder } from 'inwire';

function dbModule<T extends { config: { dbUrl: string }; logger: Logger }>(
  b: ContainerBuilder<Record<string, unknown>, T>,
) {
  return b
    .add('db', (c) => new Database(c.config.dbUrl))
    .add('cache', (c) => new Redis(c.config.dbUrl));
}

const app = container()
  .add('config', { dbUrl: 'postgres://...', port: 3000 })
  .add('logger', () => new Logger())
  .addModule(dbModule)
  .build();
```

#### Post-build: `module()` on the container

Compose modules after `.build()` — same DX, applied to an existing container:

```typescript
const core = container()
  .add('config', { dbUrl: 'postgres://...' })
  .add('logger', () => new Logger())
  .build();

const withDb = core.module((b) => b
  .add('db', (c) => new Database(c.config.dbUrl))
  .add('cache', (c) => new Redis(c.config.dbUrl))
);

// Chainable
const full = withDb.module((b) => b
  .add('userService', (c) => new UserService(c.db, c.logger))
);
```

`module()` uses the builder internally for typed `c`, then delegates to `extend()`. Works on `scope()` and `extend()` results too.

### Preload

```typescript
await app.preload('db', 'cache'); // resolve specific deps
await app.preload();              // resolve ALL
```

### Reset

```typescript
app.db;           // creates Database
app.reset('db');
app.db;           // creates a NEW Database instance
```

### Introspection

```typescript
app.inspect();     // full dependency graph (JSON)
app.describe('db'); // single provider info
app.health();      // health status + warnings
String(app);       // human-readable
```

Feed the graph to an LLM:

```typescript
const graph = JSON.stringify(app.inspect(), null, 2);
```

### Smart Errors

7 error types, each with `hint`, `details`, and actionable suggestions:

```typescript
// Reserved key
container().add('inspect', () => 'foo');
// ReservedKeyError: 'inspect' is a reserved container method.

// Missing dependency with fuzzy suggestion
app.userServce; // typo
// ProviderNotFoundError: Did you mean 'userService'?

// Circular dependency
// CircularDependencyError: Cycle: authService -> userService -> authService
```

### Scope Mismatch Detection

```typescript
app.health().warnings;
// [{ type: 'scope_mismatch', message: "Singleton 'userService' depends on transient 'requestId'." }]
```

### Duplicate Key Detection

```typescript
import { detectDuplicateKeys } from 'inwire';

detectDuplicateKeys(authModule, userModule);
// ['logger']
```

## Examples

| Example | Run | Showcases |
|---|---|---|
| [01-web-service.ts](examples/01-web-service.ts) | `npm run example:web` | Contract mode, lifecycle, dependency inversion, scope, introspection |
| [02-modular-testing.ts](examples/02-modular-testing.ts) | `npm run example:test` | Free mode, instance values, test overrides, extend + transient |
| [03-plugin-system.ts](examples/03-plugin-system.ts) | `npm run example:plugin` | Extend chain, scoped jobs, health, JSON graph for LLM |
| [04-modules.ts](examples/04-modules.ts) | `npm run example:modules` | addModule, module() post-build, typed reusable modules |

## Performance

Performance is not the differentiator — **every lightweight DI container lands in the same ~20 ns range for cached singletons**. The differentiator is what you get on top of that.

### Head-to-head (same scenario: 5-dep chain)

| Library | warm singleton | http handler (3 deps) | build |
|---|---|---|---|
| **inwire** | **~22 ns** | **~71 ns** | ~1,840 ns |
| ioctopus | ~20 ns | ~77 ns | ~530 ns |
| awilix | ~25 ns | ~74 ns | ~5,820 ns |
| inversify | ~580 ns | ~1,020 ns | ~10,280 ns |

On the hot path, inwire, ioctopus, and awilix are within measurement noise. Inversify is the outlier at 25x slower — it pays for its planning tree on every resolve.

Build is a cold path (runs once at startup). ioctopus is fastest because it stores raw entries with no validation. inwire sits in the middle — the Proxy setup, validation, and tracking cost ~1.5 μs extra, but that's 1.5 μs you pay once.

**What ~22 ns means in practice:** DI overhead for a full HTTP handler (3 deps) is ~71 ns — faster than `JSON.parse` on a 40-byte string (~130 ns). It's not a factor.

Run yourself: `npm run bench` / `npm run bench:compare` (Node.js v24, V8 13.6).

### What you get for the same performance

| | inwire | ioctopus | awilix | inversify |
|---|---|---|---|---|
| `c.db` — native autocomplete | Yes | No | No | No |
| Full type inference (zero annotations) | Yes | No | No | No |
| Auto dependency tracking | Yes | No | No | No |
| Introspection (JSON graph) | Yes | No | No | No |
| Fuzzy errors ("did you mean?") | Yes | No | No | No |
| Scope mismatch warnings | Yes | No | No | No |
| Lifecycle (onInit/onDestroy) | Yes | No | dispose only | No |
| Decorators required | No | No | No | Yes |
| Runtime deps | 0 | 0 | 1 | 7 |
| Bundle (unpacked) | 8.8 KB | 43 KB | 320 KB | 1,466 KB |

### Runtime compatibility

Pure ES2022. No decorators, no `reflect-metadata`, no compiler plugins.

| Runtime | Status |
|---|---|
| Node.js | Works |
| Deno | Works |
| Bun | Works |
| Cloudflare Workers | Works |
| Vercel Edge | Works |
| Browser | Works |

## Comparison

| Feature | inwire | awilix | tsyringe | Inversify | NestJS |
|---|---|---|---|---|---|
| Decorators required | No | No | Yes | Yes | Yes |
| Tokens/symbols | No | No | Yes | Yes | Yes |
| Full TS inference | Yes (builder) | No (manual Cradle) | Partial | Partial | Partial |
| Typed `c` in factories | Yes | No | N/A | N/A | N/A |
| Lazy singletons | Default | Default | Manual | Manual | Manual |
| Scoped containers | `.scope()` | `.createScope()` | `.createChildContainer()` | `.createChild()` | Module scope |
| Lifecycle hooks | `onInit`/`onDestroy` | `dispose()` | `beforeResolution`/`afterResolution` | No | `onModuleInit`/`onModuleDestroy` |
| Introspection | Built-in JSON graph | `.registrations` | `isRegistered()` | No | DevTools |
| Smart errors | 7 types + hints | Resolution chain | Generic | Generic | Generic |
| Warm singleton | ~22 ns | N/A | N/A | ~580 ns | N/A |
| Bundle (unpacked) | 8.8 KB | 320 KB | 149 KB (+reflect-metadata) | 1,466 KB | Framework |
| Runtime deps | 0 | 1 (fast-glob) | 1 (reflect-metadata) | 7 (+reflect-metadata) | Many |

## Architecture

```
src/
  index.ts                       # barrel export
  domain/
    types.ts                     # interfaces, types, RESERVED_KEYS
    errors.ts                    # 7 error classes + ScopeMismatchWarning
    lifecycle.ts                 # OnInit / OnDestroy interfaces
    validation.ts                # Validator, detectDuplicateKeys, Levenshtein
  infrastructure/
    resolver.ts                  # Resolver (Proxy handler, cache, cycle detection)
    transient.ts                 # transient() marker
  application/
    container-builder.ts         # ContainerBuilder class + container() function
    container-proxy.ts           # buildContainerProxy + scope/extend inline
    introspection.ts             # inspect, describe, health, toString
```

## LLM / AI Integration

This package ships with [llms.txt](https://llmstxt.org/) files for AI-assisted development:

- **`llms.txt`** — Concise index following the llms.txt standard
- **`llms-full.txt`** — Complete API reference optimized for LLM context windows

Compatible with [Context7](https://context7.com/) and any tool that supports the llms.txt standard.

## API Reference

### Functions

| Export | Description |
|---|---|
| `container<T?>()` | Creates a new `ContainerBuilder`. Pass interface `T` for contract mode. |
| `transient(factory)` | Marks a factory as transient (for scope/extend) |
| `detectDuplicateKeys(...modules)` | Pre-spread validation — detects duplicate keys |

### ContainerBuilder Methods

| Method | Description |
|---|---|
| `.add(key, factory)` | Register a dependency (factory or instance) |
| `.addTransient(key, factory)` | Register a transient dependency |
| `.addModule(module)` | Apply a module `(builder) => builder` |
| `.build()` | Build and return the container |

### Container Methods

| Method | Description |
|---|---|
| `.scope(extra, options?)` | Creates a child container with additional deps |
| `.extend(extra)` | Returns a new container with additional deps (shared cache) |
| `.module(fn)` | Applies a module post-build using the builder for typed `c` |
| `.preload(...keys)` | Eagerly resolves dependencies |
| `.reset(...keys)` | Invalidates cached singletons |
| `.inspect()` | Returns the full dependency graph |
| `.describe(key)` | Returns info about a single provider |
| `.health()` | Returns health status and warnings |
| `.dispose()` | Calls `onDestroy()` on all resolved instances |

### Types

| Export | Description |
|---|---|
| `Container<T>` | Full container type (resolved deps + methods) |
| `ContainerBuilder<TContract, TBuilt>` | Fluent builder class (also used in `module()` callbacks) |
| `IContainer<T>` | Container methods interface |
| `OnInit` | Interface with `onInit(): void \| Promise<void>` |
| `OnDestroy` | Interface with `onDestroy(): void \| Promise<void>` |
| `ContainerGraph` | Return type of `inspect()` |
| `ContainerHealth` | Return type of `health()` |
| `ContainerWarning` | Warning object (`scope_mismatch`) |
| `ProviderInfo` | Return type of `describe()` |
| `ScopeOptions` | Options for `scope()` (`{ name?: string }`) |

### Errors

| Export | Thrown when |
|---|---|
| `ContainerError` | Base class for all errors |
| `ContainerConfigError` | Non-function value in deps definition |
| `ReservedKeyError` | Reserved key used as dependency name |
| `ProviderNotFoundError` | Dependency not found during resolution |
| `CircularDependencyError` | Circular dependency detected |
| `UndefinedReturnError` | Factory returned `undefined` |
| `FactoryError` | Factory threw during resolution |
| `ScopeMismatchWarning` | Singleton depends on transient |

## License

MIT
