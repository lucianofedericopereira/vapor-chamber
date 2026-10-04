/** The invariants three removed `v8 ignore` guards stood on, pinned (log s35.122). */
import { describe, expect, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { it } from '../src/vitest';

describe('a transactional batch stops at its first failure, so a rollback sees only successes', () => {
  it('sync, even with continueOnError (transactional wins)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    const undone: number[] = [];
    bus.register('ok', (cmd) => cmd.target, { undo: (cmd) => { undone.push(cmd.target); } });
    bus.register('bad', () => { throw new Error('down'); });
    const r = bus.dispatchBatch([{ action: 'ok', target: 1 }, { action: 'bad', target: 2 }, { action: 'ok', target: 3 }], { transactional: true, continueOnError: true });
    expect(r.results).toHaveLength(2);
    expect(undone).toEqual([1]);
    expect(r.rollbacks?.every((x) => x.ok)).toBe(true);
  });

  it('async, and an abort mid-batch rolls back only what ran', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const undone: number[] = [];
    const ac = new AbortController();
    bus.register('ok', async (cmd) => { if (cmd.target === 2) ac.abort(); return cmd.target; }, { undo: (cmd) => { undone.push(cmd.target); } });
    const r = await bus.dispatchBatch([{ action: 'ok', target: 1 }, { action: 'ok', target: 2 }, { action: 'ok', target: 3 }], { transactional: true, signal: ac.signal });
    expect(r.ok).toBe(false);
    expect(undone).toEqual([2, 1]);
  });
});

describe('the deferred buffer is flushed only once it holds something', () => {
  it('register() on a bus without buffering never reaches the flush', () => {
    const bus = createCommandBus();
    expect(() => bus.register('a', () => 1)).not.toThrow();
  });

  it('a buffered command replays when its handler arrives', () => {
    const bus = createCommandBus({ onMissing: 'buffer' });
    bus.dispatch('late', 1);
    const seen: number[] = [];
    bus.register('late', (cmd) => { seen.push(cmd.target); return 1; });
    expect(seen).toEqual([1]);
  });
});
