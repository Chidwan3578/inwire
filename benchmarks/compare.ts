/**
 * Head-to-head DI container benchmark.
 *
 * Same scenario for each library:
 *   config (value) → logger (factory) → db (factory) → userRepo → userService
 *
 * Measured:
 *   1. Container build + bind (cold)
 *   2. First resolve through the full chain (cold resolve)
 *   3. Cached singleton access (warm resolve)
 *   4. N resolves simulating HTTP handler
 */

import { container } from '../src/index.js';
import { Container as InversifyContainer } from 'inversify';
import { createContainer as createAwilix, asValue, asFunction } from 'awilix';
import { createContainer as createIoctopus } from '@evyweb/ioctopus';

// ─── Helpers ────────────────────────────────────────────

function bench(fn: () => void, ops: number): { totalMs: number; nsPerOp: number; opsPerSec: number } {
  // Warm up
  for (let i = 0; i < Math.min(ops, 1000); i++) fn();

  const start = performance.now();
  for (let i = 0; i < ops; i++) fn();
  const totalMs = performance.now() - start;

  return {
    totalMs: Math.round(totalMs * 100) / 100,
    nsPerOp: Math.round((totalMs / ops) * 1_000_000 * 100) / 100,
    opsPerSec: Math.round(ops / (totalMs / 1000)),
  };
}

let sink: unknown;

function row(lib: string, op: string, r: { nsPerOp: number; opsPerSec: number }) {
  console.log(
    `| ${lib.padEnd(14)} | ${op.padEnd(26)} | ${String(r.nsPerOp).padStart(10)} ns | ${r.opsPerSec.toLocaleString('en-US').padStart(14)} |`,
  );
}

// ─── Shared types ───────────────────────────────────────

interface Config { port: number; host: string }
interface Logger { log: (m: string) => string }
interface Db { query: (q: string) => string }
interface UserRepo { find: (id: string) => string }
interface UserService { get: (id: string) => string }

const makeConfig = (): Config => ({ port: 3000, host: 'localhost' });
const makeLogger = (): Logger => ({ log: (m: string) => m });
const makeDb = (config: Config): Db => ({ query: (q: string) => config.host + ':' + q });
const makeUserRepo = (db: Db): UserRepo => ({ find: (id: string) => db.query(id) });
const makeUserService = (repo: UserRepo): UserService => ({ get: (id: string) => repo.find(id) });

const OPS_BUILD = 50_000;
const OPS_COLD = 50_000;
const OPS_WARM = 1_000_000;
const OPS_HTTP = 500_000;

// ─── inwire ─────────────────────────────────────────────

function buildInwire() {
  return container()
    .add('config', makeConfig())
    .add('logger', () => makeLogger())
    .add('db', (c) => makeDb(c.config))
    .add('userRepo', (c) => makeUserRepo(c.db))
    .add('userService', (c) => makeUserService(c.userRepo))
    .build();
}

// ─── inversify ──────────────────────────────────────────

function buildInversify() {
  const c = new InversifyContainer();
  c.bind<Config>('config').toConstantValue(makeConfig());
  c.bind<Logger>('logger').toDynamicValue(() => makeLogger());
  c.bind<Db>('db').toDynamicValue((ctx) => makeDb(ctx.get<Config>('config')));
  c.bind<UserRepo>('userRepo').toDynamicValue((ctx) => makeUserRepo(ctx.get<Db>('db')));
  c.bind<UserService>('userService').toDynamicValue((ctx) => makeUserService(ctx.get<UserRepo>('userRepo')));
  return c;
}

// ─── awilix ─────────────────────────────────────────────

function buildAwilix() {
  const c = createAwilix();
  c.register({
    config: asValue(makeConfig()),
    logger: asFunction(() => makeLogger()).singleton(),
    db: asFunction(({ config }: { config: Config }) => makeDb(config)).singleton(),
    userRepo: asFunction(({ db }: { db: Db }) => makeUserRepo(db)).singleton(),
    userService: asFunction(({ userRepo }: { userRepo: UserRepo }) => makeUserService(userRepo)).singleton(),
  });
  return c;
}

