/** An ActionScope filter: absent or [] is every action, read by the bus alone (log s35.148). */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { cache, metrics, rateLimit } from '../src/plugins-extra';

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

  it('a plugin declares the scope it was given', () => {
    expect(metrics({ actions: [] }).actions).toEqual([]);
    expect(metrics().actions).toBeUndefined();
    expect(metrics({ actions: ['cart*'] }).actions).toEqual(['cart*']);
  });

  it('a plain-JS plugin declaring actions: null runs on every action, as released', () => {
    const seen: string[] = [];
    const bus = createCommandBus();
    bus.register('save', () => 1);
    bus.use({ actions: null, started: (cmd: { action: string }) => { seen.push(cmd.action); } } as never);
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
 * An ActionScope is a plugin's action FILTER: the `actions` option of
 *   cache, circuitBreaker, rateLimit, metrics, idempotent,
 *   supersede and the outbox, and the `actions`
 *   a plugin declares to the bus. Absent or `[]` is every action ("Default:
 *   all", 1.25 and 1.26). The bus reads it, alone. The required lists of the
 * debounce and throttle plugins (an ActionList, where `[]` was none) left with
 * the plugins: pacing is the sender's (`pace`, step 6a).
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
