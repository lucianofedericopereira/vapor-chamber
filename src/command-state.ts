/**
 * vapor-chamber - the command state: what is in flight on a bus, and what failed.
 *
 * Framework-neutral. It is the bus's one internal observer (`Facts`: each
 * command's start and settle), never a user hook or listener, so a sealed bus
 * needs no unseal and nothing of it appears in `inspectBus`. Its values are
 * `signal()` cells: Vue refs once Vue is wired, so a Vue view copies nothing.
 * Without a reactive backing, `subscribe(fn)` says when a value moved.
 *
 * One state per bus, shared and ref-counted: every `commandState(bus)` gets a
 * handle on it, and the last handle's `dispose()` releases it. While a command
 * it saw start is in flight, the state outlives its last handle, so the next
 * one sees that key still pending (tests/shared-state-handover.test.ts). Once
 * released, the bus's observer is handed back as null and the bus is bare
 * again: keeping it armed for ever cost an unheld bus 232 ns per dispatch
 * against 35 (docs/decisions.md, 2026-10-01).
 */

import { signal, type Signal } from './signal';
import { _report } from './report';
import { createFastLane, type FastLane } from './fast-lane';
import { countOption } from './bounds';
import { DEV } from './dev';
import { _factsSetter, _failures, _isSyncBus, _targetKey, type BaseBus, type Command, type CommandResult, type Facts } from './command-bus';

const fail = _failures('core');
// The build profile: true from `vaporChamberWire({ profile: 'lean' })`, false
// from the plugin otherwise and from the IIFE builds; undefined (performance)
// through a bundler without the plugin. Read in track().
declare const __VC_LEAN__: boolean | undefined;

/** One key's in-flight count and the flag its readers subscribe to. `flag` is
 *  null until `pending()` reads the key, created then from the count, so a key
 *  nobody asks about costs no signal and no reactive write per dispatch
 *  (0.969-0.982x on a tracked dispatch, 3.6-6.1 ns, log s35.53). Once
 *  created it is written only on 0 <-> 1, so a reader re-runs on transitions of
 *  ITS key and on nothing else, and the slot is kept when its count returns to
 *  0, since the reader holds the signal and later dispatches must write that
 *  same one. A slot without one is pruned then in the lean profile; the
 *  performance profile keeps it for the next dispatch of its key while its
 *  bucket holds 256 or fewer (see `pruneAbove`). */
type Slot = { key: string; n: number; flag: Signal<boolean> | null; bucket: Map<string, Slot> };

/** The state shared by every handle on one bus. */
type Entry = {
  /** Hands the bus its observer, or null on release (`_factsSetter`). */
  set: (facts: Facts | null) => void;
  lastError: Signal<Error | null>;
  errors: Signal<readonly Error[]>;
  /** `anyPending`'s signal, null until it is first read. */
  any: Signal<boolean> | null;
  refCount: number;
  maxSize: number;
  /** Per-(action, target) slots: a map by action, then by the target's
   *  `commandKey` part (`_targetKey`), so a dispatch builds no key string. Null
   *  until tracking starts (the first `pending()` call or `anyPending` read),
   *  so a bus nobody asks per-key questions of pays nothing. */
  slots: Map<string, Map<string, Slot>> | null;
  /** The slot each started Command counted into, so a settle is matched to
   *  ITS start and never decrements someone else's. On an async bus or the
   *  test bus; a sync bus uses `stack`. Null until tracking starts. */
  started: Map<Command, Slot> | null;
  /** A sync bus's starts, each Command followed by its slot, innermost last.
   *  Its settles come in LIFO order on every nesting path
   *  (tests/isloading-nesting.test.ts), so a settle is matched at the top. The
   *  match is still by identity: a settle with no start (a query, a command
   *  already running when tracking began) is not found and takes nothing, and
   *  one below a start that never settled is found and removed there. Null
   *  until tracking starts. */
  stack: Array<Command | Slot> | null;
  /** Commands started and not yet settled. While above 0 the entry outlives
   *  its last handle, so the next one sees the key still in flight; the
   *  settle that ends the last one releases it. */
  pending: number;
  /** An unread slot back at 0 is pruned only while its action's bucket holds
   *  more than this: 256 in the performance profile (the slot is reused, no
   *  allocation, set or delete per dispatch: 0.848-0.865x on a tracked
   *  dispatch, 21-22 ns, log s35.61), 0 in lean (pruned at once). Set from
   *  `__VC_LEAN__` when tracking starts, never per dispatch. */
  pruneAbove: number;
  /** `subscribe`'s lane, made by the first subscriber. */
  notices: FastLane | null;
};

