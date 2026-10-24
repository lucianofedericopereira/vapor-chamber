/**
 * vapor-chamber - the buffer: a command dispatched before its handler exists
 * waits, and runs when the handler registers.
 *
 * Built for lazy wiring: an island or a code-split panel whose handler
 * registers after the first click. A bus option, `createCommandBus({ buffer:
 * createBuffer() })`, either bus. A held dispatch answers `{ ok: true, value }`
 * with `value` an `Accepted`, as a held outbox command does; its `done` settles
 * with the handler's result once the command runs, through the full chain.
 * Only an action with no handler, no responder and no transport is held, and
 * a query never is. tests/buffer-on-bus.test.ts.
 */
import { Accepted } from './accepted';
import { _report } from './report';
import { countOption } from './bounds';
import type { BaseBus, BusBuffer, Command, CommandResult } from './command-bus';
import { _BUFFER, _errResult, _failures, _okResult } from './command-bus';
import { DEV } from './dev';
import { isThenable } from './settled';
import { signal, type Signal } from './signal';
import { _stateHalf, type StateHalf } from './store-base';
import { _plainRuntime } from './store/core';

export type BufferOptions = {
  /**
   * Max commands held per action. Past it the oldest is dropped: its `done`
   * settles with `buffer:exceeded:queue`. Default: 256, also for NaN.
   * `Infinity` means no bound, 0 holds nothing.
   */
  maxSize?: number;
  /**
   * Max age (ms) a command may wait for its handler. An older one is dropped
   * (`buffer:timeout:queue`), checked on the next hold of that action and when
   * its handler registers, so a handler that never arrives cannot pin stale
   * commands. Default: no limit.
   */
  ttl?: number;
  /** Called for each command dropped by `maxSize` or `ttl`: one place to observe drops. */
  onDrop?: (action: string, dropped: { target: any; payload: any }) => void;
};

/** The object `createBuffer` returns. Pass it to a bus as its `buffer` option. */
export type CommandBuffer = {
  /** How many commands wait for their handler, all actions together. */
  pending: Signal<number>;
  /** @internal The bus's half: the bus calls it, an app does not. */
  readonly [_BUFFER]: BusBuffer;
};

/** One held command and its caller's settle. */
type Held = { target: any; payload: any; at: number; settle: (r: CommandResult) => void };

/** The buffer's state: the held commands by action, and how many in all. */
type Queue = { queues: Map<string, Held[]>; count: number };

const fail = _failures('buffer');

/**
 * createBuffer - hold a command dispatched before its handler, and run it,
 * in order, when the handler registers.
 *
 * @example
 * const bus = createCommandBus({ buffer: createBuffer({ ttl: 30_000 }) });
 * const r = bus.dispatch('cartAdd', item);      // before the island hydrates
 * if (r.value instanceof Accepted) await r.value.done; // the handler's result
 */
export function createBuffer(options: BufferOptions = {}): CommandBuffer {
  const { onDrop } = options;
  // Read once (../bounds): NaN takes the default, Infinity means no bound.
  const limit = countOption(options.maxSize, 256);
  const ttl = options.ttl !== undefined && options.ttl > 0 ? options.ttl : 0;
  const pending = signal(0);
  // The queue is state (plan 1.32 3, the store owns the buffer queue): a
  // state half of its own, no persist or share (a held command carries its
  // caller's settle), no registration, nothing on the bus. Built once.
  const half: StateHalf<Queue> = _stateHalf<Queue>(_plainRuntime, { id: 'buffer', state: () => ({ queues: new Map(), count: 0 }) }, null);
  const state = half.cell.value;
  const queues = state.queues;
  let bus: BaseBus | null = null;

  /** A dropped command: its caller hears why, `onDrop` hears it. */
  const drop = (action: string, held: Held, result: CommandResult): void => {
    state.count--;
    onDrop?.(action, { target: held.target, payload: held.payload });
    held.settle(result);
  };
  const expired = (action: string, held: Held): void =>
    drop(action, held, _errResult(fail('timeout:queue', `"${action}" waited more than ${ttl} ms for its handler.`, { action, context: { ttl } })));

  const hold = (cmd: Command): CommandResult => {
    const action = cmd.action;
    let q = queues.get(action);
    if (q === undefined) { q = []; queues.set(action, q); }
    const now = Date.now();
    // FIFO, so expired entries cluster at the front.
    if (ttl !== 0) while (q.length > 0 && now - q[0].at > ttl) expired(action, q.shift() as Held);
    let settle!: (r: CommandResult) => void;
    const done = new Promise<CommandResult>((resolve) => { settle = resolve; });
    // The push before the eviction: one push puts the queue at most one over,
    // so a bound of 0 holds nothing and never shifts an empty queue.
    q.push({ target: cmd.target, payload: cmd.payload, at: now, settle });
    state.count++;
    if (q.length > limit) {
      drop(action, q.shift() as Held, _errResult(fail('exceeded:queue', `More than ${limit} "${action}" commands waited for their handler: the oldest was dropped.`, { action, context: { maxSize: limit } })));
      if (DEV) _report('warn', 'buffer:exceeded:queue', `more than ${limit} "${cmd.action}" commands waited for their handler; dropped the oldest. Register its handler, or raise maxSize.`);
    }
    pending.value = state.count;
    return _okResult(new Accepted(() => done));
  };

  // The handler registered: each held command runs through the bus, in order.
  const release = (action: string): void => {
    const q = queues.get(action);
    if (q === undefined) return;
    queues.delete(action);
    const now = ttl !== 0 ? Date.now() : 0;
    for (let i = 0; i < q.length; i++) {
      const held = q[i];
      if (ttl !== 0 && now - held.at > ttl) { expired(action, held); continue; }
      state.count--;
      const r = (bus as BaseBus).dispatch(action, held.target, held.payload);
      if (isThenable(r)) void (r as Promise<CommandResult>).then(held.settle);
      else held.settle(r as CommandResult);
    }
    pending.value = state.count;
  };

  // The bus's clear(): every waiting caller hears it, nothing runs.
  const clear = (): void => {
    for (const [action, q] of queues) {
      for (let i = 0; i < q.length; i++) q[i].settle(_errResult(fail('aborted:clear', `The bus was cleared before "${action}" had a handler.`, { action })));
    }
    queues.clear();
    state.count = 0;
    pending.value = 0;
  };

  return { pending, [_BUFFER]: { hold, release, clear, attach: (b) => { bus = b; } } };
}
