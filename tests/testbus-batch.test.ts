/**
 * createTestBus().dispatchBatch and the real bus's dispatchBatch, run against the same handlers.
 * Why: a test double that ignores `transactional` or `continueOnError` would leave a batch applied in tests that the real bus rolls back.
 * Shows: on both buses a transactional batch rolls back what ran, continueOnError runs every command, and with no option the batch stops at the first failure.
 * See: log s35.176
 */
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
