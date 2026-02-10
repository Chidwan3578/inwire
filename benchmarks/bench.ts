import { container, transient } from '../src/index.js';

// ─── Helpers ────────────────────────────────────────────

function bench(label: string, fn: () => void, ops: number): { ops: number; totalMs: number; opsPerSec: number; nsPerOp: number } {
  // Warm up
  for (let i = 0; i < Math.min(ops, 1000); i++) fn();

  const start = performance.now();
  for (let i = 0; i < ops; i++) fn();
  const totalMs = performance.now() - start;

  return {
    ops,
    totalMs: Math.round(totalMs * 100) / 100,
    opsPerSec: Math.round(ops / (totalMs / 1000)),
    nsPerOp: Math.round((totalMs / ops) * 1_000_000 * 100) / 100,
  };
}

function printResult(label: string, r: { ops: number; totalMs: number; opsPerSec: number; nsPerOp: number }) {
  const opsStr = r.opsPerSec.toLocaleString('en-US');
  console.log(`  ${label.padEnd(40)} ${String(r.nsPerOp).padStart(8)} ns/op   ${opsStr.padStart(14)} ops/s`);
}

// ─── Baselines ──────────────────────────────────────────

console.log('=== Baselines (theoretical minimum) ===\n');

const plainObj = { a: 1, b: 2, c: 3, d: 4, e: 5 };
const map = new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5]]);
const proxyObj = new Proxy({}, { get: (_, k) => map.get(k as string) });

let sink: unknown;

printResult('Plain object property access', bench('plain', () => { sink = plainObj.e; }, 1_000_000));
printResult('Map.get(key)', bench('map', () => { sink = map.get('e'); }, 1_000_000));
printResult('Proxy + Map.get(key)', bench('proxy+map', () => { sink = proxyObj.e; }, 1_000_000));

// ─── inwire: Build ──────────────────────────────────────

console.log('\n=== inwire: Container Build ===\n');

printResult('Build (3 deps)', bench('build-3', () => {
  container()
    .add('a', () => 1)
    .add('b', (c) => c.a + 1)
    .add('c', (c) => c.b + 1)
    .build();
}, 100_000));

printResult('Build (10 deps)', bench('build-10', () => {
  container()
    .add('a', () => 1)
    .add('b', (c) => c.a)
    .add('c', (c) => c.b)
    .add('d', (c) => c.c)
    .add('e', (c) => c.d)
    .add('f', (c) => c.e)
    .add('g', (c) => c.f)
    .add('h', (c) => c.g)
    .add('i', (c) => c.h)
    .add('j', (c) => c.i)
    .build();
}, 50_000));

// ─── inwire: Resolve ────────────────────────────────────

console.log('\n=== inwire: Resolve ===\n');

const app = container()
  .add('config', { port: 3000, host: 'localhost' })
  .add('logger', () => ({ log: (m: string) => m }))
  .add('db', (c) => ({ query: (q: string) => q, config: c.config }))
  .add('userRepo', (c) => ({ find: (id: string) => c.db.query(id) }))
  .add('userService', (c) => ({ get: (id: string) => c.userRepo.find(id) }))
  .build();

// Cold resolve (first access, triggers factory + cache)
printResult('Cold resolve (5-dep chain)', bench('cold', () => {
  const c = container()
    .add('a', () => 1)
    .add('b', (c) => c.a + 1)
    .add('c', (c) => c.b + 1)
    .add('d', (c) => c.c + 1)
    .add('e', (c) => c.d + 1)
    .build();
  sink = c.e;
}, 50_000));

// Warm singleton (cached, measures pure Proxy overhead)
// Force first resolve
sink = app.userService;
printResult('Warm singleton (cached)', bench('warm', () => { sink = app.userService; }, 1_000_000));

// Transient
let ctr = 0;
const trApp = container().addTransient('id', () => ++ctr).build();
sink = trApp.id; // warm
printResult('Transient resolve', bench('transient', () => { sink = trApp.id; }, 1_000_000));

// ─── inwire: Scope & Extend ────────────────────────────

console.log('\n=== inwire: Scope & Extend ===\n');

printResult('Scope creation', bench('scope', () => {
  sink = app.scope({ requestId: () => crypto.randomUUID() });
}, 100_000));

printResult('Scope creation + resolve', bench('scope+resolve', () => {
  const s = app.scope({ requestId: () => crypto.randomUUID() });
  sink = s.requestId;
}, 100_000));

printResult('Extend', bench('extend', () => {
  sink = app.extend({ extra: () => 42 });
}, 100_000));

// ─── inwire: Introspection ─────────────────────────────

console.log('\n=== inwire: Introspection ===\n');

// Force resolve all
app.userService;
printResult('inspect()', bench('inspect', () => { sink = app.inspect(); }, 100_000));
printResult('health()', bench('health', () => { sink = app.health(); }, 100_000));
printResult('describe(key)', bench('describe', () => { sink = app.describe('userService'); }, 100_000));

// ─── inwire: Lifecycle ──────────────────────────────────

console.log('\n=== inwire: Lifecycle ===\n');

printResult('preload() (5 deps, already cached)', bench('preload', () => {
  app.preload();
}, 100_000));

printResult('reset() + re-resolve', bench('reset', () => {
  app.reset('userService');
  sink = app.userService;
}, 100_000));

// ─── Context: Real-world cost ──────────────────────────

console.log('\n=== Real-world Context ===\n');

// Simulate what an HTTP handler does: access 3 deps
sink = app.userService; // ensure warm
const httpResult = bench('http-handler (3 dep accesses)', () => {
  sink = app.logger;
  sink = app.db;
  sink = app.userService;
}, 1_000_000);
printResult('HTTP handler (3 warm singletons)', httpResult);

// Compare: JSON.parse a small object (common HTTP overhead)
const jsonStr = '{"id":1,"name":"test","email":"a@b.com"}';
const jsonResult = bench('json-parse', () => { sink = JSON.parse(jsonStr); }, 1_000_000);
printResult('JSON.parse (small object)', jsonResult);

console.log(`\n  → DI overhead per request: ${httpResult.nsPerOp}ns vs JSON.parse: ${jsonResult.nsPerOp}ns`);
console.log(`  → DI is ${(jsonResult.nsPerOp / httpResult.nsPerOp).toFixed(0)}x faster than parsing a tiny JSON`);

// ─── Memory ─────────────────────────────────────────────

console.log('\n=== Memory ===\n');
const mem = process.memoryUsage();
console.log(`  RSS:  ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
console.log(`  Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`);

// Prevent dead code elimination
if (sink === Symbol()) console.log(sink);
