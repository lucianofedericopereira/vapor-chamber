// A transactional batch undoes the command that ran, not a copy (plan item 2).
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type Command } from '../src/command-bus';
import { defineChamberStore } from '../src/store';

type Inv = { n: number };
const useInv = defineChamberStore('inv', { state: (): Inv => ({ n: 0 }), reducers: { inc: (s: Inv) => ({ n: s.n + 1 }) }, undo: true });
const batch = [{ action: 'invInc', target: null }, { action: 'fail', target: null }];

describe('a transactional batch rolls back the command that ran', () => {
  it('sync: an undo: true store returns to its state before the batch', () => {
    const bus = createCommandBus();
    const inv = useInv(bus);
    bus.register('fail', () => { throw new Error('boom'); });
    const r = bus.dispatchBatch(batch, { transactional: true });
    expect(r.ok).toBe(false);
    expect(inv.state.value).toEqual({ n: 0 });
  });

  it('async: an undo: true store returns to its state before the batch', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const inv = useInv(bus);
    bus.register('fail', async () => { throw new Error('boom'); });
    const r = await bus.dispatchBatch(batch, { transactional: true });
    expect(r.ok).toBe(false);
    expect(inv.state.value).toEqual({ n: 0 });
  });

  it('the $undo command names the command that ran as its cause, and receives that command', async () => {
    for (const make of [() => createCommandBus(), () => createAsyncCommandBus({ retry: false })]) {
      const bus = make() as ReturnType<typeof createCommandBus>; // both buses take these calls; the await covers the async one
      let ran: Command | undefined;
      let undone: Command | undefined;
      let causation: string | undefined;
      bus.register('inc', (cmd) => { ran = cmd; }, { undo: (cmd) => { undone = cmd; } });
      bus.register('fail', () => { throw new Error('boom'); });
      bus.on('inc$undo', (cmd) => { causation = cmd.meta?.causationId; });
      await bus.dispatchBatch([{ action: 'inc', target: null }, { action: 'fail', target: null }], { transactional: true });
      expect(undone).toBe(ran);
      expect(causation).toBe(ran!.meta!.id);
    }
  });

  it('a batch dispatch keeps the depth bound and the naming rule, sync and async', async () => {
    for (const make of [() => createCommandBus({ naming: { pattern: /^[a-z]/, onViolation: 'throw' } }), () => createAsyncCommandBus({ retry: false, naming: { pattern: /^[a-z]/, onViolation: 'throw' } })]) {
      const bus = make() as ReturnType<typeof createCommandBus>; // both buses take these calls; the await covers the async one
      const codes: string[] = [];
      const note = (r: { ok: boolean; error?: unknown }) => { if (!r.ok) codes.push((r.error as { code: string }).code); return r; };
      bus.register('loop', () => {
        const r = bus.dispatchBatch([{ action: 'loop', target: null }]);
        return r instanceof Promise ? r.then(note) : note(r);
      });
      await bus.dispatchBatch([{ action: 'loop', target: null }]);
      expect(codes[0]).toBe('core:exceeded:depth');
      await expect(Promise.resolve().then(() => bus.dispatchBatch([{ action: 'Bad', target: null }]))).rejects.toMatchObject({ code: 'core:invalid:name' });
    }
  });

  it('control: a register({ undo }) handler still rolls back, and an untouched batch stays ok', () => {
    const bus = createCommandBus();
    let v = 0;
    bus.register('inc', () => { v++; }, { undo: () => { v--; } });
    bus.register('fail', () => { throw new Error('boom'); });
    bus.dispatchBatch([{ action: 'inc', target: null }, { action: 'fail', target: null }], { transactional: true });
    expect(v).toBe(0);
    const ok = bus.dispatchBatch([{ action: 'inc', target: null }], { transactional: true });
    expect(ok.ok).toBe(true);
    expect(v).toBe(1);
  });
});
