// syncQuery builds its command before the depth's try: what the move keeps. The long note is at the end.
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

// Why: phase 2 C7 moves the command literal and its stampMeta call out of the
// depth's try/finally, the shape V8-RULES rule 2 measured on dispatch (log
// s35.204): built inside the try, the call's exception edge sees the literal half
// built and escape analysis keeps a meta nothing reads. The gain is the optimizer's
// and no turn count shows it, so these pin what the move must keep: a naming throw
// still reaches the caller with the depth counter untouched, the depth bound still
// stops a query loop, and both query paths answer as before. The speed is the A/B's
// (scripts/ab/workloads/query-bare.mjs).