// ─── ioctopus ───────────────────────────────────────────

function buildIoctopus() {
  const c = createIoctopus();
  c.bind('config').toValue(makeConfig());
  c.bind('logger').toFactory(() => makeLogger());
  c.bind('db').toFactory(() => makeDb(c.get<Config>('config')));
  c.bind('userRepo').toFactory(() => makeUserRepo(c.get<Db>('db')));
  c.bind('userService').toFactory(() => makeUserService(c.get<UserRepo>('userRepo')));
  return c;
}

// ─── Run ────────────────────────────────────────────────

console.log('');
console.log('DI Container Benchmark — 5 deps (config → logger → db → userRepo → userService)');
console.log('Node ' + process.version + ', V8 ' + process.versions.v8);
console.log('');
console.log('| Library        | Operation                  |     ns/op    |        ops/sec |');
console.log('|----------------|----------------------------|--------------|----------------|');

// --- Build ---

row('inwire', 'build', bench(() => { sink = buildInwire(); }, OPS_BUILD));
row('inversify', 'build', bench(() => { sink = buildInversify(); }, OPS_BUILD));
row('awilix', 'build', bench(() => { sink = buildAwilix(); }, OPS_BUILD));
row('ioctopus', 'build', bench(() => { sink = buildIoctopus(); }, OPS_BUILD));

// --- Cold resolve (build + first access to userService) ---

row('inwire', 'cold resolve (full chain)', bench(() => {
  const c = buildInwire();
  sink = c.userService;
}, OPS_COLD));

row('inversify', 'cold resolve (full chain)', bench(() => {
  const c = buildInversify();
  sink = c.get<UserService>('userService');
}, OPS_COLD));

row('awilix', 'cold resolve (full chain)', bench(() => {
  const c = buildAwilix();
  sink = c.resolve<UserService>('userService');
}, OPS_COLD));

row('ioctopus', 'cold resolve (full chain)', bench(() => {
  const c = buildIoctopus();
  sink = c.get<UserService>('userService');
}, OPS_COLD));

// --- Warm singleton resolve ---

const iw = buildInwire();
sink = iw.userService; // warm

const iv = buildInversify();
sink = iv.get<UserService>('userService'); // warm

const aw = buildAwilix();
sink = aw.resolve<UserService>('userService'); // warm

const io = buildIoctopus();
sink = io.get<UserService>('userService'); // warm

row('inwire', 'warm singleton', bench(() => { sink = iw.userService; }, OPS_WARM));
row('inversify', 'warm singleton', bench(() => { sink = iv.get<UserService>('userService'); }, OPS_WARM));
row('awilix', 'warm singleton', bench(() => { sink = aw.resolve<UserService>('userService'); }, OPS_WARM));
row('ioctopus', 'warm singleton', bench(() => { sink = io.get<UserService>('userService'); }, OPS_WARM));

// --- HTTP handler: resolve 3 deps (warm) ---

row('inwire', 'http handler (3 resolves)', bench(() => {
  sink = iw.logger;
  sink = iw.db;
  sink = iw.userService;
}, OPS_HTTP));

row('inversify', 'http handler (3 resolves)', bench(() => {
  sink = iv.get<Logger>('logger');
  sink = iv.get<Db>('db');
  sink = iv.get<UserService>('userService');
}, OPS_HTTP));

row('awilix', 'http handler (3 resolves)', bench(() => {
  sink = aw.resolve<Logger>('logger');
  sink = aw.resolve<Db>('db');
  sink = aw.resolve<UserService>('userService');
}, OPS_HTTP));

row('ioctopus', 'http handler (3 resolves)', bench(() => {
  sink = io.get<Logger>('logger');
  sink = io.get<Db>('db');
  sink = io.get<UserService>('userService');
}, OPS_HTTP));

console.log('');

// Prevent DCE
if (sink === Symbol()) console.log(sink);
