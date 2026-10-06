/** createTestBus().dispatchBatch runs the real bus's batch rule: transactional rolls back, continueOnError continues (plan 1.27 section 10.13, T2). Rationale at the end. */
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../src/command-bus';
import { createTestBus } from '../src/testing';

/** Both buses wired alike: `inc` with an undo, `fail` throwing. */
const makers = [['TestBus', () => createTestBus({ passthroughHandlers: true })], ['real bus', () => createCommandBus()]] as const;
function wired(make: () => ReturnType<typeof createCommandBus>) {
  const bus = make();
  let v = 0;
  bus.register('inc', () => { v++; return v; }, { undo: () => { v--; } });
  bus.register('fail', () => { throw new Error('x'); });
  return { bus, value: () => v };
}

describe('dispatchBatch, on the double and the bus alike', () => {
  for (const [name, make] of makers) {
    it(`${name}: transactional rolls back what ran`, () => {
      const { bus, value } = wired(make as never);
      const r = bus.dispatchBatch([{ action: 'inc', target: null }, { action: 'fail', target: null }], { transactional: true });
      expect([value(), r.ok, r.rollbacks?.length, r.successCount]).toEqual([0, false, 1, 1]);
    });

    it(`${name}: continueOnError runs every command`, () => {
      const { bus, value } = wired(make as never);
      const r = bus.dispatchBatch([{ action: 'fail', target: null }, { action: 'inc', target: null }], { continueOnError: true });
      expect([value(), r.ok, r.results.length, r.successCount, r.failCount]).toEqual([1, false, 2, 1, 1]);
    });

    it(`${name}: no option stops at the first failure`, () => {
      const { bus, value } = wired(make as never);
      const r = bus.dispatchBatch([{ action: 'fail', target: null }, { action: 'inc', target: null }]);
      expect([value(), r.results.length]).toEqual([0, 1]);
    });
  }
});

/*
 * testing.ts's own rule: a test double must not diverge from the bus it
 * doubles. Its dispatchBatch ignored `transactional` and `continueOnError`:
 * a transactional batch whose second command failed left the first applied
 * on the TestBus (`[1, null]`) and rolled back on the real bus (`[0, 1]`)
 * (audit T2, probe L3). Both now call the one batch rule, `_syncBatch` in
 * command-bus.ts, so there is no copy to drift. Log s35.176.
 */
