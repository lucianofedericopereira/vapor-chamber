/**
 * Tests for the `serialize` plugin — per-key sequential processing of async
 * commands. Closes the one genuine core-feature gap: ordered serialization of
 * distinct same-key commands (as opposed to the in-flight dedup the bus already
 * has, which collapses *identical* requests).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { serialize } from '../src/plugins-extra';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * N-party barrier — `arrive()` returns a promise that resolves only once N
 * callers have arrived. Makes concurrency/race tests DETERMINISTIC instead of
 * relying on timer windows: if commands that should run concurrently are instead
 * serialized, the barrier never reaches N and the test deadlocks (fails by
 * timeout) rather than flaking.
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

// A read-modify-write handler with a yield in the middle — the classic race,
// guarded by serialize keyed on target.id. (The without-serialize control lives
// in its own test below, using a deterministic barrier instead of a timer.)
function makeDepositBus() {
  const bus = createAsyncCommandBus();
  const accounts: Record<string, number> = { a: 0, b: 0 };
  bus.use(serialize({ key: (cmd) => (cmd.target as any).id }));
  bus.register('deposit', async (cmd) => {
    const { id, amount } = cmd.target as { id: string; amount: number };
    const cur = accounts[id];   // READ
    await tick(5);              // yield — a concurrent dispatch would read the same `cur`
    accounts[id] = cur + amount; // WRITE
    return accounts[id];
  });
  return { bus, accounts };
}

describe('serialize plugin', () => {
  it('serializes same-key commands — no lost updates', async () => {
    const { bus, accounts } = makeDepositBus();
    await Promise.all([
      bus.dispatch('deposit', { id: 'a', amount: 1 }),
      bus.dispatch('deposit', { id: 'a', amount: 1 }),
      bus.dispatch('deposit', { id: 'a', amount: 1 }),
    ]);
    expect(accounts.a).toBe(3); // applied strictly in order
  });

  it('CONTROL: without serialize the same race loses updates', async () => {
    const bus = createAsyncCommandBus();
    const accounts: Record<string, number> = { a: 0 };
    // Barrier: all three READ, then wait until all three have read before any
    // WRITE — deterministically forces the lost-update race (no timer reliance).
    const arrive = barrier(3);
    bus.register('deposit', async (cmd) => {
      const { id, amount } = cmd.target as { id: string; amount: number };
      const cur = accounts[id];   // READ (all see 0)
      await arrive();             // hold until all three have read
      accounts[id] = cur + amount; // WRITE (all write 0+1)
      return accounts[id];
    });
    await Promise.all([
      bus.dispatch('deposit', { id: 'a', amount: 1 }),
      bus.dispatch('deposit', { id: 'a', amount: 1 }),
      bus.dispatch('deposit', { id: 'a', amount: 1 }),
    ]);
    expect(accounts.a).toBe(1); // lost updates — proves the gap is real
  });

  it('different keys run concurrently (no false serialization)', async () => {
    const bus = createAsyncCommandBus();
    const done: string[] = [];
    bus.use(serialize({ key: (cmd) => (cmd.target as any).id }));
    // Both must arrive before either finishes. If different keys were wrongly
    // serialized, the second never starts and this deadlocks (fails) — so a pass
    // deterministically proves concurrency.
    const arrive = barrier(2);
    bus.register('work', async (cmd) => {
      const id = (cmd.target as any).id;
      await arrive();
      done.push(id);
      return id;
    });
    await Promise.all([
      bus.dispatch('work', { id: 'x' }),
      bus.dispatch('work', { id: 'y' }),
    ]);
    expect(done.sort()).toEqual(['x', 'y']);
  });

  it('a failed command does not stall its lane', async () => {
    const bus = createAsyncCommandBus();
    const completed: number[] = [];
    bus.use(serialize({ key: () => 'shared' }));
    let n = 0;
    bus.register('step', async () => {
      const me = ++n;
      await tick(2);
      if (me === 1) throw new Error('boom'); // first fails
      completed.push(me);
      return me;
    });
    await Promise.allSettled([
      bus.dispatch('step', {}),
      bus.dispatch('step', {}),
      bus.dispatch('step', {}),
    ]);
    // the lane drained past the failure — later commands still ran, in order
    expect(completed).toEqual([2, 3]);
  });

  it('key() returning null skips serialization for that command', async () => {
    const bus = createAsyncCommandBus();
    const done: string[] = [];
    bus.use(serialize({ key: () => null })); // null ⇒ never serialized
    const arrive = barrier(2);
    bus.register('work', async (cmd) => {
      await arrive(); // both run concurrently or this deadlocks
      done.push(cmd.target as string);
      return cmd.target;
    });
    await Promise.all([bus.dispatch('work', 'a'), bus.dispatch('work', 'b')]);
    expect(done.sort()).toEqual(['a', 'b']);
  });

  it('actions filter scopes serialization to matching actions only', async () => {
    const bus = createAsyncCommandBus();
    const done: string[] = [];
    // only 'locked*' is serialized; 'free' is not → 'free' dispatches run concurrently
    bus.use(serialize({ key: () => 'shared', actions: ['locked*'] }));
    const arrive = barrier(2);
    bus.register('free', async (cmd) => {
      await arrive(); // both run concurrently or this deadlocks
      done.push(cmd.target as string);
      return cmd.target;
    });
    await Promise.all([bus.dispatch('free', 'a'), bus.dispatch('free', 'b')]);
    expect(done.sort()).toEqual(['a', 'b']);
  });

  it('default key serializes each action against itself', async () => {
    const bus = createAsyncCommandBus();
    const order: string[] = [];
    bus.use(serialize()); // no key → defaults to cmd.action
    bus.register('save', async (cmd) => {
      order.push(`start:${cmd.target}`);
      await tick(8);
      order.push(`end:${cmd.target}`);
      return cmd.target;
    });
    await Promise.all([bus.dispatch('save', 1), bus.dispatch('save', 2)]);
    // same action → serialized: first fully completes before second starts
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  describe('scope: cross-tab (Web Locks)', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('serializes through navigator.locks with the right lock names', async () => {
      const calls = stubWebLocks();
      const bus = createAsyncCommandBus();
      const accounts: Record<string, number> = { a: 0 };
      bus.use(serialize({ scope: 'cross-tab', key: (cmd) => (cmd.target as any).id }));
      bus.register('deposit', async (cmd) => {
        const id = (cmd.target as any).id;
        const cur = accounts[id];
        await tick(5);
        accounts[id] = cur + (cmd.target as any).amount;
        return accounts[id];
      });
      await Promise.all([
        bus.dispatch('deposit', { id: 'a', amount: 1 }),
        bus.dispatch('deposit', { id: 'a', amount: 1 }),
      ]);
      expect(accounts.a).toBe(2); // serialized via the lock
      expect(calls).toEqual(['vapor-chamber:serialize:a', 'vapor-chamber:serialize:a']);
    });

    it('respects a custom lockPrefix', async () => {
      const calls = stubWebLocks();
      const bus = createAsyncCommandBus();
      bus.use(serialize({ scope: 'cross-tab', key: () => 'x', lockPrefix: 'myapp:lock' }));
      bus.register('go', async () => 1);
      await bus.dispatch('go', {});
      expect(calls).toEqual(['myapp:lock:x']);
    });

    it('falls back to the in-memory lane when Web Locks is unavailable', async () => {
      vi.stubGlobal('navigator', {}); // no .locks
      const bus = createAsyncCommandBus();
      const accounts: Record<string, number> = { a: 0 };
      bus.use(serialize({ scope: 'cross-tab', key: (cmd) => (cmd.target as any).id }));
      bus.register('deposit', async (cmd) => {
        const id = (cmd.target as any).id;
        const cur = accounts[id];
        await tick(5);
        accounts[id] = cur + (cmd.target as any).amount;
        return accounts[id];
      });
      await Promise.all([
        bus.dispatch('deposit', { id: 'a', amount: 1 }),
        bus.dispatch('deposit', { id: 'a', amount: 1 }),
        bus.dispatch('deposit', { id: 'a', amount: 1 }),
      ]);
      expect(accounts.a).toBe(3); // still serialized via fallback
    });
  });
});