/** One handle on a bus's command state (`commandState`). */
export type CommandState = {
  /**
   * In flight for this key, bus-wide: any dispatch counts, from any caller.
   * Keyed like `commandKey`, so object targets match by value. `pending(action)`
   * is the exact key `(action, undefined)`, not "any target of this action".
   * Its own signal, written only when its count crosses 0 <-> 1. Counting
   * starts at the first `pending()` call or `anyPending` read: a dispatch
   * already in flight then is not counted.
   */
  pending(action: string, target?: unknown): Readonly<Signal<boolean>>;
  /** Any command in flight on the bus, written on 0 <-> 1. Reading it starts counting. */
  readonly anyPending: Readonly<Signal<boolean>>;
  /** The bus's recent failures, newest last, at most `maxSize`. */
  readonly errors: Readonly<Signal<readonly Error[]>>;
  /** The bus's most recent failure. */
  readonly lastError: Readonly<Signal<Error | null>>;
  /** Wipe `errors` and `lastError`. Pending keys are untouched. */
  clear(): void;
  /** Call `fn` after a fact moved a value this state holds. Returns the unsubscribe. */
  subscribe(fn: () => void): () => void;
  /** Release this handle, once. The last one releases the state. */
  dispose(): void;
};

export type CommandStateOptions = {
  /** How many recent errors `errors` keeps. Default 10. A later handle may
   *  lower it, never raise it. */
  maxSize?: number;
};

const _states = new WeakMap<BaseBus, Entry>();

/** A subscriber's throw is logged and the dispatch goes on, as a bus listener's. */
const logError = (e: unknown): void => { _report('error', 'core:failed:subscriber', 'a command state subscriber threw', e); };

function slotOf(slots: Map<string, Map<string, Slot>>, action: string, key: string): Slot {
  let bucket = slots.get(action);
  if (bucket === undefined) {
    bucket = new Map();
    slots.set(action, bucket);
  }
  let slot = bucket.get(key);
  if (slot === undefined) {
    slot = { key, n: 0, flag: null, bucket };
    bucket.set(key, slot);
  }
  return slot;
}

/** Say a value moved, to the subscribers if any. */
function notify(entry: Entry): void {
  if (entry.notices !== null) entry.notices.emit('change', undefined);
}

function release(entry: Entry, bus: BaseBus): void {
  entry.set(null);
  entry.notices?.clear();
  _states.delete(bus);
}

/** Start counting, once per entry: the starts are matched from now on. */
function track(entry: Entry, bus: BaseBus): Map<string, Map<string, Slot>> {
  if (entry.slots === null) {
    // The build profile, read once per entry: a `typeof` of a global nobody
    // defined is a slow lookup (docs/V8-RULES.md rule 6), and a define folds
    // this line to the write or to nothing.
    if (typeof __VC_LEAN__ !== 'undefined' && __VC_LEAN__) entry.pruneAbove = 0;
    // A Map, not a WeakMap: every start is deleted at its settle, and a start
    // that never settled would already hold `pending` above 0 (the entry and
    // the key stay), so weakness would free only the Command. The WeakMap cost
    // 24-26 ns of a tracked dispatch's ~188 (this Map: 0.858-0.871x, log s35.53).
    if (_isSyncBus(bus)) entry.stack = [];
    else entry.started = new Map();
    entry.slots = new Map();
  }
  return entry.slots;
}

/**
 * One signal write. A reader's synchronous effect that throws on it is logged,
 * and the next write still happens: a throw on a key leaves `anyPending` right,
 * one on `lastError` leaves `errors` whole
 * (tests/shared-state-throwing-subscriber.test.ts).
 */
function put<T>(cell: Signal<T>, value: T): void {
  try { cell.value = value; } catch (e) { logError(e); }
}

/**
 * A start counted into `slot`. The counts move before any signal is written,
 * and a write's throw (a reader's synchronous effect) is logged: the counts
 * stay whole, so the settle still finds and ends this start, and the
 * dispatch runs (tests/shared-state-throwing-subscriber.test.ts).
 */
function lit(entry: Entry, slot: Slot): void {
  const key = slot.n++ === 0 && slot.flag !== null;
  const any = entry.pending++ === 0 && entry.any !== null;
  if (key) put(slot.flag!, true);
  if (any) put(entry.any!, true);
  if (key || any) notify(entry);
}

/** A settle matched to its start, as `lit` in reverse: the counts first, then the writes. */
function ended(entry: Entry, slot: Slot, bus: BaseBus): void {
  const key = --slot.n === 0;
  const keyFlag = key && slot.flag !== null;
  if (key && !keyFlag && slot.bucket.size > entry.pruneAbove) slot.bucket.delete(slot.key);
  const idle = --entry.pending === 0;
  const any = idle && entry.any !== null;
  if (idle && entry.refCount <= 0) release(entry, bus);
  if (keyFlag) put(slot.flag!, false);
  if (any) put(entry.any!, false);
  if (keyFlag || any) notify(entry);
}

/** A failed result, into the ring. Failure path only. */
function failed(entry: Entry, error: Error): void {
  const next = entry.errors.value.slice();
  next.push(error);
  while (next.length > entry.maxSize) next.shift();
  put(entry.errors, next);
  put(entry.lastError, error);
  notify(entry);
}

