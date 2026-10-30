/**
 * Every CommandResult, Command, meta, hook entry and transport object the library builds shares one hidden class per kind, checked with V8's own %HaveSameMap.
 * Why: a read-many object built from literals with another field count or order is another map, so a site that reads results from a validator, an HTTP bridge and a plain dispatch would turn polymorphic.
 * Shows: the bus's own results, plugin-built results (validator, authGuard, pace, optimistic), schema rejections and HTTP bridge results share one map; commands from both buses and every entry point share one map; a meta keeps its map when an idempotency key, a bridge response or a plugin request is added; a command from another tab keeps its map; src builds no CommandResult literal outside okResult and errResult; hook state, hook entries and transports share their maps; each control tells another shape apart.
 * See: docs/V8-RULES.md, tests/v8.ts, log s36.F56, log s36.F30, log s35.209
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, vi } from 'vitest';
import { _replayOf, createAsyncCommandBus, createCommandBus, createCommandPool, type CommandResult } from '../src/command-bus';
import { createTestBus } from '../src/testing';
import { authGuard, history, validator } from '../src/plugins-core';
import { defineChamberStore } from '../src/store/core';
import { shareTabs } from '../src/store-share';
import { listen, quiet } from './tabs-quiet';
import { pace } from '../src/pace';
import { idempotent } from '../src/plugins-extra';
import { validateSchemas } from '../src/plugins-schema';
import { schemaValidator } from '../src/schema';
import { defineTransport, httpTransport } from '../src/transports';
import { it } from '../src/vitest';
import { sameMap } from './v8';

function busResult(): CommandResult {
  const bus = createCommandBus();
  bus.register('t', () => 1);
  return bus.dispatch('t', 1);
}

function bridged(data: unknown, ok = true, status = 200): Promise<CommandResult> {
  const httpClient = { post: vi.fn().mockResolvedValue({ ok, status, headers: {}, data }) } as any;
  const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', httpClient }) });
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
    const deb = pace(d.dispatch, { debounce: 5 });
    const superseded = deb('t', 1);
    deb.dispose();
    expect(sameMap(ref, await superseded)).toBe(true);

    const th = createCommandBus();
    th.register('t', () => 1);
    const thr = pace(th.dispatch, { throttle: 1000 });
    await thr('t', 1);
    expect(sameMap(ref, await thr('t', 1))).toBe(true);
    thr.dispose();

    const o = createAsyncCommandBus();
    o.register('t', async () => 1, { undo: () => {}, optimistic: true });
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

  it('HTTP bridge results share the bus\'s map', async () => {
    expect(sameMap(ref, await bridged({ state: 1 }))).toBe(true);
    expect(sameMap(ref, await bridged({}, false, 503))).toBe(true);
    expect(sameMap(ref, await bridged({ ok: false, error: 'no' }))).toBe(true);
    expect(sameMap(ref, await bridged({ redirect: '/x' }))).toBe(true);
  });

  it('every command shares one map: both buses, dispatch, query, batch, request, a replay and the test bus', async ({ bus }) => {
    // Every command literal carries `signal`, undefined when unset; request()'s own signal settles its promise and never reaches the command.
    const seen: object[] = [];
    bus.register('t', (cmd) => { seen.push(cmd); return 1; });
    bus.respond('q', (cmd) => { seen.push(cmd); return 1; });
    bus.dispatch('t', 1);
    bus.query('t', 1);
    bus.dispatchBatch([{ action: 't', target: 1 }]);
    await bus.request('q', 1, undefined, { signal: new AbortController().signal });
    expect((seen[seen.length - 1] as { signal?: unknown }).signal).toBeUndefined();
    const a = createAsyncCommandBus({ retry: false });
    a.register('t', (cmd) => { seen.push(cmd); return 1; });
    await a.dispatch('t', 1);
    await a.query('t', 1);
    seen.push(_replayOf('t', 1, undefined, 'k'));
    const t = createTestBus({ passthroughHandlers: true });
    t.register('t', (cmd) => { seen.push(cmd); return 1; });
    t.dispatch('t', 1);
    seen.push(createCommandPool(1).acquire('t', 1));
    expect(seen).toHaveLength(9);
    for (const cmd of seen.slice(1)) expect(sameMap(seen[0], cmd)).toBe(true);
  });

  it('control: a command literal without `signal` is another map', ({ bus }) => {
    let cmd: object | undefined;
    bus.register('t', (c) => { cmd = c; return 1; });
    bus.dispatch('t', 1);
    expect(sameMap(cmd!, { action: 't', target: 1, payload: undefined, meta: (cmd as { meta: unknown }).meta })).toBe(false);
  });

  it('a command\'s meta keeps one map when an idempotency key is stamped later', async () => {
    // stampMeta's literal holds `idempotencyKey` from the start, so stamping it later fills a slot instead of adding a property (V8 rule 2).
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
    const bridged = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc' }) });
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
    bus.use({ started: (cmd) => { cmd.meta!.request = { headers: { traceparent: 'x' } }; } });
    await bus.dispatch('t', 2);
    expect((seen[1] as { request?: unknown }).request).toBeDefined();
    expect(sameMap(seen[0], seen[1])).toBe(true);
  });

  it("a command another tab sent keeps the sync command's map and the meta's (log 36.F30)", async () => {
    vi.stubGlobal('window', {}); // a page: shareTabs opens only where there are tabs
    const name = `v8-tabs-${Math.random()}`;
    const wire = listen(name);
    const make = () => {
      const bus = createCommandBus();
      const h = history({ bus });
      const s = defineChamberStore('cart', { state: () => ({ n: 0 }), reducers: { add: (st: { n: number }) => ({ n: st.n + 1 }) }, undo: true, share: shareTabs(name) })(bus);
      return { h, s };
    };
    const a = make();
    const b = make();
    try {
      await quiet(wire.heard);
      a.s.add();
      await quiet(wire.heard);
      const local = a.h.getState().past[0]!;
      const got = b.h.getState().past[0]!;
      expect(got).not.toBe(local);
      expect(sameMap(local, got)).toBe(true);
      expect(sameMap(local.meta!, got.meta!)).toBe(true);
      // Control: a command literal without `meta` is another map.
      expect(sameMap(local, { action: 'cartAdd', target: undefined, payload: undefined })).toBe(false);
    } finally {
      a.s.$dispose();
      b.s.$dispose();
      wire.close();
      vi.unstubAllGlobals();
    }
  });

  it('src/ builds no CommandResult literal of its own', () => {
    // Results come from okResult/errResult (`_okResult`/`_errResult` outside command-bus.ts); excluded: batch and workflow results (they carry `results`), the testing.ts double, and the frozen EMIT_RESULT singleton (a frozen object has its own map).
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
      // The same literal split over lines (`{` then `ok: false,` below it), which the line scan cannot see.
      for (const m of text.matchAll(/\{[ \t]*\n[ \t]*ok:[ \t]*(true|false)[ \t]*,/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        offenders.push(`${f.slice(root.length + 1)}:${line}: (a literal over several lines)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// A removal assigns a new array to the bus state, and every hook entry is built by one literal.
describe('hook lists', () => {
  const stateOf = (bus: object): Record<string, unknown> => {
    const key = Object.getOwnPropertySymbols(bus).find((s) => s.description === 'vapor-chamber:inspect')!;
    return (bus as Record<symbol, Record<string, unknown>>)[key];
  };

  it('a removal keeps the bus state on its map, on both buses', () => {
    for (const make of [createCommandBus, createAsyncCommandBus]) {
      const fresh = make();
      fresh.onAfter(() => {});
      const removed = make();
      const offA = removed.onAfter(() => {});
      offA();
      expect(sameMap(stateOf(fresh), stateOf(removed))).toBe(true);
    }
  });

  it('control: the check tells two state shapes apart', () => {
    expect(sameMap(stateOf(createCommandBus()), stateOf(createAsyncCommandBus()))).toBe(false);
  });

  it('every hook entry shares one map: sync and async', () => {
    const sync = createCommandBus();
    const async = createAsyncCommandBus();
    sync.onAfter(() => {});
    async.onAfter(async () => {});
    const entries = [sync, async].map((b) => (stateOf(b) as { afterHooks: object[] }).afterHooks[0]);
    for (const e of entries) expect(sameMap(entries[0], e)).toBe(true);
  });
});

// A transport is read on every sent dispatch (`rec.transport.send`): each
// factory builds one literal, `localFallback` always a boolean in one place.
describe('transport objects', () => {
  const send = async (): Promise<CommandResult> => ({ ok: true, value: 1, error: undefined });

  it('defineTransport keeps one map with and without localFallback', () => {
    expect(sameMap(defineTransport(send), defineTransport(send, { localFallback: true }))).toBe(true);
    expect(sameMap(defineTransport(send), defineTransport(send, {}))).toBe(true);
  });

  it('two httpTransports, single and batched, share one map', () => {
    expect(sameMap(httpTransport({ endpoint: '/a' }), httpTransport({ endpoint: '/b', batch: {} }))).toBe(true);
  });

  it('control: the check tells a literal without the field apart', () => {
    expect(sameMap(defineTransport(send), { id: 'transport', send })).toBe(false);
  });
});
