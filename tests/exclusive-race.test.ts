/** `register({ exclusive })` against the read-modify-write race, keys, failures and Web Locks. The long note is at the end. */
import { describe, expect, vi } from 'vitest';
import { type Command, createAsyncCommandBus } from '../src/command-bus';
import { it } from '../src/vitest';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * N-party barrier - `arrive()` returns a promise that resolves only once N
 * callers have arrived. Makes concurrency/race tests DETERMINISTIC instead of
 * relying on timer windows: if commands that should run concurrently are instead
 * held in order, the barrier never reaches N and the test fails by timeout
 * rather than flaking.
 */
function barrier(n: number) {
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return () => { if (++count === n) release(); return gate; };
}

/** Mock navigator.locks with the real FIFO-per-name semantics the Web Locks API guarantees. */
function stubWebLocks() {
  const calls: string[] = [];
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', {
    locks: {
      request(name: string, cb: () => any) {
        calls.push(name);
        const prev = queues.get(name) ?? Promise.resolve();
        const run = prev.then(() => cb(), () => cb()); // FIFO per name, release on settle
        queues.set(name, run.then(() => {}, () => {}));
        return run;
      },
    },
  });
  return calls;
}

/** A read-modify-write handler with a yield in the middle: the classic race. */
function deposit(accounts: Record<string, number>, wait: () => Promise<unknown> = () => tick(5)) {
  return async (cmd: Command) => {
    const { id, amount } = cmd.target as { id: string; amount: number };
    const cur = accounts[id] as number; // READ
    await wait();                        // a concurrent dispatch would read the same `cur`
    accounts[id] = cur + amount;         // WRITE
    return accounts[id];
  };
}
const byId = (cmd: Command) => (cmd.target as { id: string }).id;

describe('exclusive against the race', () => {
  it('same-key commands: no lost updates', async () => {
    const bus = createAsyncCommandBus();
    const accounts: Record<string, number> = { a: 0 };
    bus.register('deposit', deposit(accounts), { exclusive: { key: byId } });
    await Promise.all([1, 2, 3].map(() => bus.dispatch('deposit', { id: 'a', amount: 1 })));
    expect(accounts.a).toBe(3);
  });

  it('CONTROL: without exclusive the same race loses updates', async ({ asyncBus: bus }) => {
    const accounts: Record<string, number> = { a: 0 };
    // All three READ, then wait until all three have read before any WRITE.
    const arrive = barrier(3);
    bus.register('deposit', deposit(accounts, arrive));
    await Promise.all([1, 2, 3].map(() => bus.dispatch('deposit', { id: 'a', amount: 1 })));
    expect(accounts.a).toBe(1);
  });

  it('different keys run concurrently', async ({ asyncBus: bus }) => {
    const done: string[] = [];
    const arrive = barrier(2);
    bus.register('work', async (cmd: Command) => { await arrive(); done.push(byId(cmd)); return 1; }, { exclusive: { key: byId } });
    await Promise.all([bus.dispatch('work', { id: 'x' }), bus.dispatch('work', { id: 'y' })]);
    expect(done.sort()).toEqual(['x', 'y']);
  });

  it('a failed command does not stall its key', async ({ asyncBus: bus }) => {
    const completed: number[] = [];
    let n = 0;
    bus.register('step', async () => {
      const me = ++n;
      await tick(2);
      if (me === 1) throw new Error('boom');
      completed.push(me);
      return me;
    }, { exclusive: { key: () => 'shared' } });
    await Promise.allSettled([1, 2, 3].map(() => bus.dispatch('step', {})));
    expect(completed).toEqual([2, 3]);
  });

  it('a key of null runs the command at once', async ({ asyncBus: bus }) => {
    const done: string[] = [];
    const arrive = barrier(2);
    bus.register('work', async (cmd: Command) => { await arrive(); done.push(cmd.target as string); return 1; }, { exclusive: { key: () => null } });
    await Promise.all([bus.dispatch('work', 'a'), bus.dispatch('work', 'b')]);
    expect(done.sort()).toEqual(['a', 'b']);
  });

  it('an action registered without it runs at once beside one that has it', async ({ asyncBus: bus }) => {
    const done: string[] = [];
    bus.register('locked', async () => 1, { exclusive: { key: () => 'shared' } });
    const arrive = barrier(2);
    bus.register('free', async (cmd: Command) => { await arrive(); done.push(cmd.target as string); return 1; });
    await Promise.all([bus.dispatch('free', 'a'), bus.dispatch('free', 'b')]);
    expect(done.sort()).toEqual(['a', 'b']);
  });

  it('the default key is the action: each action against itself', async ({ asyncBus: bus }) => {
    const order: string[] = [];
    bus.register('save', async (cmd: Command) => {
      order.push(`start:${cmd.target}`);
      await tick(8);
      order.push(`end:${cmd.target}`);
      return cmd.target;
    }, { exclusive: {} });
    await Promise.all([bus.dispatch('save', 1), bus.dispatch('save', 2)]);
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  describe("scope: 'cross-tab' (Web Locks)", () => {
    it('holds the key through navigator.locks, with its lock names', async () => {
      const calls = stubWebLocks();
      const bus = createAsyncCommandBus();
      const accounts: Record<string, number> = { a: 0 };
      bus.register('deposit', deposit(accounts), { exclusive: { scope: 'cross-tab', key: byId } });
      await Promise.all([1, 2].map(() => bus.dispatch('deposit', { id: 'a', amount: 1 })));
      expect(accounts.a).toBe(2);
      expect(calls).toEqual(['vapor-chamber:exclusive:a', 'vapor-chamber:exclusive:a']);
    });

    it('a custom lockPrefix', async () => {
      const calls = stubWebLocks();
      const bus = createAsyncCommandBus();
      bus.register('go', async () => 1, { exclusive: { scope: 'cross-tab', key: () => 'x', lockPrefix: 'myapp:lock' } });
      await bus.dispatch('go', {});
      expect(calls).toEqual(['myapp:lock:x']);
    });

    it('without Web Locks, this bus holds the key', async () => {
      vi.stubGlobal('navigator', {});
      const bus = createAsyncCommandBus();
      const accounts: Record<string, number> = { a: 0 };
      bus.register('deposit', deposit(accounts), { exclusive: { scope: 'cross-tab', key: byId } });
      await Promise.all([1, 2, 3].map(() => bus.dispatch('deposit', { id: 'a', amount: 1 })));
      expect(accounts.a).toBe(3);
    });
  });
});

/*
 * The cases of tests/serialize.test.ts, moved to the plugin's home in step 4k (log 36.81):
 * `serialize` is gone and the action declares `exclusive`. The race, the control that proves
 * it real, concurrency for different keys and for `null`, no stall after a failure, the
 * default key, and Web Locks with its names, its prefix and its fallback. The `actions`
 * filter has no counterpart: an action without the option is simply not held. The lock name
 * is `vapor-chamber:exclusive:<key>` (was `vapor-chamber:serialize:<key>`).
 */