/**
 * The bus's observer, one per bus kind, chosen once (docs/V8-RULES.md rule 3).
 * A settle is matched to ITS start by the Command, so one with no start (a
 * query, a command in flight before counting began) takes nothing.
 */
function observer(entry: Entry, bus: BaseBus): Facts {
  if (_isSyncBus(bus)) {
    return {
      started(cmd: Command): void {
        const stack = entry.stack;
        if (stack === null) return;
        const slot = slotOf(entry.slots!, cmd.action, _targetKey(cmd.target));
        stack.push(cmd, slot);
        lit(entry, slot);
      },
      queried(): void {},
      settled(cmd: Command, result: CommandResult): void {
        const stack = entry.stack;
        if (stack !== null) {
          let slot: Slot | undefined;
          let i = stack.length - 2;
          if (i >= 0 && stack[i] === cmd) {
            slot = stack.pop() as Slot;
            stack.pop();
          } else {
            i -= 2;
            while (i >= 0 && stack[i] !== cmd) i -= 2;
            if (i >= 0) slot = stack.splice(i, 2)[1] as Slot;
          }
          if (slot !== undefined) ended(entry, slot, bus);
        }
        if (!result.ok && result.error) failed(entry, result.error);
      },
    };
  }
  return {
    queried(): void {},
    started(cmd: Command): void {
      const started = entry.started;
      if (started === null) return;
      const slot = slotOf(entry.slots!, cmd.action, _targetKey(cmd.target));
      started.set(cmd, slot);
      lit(entry, slot);
    },
    settled(cmd: Command, result: CommandResult): void {
      const started = entry.started;
      if (started !== null) {
        const slot = started.get(cmd);
        if (slot !== undefined) {
          started.delete(cmd);
          ended(entry, slot, bus);
        }
      }
      if (!result.ok && result.error) failed(entry, result.error);
    },
  };
}

function create(bus: BaseBus, maxSize: number): Entry {
  const set = _factsSetter(bus);
  if (set === undefined) {
    throw fail('invalid:bus', `commandState() needs a bus this library made.${DEV ? ' A bus you build yourself has no internal facts observer: use createCommandBus, createAsyncCommandBus or createTestBus.' : ''}`);
  }
  const entry: Entry = {
    set,
    lastError: signal<Error | null>(null),
    errors: signal<readonly Error[]>([]),
    any: null,
    refCount: 0,
    maxSize,
    slots: null, started: null, stack: null,
    pending: 0,
    pruneAbove: 256,
    notices: null,
  };
  set(observer(entry, bus));
  _states.set(bus, entry);
  return entry;
}

/**
 * commandState - what is in flight on `bus`, and what failed, for any
 * framework or none.
 *
 * Returns a handle on the bus's one shared state: `pending(action, target?)`,
 * `anyPending`, `errors`, `lastError`, `clear()`, `subscribe(fn)` and
 * `dispose()`. Every handle reads the same signals. Throws
 * `core:invalid:bus` for a bus this library did not make.
 *
 * @example
 * const state = commandState(bus);
 * const saving = state.pending('cartAdd', { id: 1 });
 * state.subscribe(() => render(saving.value));
 * // later
 * state.dispose();
 */
export function commandState(bus: BaseBus, options: CommandStateOptions = {}): CommandState {
  const maxSize = countOption(options.maxSize, 10); // a NaN is the default (bounds.ts)
  let entry = _states.get(bus);
  if (entry === undefined) entry = create(bus, maxSize);
  // Tighten the cap if the new caller wants a smaller buffer; never grow
  // it above another caller's request (avoid surprise memory growth).
  else if (maxSize < entry.maxSize) entry.maxSize = maxSize;
  entry.refCount++;
  const e = entry;

  // Once per handle: a manual dispose() followed by a scope's own would
  // count this handle out twice and release an entry a later handle uses
  // (tests/shared-state-dispose-twice.test.ts).
  let held = true;
  return {
    pending(action: string, target?: unknown): Readonly<Signal<boolean>> {
      const slot = slotOf(track(e, bus), action, _targetKey(target));
      // Created on the first read, lit if the key is already in flight.
      if (slot.flag === null) slot.flag = signal(slot.n > 0);
      return slot.flag;
    },
    get anyPending(): Readonly<Signal<boolean>> {
      track(e, bus);
      return (e.any ??= signal(e.pending > 0));
    },
    errors: e.errors,
    lastError: e.lastError,
    clear(): void {
      e.errors.value = [];
      e.lastError.value = null;
      notify(e);
    },
    subscribe(fn: () => void): () => void {
      e.notices ??= createFastLane({ onError: logError });
      return e.notices.on('change', fn);
    },
    dispose(): void {
      if (!held) return;
      held = false;
      // With a command in flight the entry stays (see `pending`).
      if (--e.refCount <= 0 && e.pending === 0) release(e, bus);
    },
  };
}
