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
 * The check is the engine's own, not a proxy: `--allow-natives-syntax` is set
 * at runtime and `%HaveSameMap` compiled after it. A key-order comparison
 * would pass for maps V8 still keeps apart.
 *
 * The last test pins the sync COMMAND's map the same way: dispatch, query
 * and request build one map, and the `signal` option request() takes since
 * v1.20.0 settles the request without becoming a field on it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setFlagsFromString } from 'node:v8';
import { describe, expect, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type CommandResult } from '../src/command-bus';
import { authGuard, debounce, optimisticUndo, throttle, validator } from '../src/plugins-core';
import { createHttpBridge } from '../src/transports';
import { it } from '../src/vitest';

setFlagsFromString('--allow-natives-syntax');
const haveSameMap = new Function('a', 'b', 'return %HaveSameMap(a, b)') as (a: object, b: object) => boolean;

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
    expect(haveSameMap(ref, bus.dispatch('missing', 1))).toBe(true);
  });

  it('plugin-built results share the bus\'s map', async () => {
    const v = createCommandBus();
    v.register('t', () => 1);
    v.use(validator({ t: () => 'bad' }));
    expect(haveSameMap(ref, v.dispatch('t', 1))).toBe(true);

    const g = createCommandBus();
    g.register('t', () => 1);
    g.use(authGuard({ isAuthenticated: () => false, protected: ['t'] }));
    expect(haveSameMap(ref, g.dispatch('t', 1))).toBe(true);

    const d = createCommandBus();
    d.register('t', () => 1);
    const deb = debounce(['t'], 5);
    d.use(deb);
    expect(haveSameMap(ref, d.dispatch('t', 1))).toBe(true);
    deb.dispose();

    const th = createCommandBus();
    th.register('t', () => 1);
    const thr = throttle(['t'], 1000);
    th.use(thr);
    th.dispatch('t', 1);
    expect(haveSameMap(ref, th.dispatch('t', 1))).toBe(true);
    thr.dispose();

    const o = createAsyncCommandBus();
    o.register('t', async () => 1, { undo: () => {} });
    o.use(optimisticUndo(o as any, ['t']));
    expect(haveSameMap(ref, await o.dispatch('t', 1))).toBe(true);
  });

  it('HTTP bridge results share the bus\'s map', async () => {
    expect(haveSameMap(ref, await bridged({ state: 1 }))).toBe(true);
    expect(haveSameMap(ref, await bridged({}, false, 503))).toBe(true);
    expect(haveSameMap(ref, await bridged({ ok: false, error: 'no' }))).toBe(true);
    expect(haveSameMap(ref, await bridged({ redirect: '/x' }))).toBe(true);
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
    for (const cmd of seen.slice(1)) expect(haveSameMap(seen[0], cmd)).toBe(true);
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
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/^\s*(\/?\*|\/\/)/.test(line) || line.includes('results') || line.includes('Object.freeze')) return;
        if (/\{ *ok: *(true|false) *,/.test(line) && !/function (ok|err)Result/.test(line)) {
          offenders.push(`${f.slice(root.length + 1)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
