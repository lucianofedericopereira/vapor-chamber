/** An empty list: none for a required ActionList, every action for an ActionScope filter (log s35.148). */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { debounce, optimisticUndo, throttle } from '../src/plugins-core';
import { cache, metrics, rateLimit } from '../src/plugins-extra';
import { createHttpBridge } from '../src/transports';

const disposers: Array<{ dispose(): void }> = [];
afterEach(() => { for (const d of disposers.splice(0)) d.dispose(); });
const keep = <T extends { dispose(): void }>(p: T): T => { disposers.push(p); return p; };

describe('a required ActionList names what the plugin acts on: [] is none', () => {
  it('debounce([]) runs every dispatch at once', () => {
    const bus = createCommandBus();
    bus.register('save', (cmd) => cmd.target);
    bus.use(keep(debounce([], 50)));
    expect(bus.dispatch('save', 7).value).toBe(7);
  });

  it('throttle([]) refuses nothing', () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('save', () => ++runs);
    bus.use(keep(throttle([], 1_000)));
    expect(bus.dispatch('save', 1).ok).toBe(true);
    expect(bus.dispatch('save', 1).ok).toBe(true);
    expect(runs).toBe(2);
  });

  it('optimisticUndo(bus, []) neither predicts nor rolls back', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const undo = vi.fn();
    bus.register('save', async () => { throw new Error('backend down'); }, { undo });
    bus.use(optimisticUndo(bus as never, [], { predict: () => 'predicted' }));
    const r = await bus.dispatch('save', 1);
    expect(r.ok).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(undo).not.toHaveBeenCalled();
  });

  it('two empty lists are two plugins, each with its own id and dispose', () => {
    const d = keep(debounce([], 1));
    const t = keep(throttle([], 1));
    expect(d).not.toBe(t);
    expect([d.id, t.id]).toEqual(['debounce', 'throttle']);
  });

  it('control: a list acts on what it names, and only on that', () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('save', () => ++runs);
    bus.register('load', (cmd) => cmd.target);
    bus.use(keep(debounce(['save'], 50)));
    bus.use(keep(throttle(['lo*'], 1_000)));
    expect(bus.dispatch('save', 1).value).toMatchObject({ pending: true });
    expect(runs).toBe(0);
    expect(bus.dispatch('load', 3).value).toBe(3);
    expect(bus.dispatch('load', 3).ok).toBe(false);
  });
});

describe('an ActionScope filter is "Default: all": absent or [] is every action, as released', () => {
  it('cache({ actions: [] }) and cache() cache every action', () => {
    for (const make of [() => cache({ actions: [] }), () => cache()]) {
      const bus = createCommandBus();
      let runs = 0;
      bus.register('load', () => ++runs);
      bus.use(make());
      bus.dispatch('load', 1);
      bus.dispatch('load', 1);
      expect(runs).toBe(1);
    }
  });

  it('rateLimit({ actions: [] }) limits every action', () => {
    const bus = createCommandBus();
    bus.register('save', () => 1);
    bus.use(rateLimit({ max: 1, window: 1_000, actions: [] }));
    expect(bus.dispatch('save', 1).ok).toBe(true);
    expect(bus.dispatch('save', 2).ok).toBe(false);
  });

  it('a bridge with actions: [] forwards every action', async () => {
    const post = vi.fn(async () => ({ ok: true, status: 200, data: { state: 'remote' }, headers: {} }));
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('anything', async () => 'local');
    bus.use(createHttpBridge({ endpoint: '/api/vc', actions: [], httpClient: { post } as never }));
    expect((await bus.dispatch('anything', 0)).value).toBe('remote');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a plugin declares the scope it was given', () => {
    expect(metrics({ actions: [] }).actions).toEqual([]);
    expect(metrics().actions).toBeUndefined();
    expect(metrics({ actions: ['cart*'] }).actions).toEqual(['cart*']);
  });

  it('a plain-JS plugin declaring actions: null runs on every action, as released', () => {
    const seen: string[] = [];
    const bus = createCommandBus();
    bus.register('save', () => 1);
    bus.use(Object.assign((cmd: { action: string }, next: () => unknown) => { seen.push(cmd.action); return next(); }, { actions: null }) as never);
    expect(bus.dispatch('save', 0).value).toBe(1);
    expect(seen).toEqual(['save']);
  });
});

describe('one reader of an ActionScope', () => {
  it('only the bus filters by a plugin\'s actions; no plugin reads its own scope', () => {
    const root = resolve(__dirname, '../src');
    const readers: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /\bactions\??\.(length|some|every|includes|filter)\b/.test(readFileSync(p, 'utf8'))) readers.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    // command-bus.ts is the reader (perAction); it also matches on a doc
    // example of inspectBus().actions, the registered names.
    expect(readers.sort()).toEqual(['command-bus.ts']);
  });
});

/*
 * Two different things, two names, each keeping its released behaviour:
 *
 * - An ActionScope is a plugin's action FILTER: the `actions` option of
 *   cache, circuitBreaker, rateLimit, metrics, serialize, idempotent,
 *   supersede, the outbox, pollWith and the three bridges, and the `actions`
 *   a plugin declares to the bus. Absent or `[]` is every action ("Default:
 *   all", 1.25 and 1.26). The bus reads it, alone.
 * - An ActionList is the required first list of debounce, throttle and
 *   optimisticUndo: it names what the plugin is FOR, so `[]` is none, as in
 *   1.25 (a Set). Since 35.141 the bus filtered by the declared list and read
 *   `[]` as every action, so `debounce([], 50)` answered `{ pending: true }`
 *   for every dispatch: the bug. An empty list now gets a plugin that only
 *   hands on (`forList`, plugins-core.ts).
 *
 * createMcpHandler's `actions` was a third meaning, an allowlist where `[]`
 * exposed none: s35.180 removed it, and `actionFilter` is its one selection
 * (tests/mcp-allowlist.test.ts).
 *
 * Log s35.146 first made `[]` none everywhere; that removed the filters'
 * behaviour instead of fixing the three plugins, and s35.148 restores it
 * (owner: stop killing features). The guard test fails if a plugin reads its
 * own scope again; seeded with a failure when it was written (s35.146).
 */
