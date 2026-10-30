/**
 * An ActionScope filter: absent, `[]` or `null` is every action, and the bus alone reads it.
 * Why: if `[]` meant no action, a plugin given an empty list would silently do nothing, and if a plugin read its own scope the filters could disagree.
 * Shows: cache and rateLimit with `actions: []` act on every action; metrics declares the scope it was given; a plain-JS plugin declaring `actions: null` runs on every action; among src files only command-bus.ts reads a plugin's `actions`.
 * See: log s35.148, s35.146
 */
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
    // command-bus.ts reads it in `_scoped`; it also matches a doc example of inspectBus().actions, the registered names.
    expect(readers.sort()).toEqual(['command-bus.ts']);
  });
});
