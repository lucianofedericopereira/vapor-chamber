/**
 * syncQuery builds its command before the depth guard's try: naming throw, depth bound and answer shape.
 * Why: a naming violation would leave the depth counter changed, or the depth bound would stop a query loop, or a bare or stepped query would answer in another shape.
 * Shows: a naming throw reaches the caller and the bus answers query and dispatch after; a self-querying handler stops at the depth bound and the bus answers after; a bare and a stepped query return {ok, value, error} and the step sees a meta id.
 * See: log s36.F50, log s35.204, docs/V8-RULES.md, scripts/ab/workloads/query-bare.mjs
 */
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';

describe('sync query, its command built before the depth guard', () => {
  it('a naming throw escapes the query and leaves the depth as it was', () => {
    const bus = createCommandBus({ naming: { pattern: /^[a-z]+$/, onViolation: 'throw' } });
    bus.register('ok', (cmd) => cmd.target);
    expect(() => bus.query('Bad_Name', 1)).toThrow();
    expect(bus.query('ok', 2)).toEqual({ ok: true, value: 2, error: undefined });
    expect(bus.dispatch('ok', 3)).toEqual({ ok: true, value: 3, error: undefined });
  });

  it('a query that queries itself stops at the depth bound, and the bus answers after', () => {
    const bus = createCommandBus();
    let depth = 0;
    bus.register('deep', () => {
      depth++;
      const r = bus.query('deep', 0);
      return r.ok ? r.value : (r.error as { code?: string }).code;
    });
    const r = bus.query('deep', 0);
    expect(r.ok).toBe(true);
    expect(depth).toBeGreaterThan(1);
    bus.register('ok', (cmd) => cmd.target);
    expect(bus.query('ok', 5).value).toBe(5);
  });

  it('a bare query and a query with a step answer as before', () => {
    const bare = createCommandBus();
    bare.register('get', (cmd) => ({ id: cmd.target }));
    expect(bare.query('get', 7)).toEqual({ ok: true, value: { id: 7 }, error: undefined });
    const stepped = createCommandBus();
    stepped.register('get', (cmd) => ({ id: cmd.target }));
    stepped.use({ begin: () => undefined });
    let seen: unknown;
    stepped.onAfter((cmd) => { seen = cmd.meta?.id; });
    expect(stepped.query('get', 8)).toEqual({ ok: true, value: { id: 8 }, error: undefined });
    expect(typeof seen).toBe('string');
  });
});
