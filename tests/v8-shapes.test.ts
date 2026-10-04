/**
 * V8 alignment: every CommandResult the library hands back shares ONE hidden
 * class - `okResult`/`errResult`'s `{ ok, value, error }`.
 *
 * docs/performance.md promised this ("one hidden class for both, monomorphic
 * property access at every consumer site") while ~30 sites outside the bus
 * built their own literal: `{ ok: false, error }` (two fields),
 * `{ ok: true, value }` (two fields), and `{ ok: false, error, value }` (three
 * fields, another order). Each is a different map, so a `result.ok` site that
 * saw a validator rejection, an HTTP bridge result and a plain dispatch was
 * polymorphic. Measured with %HaveSameMap before the fix: validator, authGuard,
 * debounce and async optimisticUndo results all differed from the bus's own.
 *
 * The check is the engine's own, not a proxy: `sameMap` (tests/v8.ts) is
 * V8's `%HaveSameMap`. A key-order comparison would pass for maps V8 still
 * keeps apart.
 *
 * The last test pins the sync COMMAND's map the same way: dispatch, query
 * and request build one map, and the `signal` option request() takes settles
 * the request without becoming a field on it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type CommandResult } from '../src/command-bus';
import { authGuard, debounce, optimisticUndo, throttle, validator } from '../src/plugins-core';
import { idempotent } from '../src/plugins-extra';
import { validateSchemas } from '../src/plugins-schema';
import { schemaValidator } from '../src/schema';
import { rehydrate } from '../src/ssr';
import { createHttpBridge } from '../src/transports';
import { it } from '../src/vitest';
import { sameMap } from './v8';

function busResult(): CommandResult {
  const bus = createCommandBus();
  bus.register('t', () => 1);
  return bus.dispatch('t', 1);
}

function bridged(data: unknown, ok = true, status = 200): Promise<CommandResult> {
  const httpClient = { post: vi.fn().mockResolvedValue({ ok, status, headers: {}, data }) } as any;
  const bus = createAsyncCommandBus();
  bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient }));
  return bus.dispatch('save', {});
}

describe('CommandResult hidden class', () => {
  const ref = busResult();

  it('the bus\'s own ok and error results share one map', ({ bus }) => {
    expect(sameMap(ref, bus.dispatch('missing', 1))).toBe(true);
  });

  it('plugin-built results share the bus\'s map', async () => {
    const v = createCommandBus();
    v.register('t', () => 1);
    v.use(validator({ t: () => 'bad' }));
    expect(sameMap(ref, v.dispatch('t', 1))).toBe(true);

    const g = createCommandBus();
    g.register('t', () => 1);
    g.use(authGuard({ isAuthenticated: () => false, protected: ['t'] }));
    expect(sameMap(ref, g.dispatch('t', 1))).toBe(true);

    const d = createCommandBus();
    d.register('t', () => 1);
    const deb = debounce(['t'], 5);
    d.use(deb);
    expect(sameMap(ref, d.dispatch('t', 1))).toBe(true);
    deb.dispose();

    const th = createCommandBus();
    th.register('t', () => 1);
    const thr = throttle(['t'], 1000);
    th.use(thr);
    th.dispatch('t', 1);
    expect(sameMap(ref, th.dispatch('t', 1))).toBe(true);
    thr.dispose();

    const o = createAsyncCommandBus();
    o.register('t', async () => 1, { undo: () => {} });
    o.use(optimisticUndo(o as any, ['t']));
    expect(sameMap(ref, await o.dispatch('t', 1))).toBe(true);
  });

  it('schema validators\' rejections share the bus\'s map', () => {
    const s = createCommandBus();
    s.register('t', () => 1);
    s.use(schemaValidator({ t: { description: 't', target: { id: 'number' } } }));
    const rejected = s.dispatch('t', { id: 'x' });
    expect(rejected.ok).toBe(false);
    expect(sameMap(ref, rejected)).toBe(true);

    const v = createCommandBus();
    v.register('t', () => 1);
    v.use(validateSchemas({ t: { '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message: 'bad' }] }) } } as never }));
    const refused = v.dispatch('t', 1);
    expect(refused.ok).toBe(false);
    expect(sameMap(ref, refused)).toBe(true);
  });

  it('rehydrate()\'s refusal of an async bus shares the bus\'s map', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = createAsyncCommandBus();
    a.register('t', async () => 1);
    const [refused] = rehydrate(a, [{ action: 't', target: 1 }]);
    warn.mockRestore();
    expect(refused.ok).toBe(false);
    expect(sameMap(ref, refused)).toBe(true);
  });

  it('HTTP bridge results share the bus\'s map', async () => {
    expect(sameMap(ref, await bridged({ state: 1 }))).toBe(true);
    expect(sameMap(ref, await bridged({}, false, 503))).toBe(true);
    expect(sameMap(ref, await bridged({ ok: false, error: 'no' }))).toBe(true);
    expect(sameMap(ref, await bridged({ redirect: '/x' }))).toBe(true);
  });

  it('the sync bus builds one command map across dispatch, query and request', async ({ bus }) => {
    // The async bus adds `signal` and is its own map by design (the shape
    // note in docs/performance.md). On the sync bus a request()'s signal
    // settles the request's promise and never reaches the command, so the
    // responder sees the map every handler sees.
    const seen: object[] = [];
    bus.register('t', (cmd) => { seen.push(cmd); return 1; });
    bus.respond('q', (cmd) => { seen.push(cmd); return 1; });
    bus.dispatch('t', 1);
    bus.query('t', 1);
    await bus.request('q', 1, undefined, { signal: new AbortController().signal });
    await bus.request('q', 1);
    expect(seen).toHaveLength(4);
    for (const cmd of seen.slice(1)) expect(sameMap(seen[0], cmd)).toBe(true);
  });

  it('a command\'s meta keeps one map when an idempotency key is stamped later', async () => {
    // stampMeta's literal holds `idempotencyKey` from the start, so the
    // plugins that stamp it (idempotent, the outbox, the retry) fill a slot
    // instead of adding a property (a hidden-class transition, V8 rule 2).
    const seen: object[] = [];
    const plain = createAsyncCommandBus();
    plain.register('t', async (cmd) => { seen.push(cmd.meta!); return 1; });
    await plain.dispatch('t', 1);
    const keyed = createAsyncCommandBus();
    keyed.register('t', async (cmd) => { seen.push(cmd.meta!); return 1; });
    keyed.use(idempotent());
    await keyed.dispatch('t', 2);
    expect(seen).toHaveLength(2);
    expect((seen[1] as { idempotencyKey?: string }).idempotencyKey).toBeDefined();
    expect(sameMap(seen[0], seen[1])).toBe(true);
  });

  it("a command's meta keeps one map when a bridge fills its response", async () => {
    const seen: object[] = [];
    const local = createAsyncCommandBus();
    local.register('t', async (cmd) => { seen.push(cmd.meta!); return 1; });
    await local.dispatch('t', 1);
    const h = { 'content-type': 'application/json' };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, url: '', redirected: false, headers: { entries: () => Object.entries(h), get: () => h['content-type'] }, text: async () => '{"state":1}' })));
    const bridged = createAsyncCommandBus({ retry: false });
    bridged.use(createHttpBridge({ endpoint: '/vc' }));
    bridged.on('*', (cmd) => { seen.push(cmd.meta!); });
    await bridged.dispatch('t', 2);
    vi.unstubAllGlobals();
    expect((seen[1] as { response?: unknown }).response).toBeDefined();
    expect(sameMap(seen[0], seen[1])).toBe(true);
  });

  it("a command's meta keeps one map when a plugin sets its request", async () => {
    const seen: object[] = [];
    const bus = createAsyncCommandBus();
    bus.register('t', async (cmd) => { seen.push(cmd.meta!); return 1; });
    await bus.dispatch('t', 1);
    bus.use((cmd, next) => { cmd.meta!.request = { headers: { traceparent: 'x' } }; return next(); });
    await bus.dispatch('t', 2);
    expect((seen[1] as { request?: unknown }).request).toBeDefined();
    expect(sameMap(seen[0], seen[1])).toBe(true);
  });

  it('src/ builds no CommandResult literal of its own', () => {
    // The discipline the maps above depend on: results come from
    // okResult/errResult (`_okResult`/`_errResult` outside command-bus.ts).
    // Batch and workflow results are other types (they carry `results`), and
    // testing.ts is the test double, excluded from the shipped surface.
    // EMIT_RESULT is exempt: it is frozen, and a frozen object has its own
    // map whatever its keys - one shared singleton, documented at its site.
    const root = resolve(__dirname, '../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('testing.ts')) files.push(p);
      }
    };
    walk(root);
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/?\*|\/\/)/.test(line) || line.includes('results') || line.includes('Object.freeze')) return;
        if (/\{ *ok: *(true|false) *,/.test(line) && !/function (ok|err)Result/.test(line)) {
          offenders.push(`${f.slice(root.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
      // The same literal split over lines (`{` then `ok: false,` below it),
      // which the line scan above cannot see: three sites hid there.
      for (const m of text.matchAll(/\{[ \t]*\n[ \t]*ok:[ \t]*(true|false)[ \t]*,/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${f.slice(root.length + 1)}:${line}: (a literal over several lines)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
