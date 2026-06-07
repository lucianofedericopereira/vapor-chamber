/**
 * Adversarial hardening for createWorkflow (saga/compensation). The happy
 * compensation path is covered in utilities.test.ts; these cover the intricate
 * failure modes: a compensation step that ITSELF fails, failure on the first
 * step (nothing to compensate), reverse-order compensation across multiple
 * steps, and the async-bus path.
 */
import { describe, it, expect } from 'vitest';
import { createCommandBus, createAsyncCommandBus } from '../src/command-bus';
import { createWorkflow } from '../src/utilities';

describe('createWorkflow — adversarial compensation', () => {
  it('a compensation step that itself fails does not throw and is recorded', async () => {
    const bus = createCommandBus();
    const order: string[] = [];
    bus.register('reserve', () => { order.push('reserve'); });
    bus.register('charge', () => { order.push('charge'); });
    bus.register('orderCreate', () => { throw new Error('orderCreate failed'); });
    // compensations: releaseCharge throws, releaseReserve succeeds
    bus.register('releaseCharge', () => { order.push('releaseCharge'); throw new Error('release failed'); });
    bus.register('releaseReserve', () => { order.push('releaseReserve'); });

    const wf = createWorkflow([
      { action: 'reserve', compensate: 'releaseReserve' },
      { action: 'charge', compensate: 'releaseCharge' },
      { action: 'orderCreate' }, // fails → compensate charge then reserve, in reverse
    ]);

    const result = await wf.run(bus, { id: 1 });

    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(2);
    // both compensations attempted in REVERSE order, even though the first threw
    expect(order).toEqual(['reserve', 'charge', 'releaseCharge', 'releaseReserve']);
    expect(result.compensations).toHaveLength(2);
    expect(result.compensations![0].ok).toBe(false); // releaseCharge failed — captured, not thrown
    expect(result.compensations![1].ok).toBe(true);  // releaseReserve still ran
  });

  it('failure on the FIRST step compensates nothing', async () => {
    const bus = createCommandBus();
    bus.register('step1', () => { throw new Error('boom'); });
    const wf = createWorkflow([
      { action: 'step1', compensate: 'undo1' },
      { action: 'step2', compensate: 'undo2' },
    ]);
    const result = await wf.run(bus, {});
    expect(result.ok).toBe(false);
    expect(result.failedAt).toBe(0);
    expect(result.compensations).toEqual([]); // nothing succeeded before it → nothing to undo
  });

  it('only steps with a compensate AND that succeeded are compensated', async () => {
    const bus = createCommandBus();
    const undone: string[] = [];
    bus.register('a', () => {});            // no compensate
    bus.register('b', () => {});            // has compensate
    bus.register('c', () => { throw new Error('fail'); });
    bus.register('undoB', () => { undone.push('undoB'); });

    const wf = createWorkflow([
      { action: 'a' },                       // no compensate → not undone
      { action: 'b', compensate: 'undoB' },  // undone
      { action: 'c', compensate: 'undoC' },  // failed step → its own compensate never registered to run
    ]);
    const result = await wf.run(bus, {});
    expect(result.ok).toBe(false);
    expect(undone).toEqual(['undoB']);       // only b's compensation
    expect(result.compensations).toHaveLength(1);
  });

  it('async bus: failed step compensates previously-succeeded async steps in reverse', async () => {
    const bus = createAsyncCommandBus();
    const order: string[] = [];
    bus.register('reserve', async () => { order.push('reserve'); });
    bus.register('charge', async () => { order.push('charge'); });
    bus.register('finalize', async () => { throw new Error('finalize failed'); });
    bus.register('releaseReserve', async () => { order.push('releaseReserve'); });
    bus.register('releaseCharge', async () => { order.push('releaseCharge'); });

    const wf = createWorkflow([
      { action: 'reserve', compensate: 'releaseReserve' },
      { action: 'charge', compensate: 'releaseCharge' },
      { action: 'finalize' },
    ]);
    const result = await wf.run(bus, {});
    expect(result.ok).toBe(false);
    expect(order).toEqual(['reserve', 'charge', 'releaseCharge', 'releaseReserve']);
    expect(result.compensations?.every((c) => c.ok)).toBe(true);
  });

  it('all steps succeed → ok, no compensations', async () => {
    const bus = createCommandBus();
    bus.register('a', () => 1);
    bus.register('b', () => 2);
    const wf = createWorkflow([{ action: 'a' }, { action: 'b', compensate: 'undoB' }]);
    const result = await wf.run(bus, {});
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.compensations).toBeUndefined();
  });
});
