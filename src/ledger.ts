/**
 * vapor-chamber - the one undo/redo ledger.
 *
 * Internal. `history()` (plugins-core.ts) and `useCommandHistory()`
 * (chamber.ts) both wrap this, so the stacks, the recording rule, undo and
 * redo exist once; they differ only where they genuinely differ: WHERE a command is
 * recorded (the plugin chain, or `onAfter`), what extra is skipped (trigger
 * actions, a KeepAlive pause), and how the stacks are exposed (`getState()`,
 * or signals).
 *
 * Recording keeps successes only, skips what an undo or a redo dispatched
 * (origin 'undo' / 'redo', scoped), applies the filter, caps at
 * `maxSize` and clears the redo stack. Undo and redo move the stacks first, so
 * observers inside the call see the result, and move them BACK when the call
 * does not land (settled.ts, moveUnlessRefused). While one is in flight,
 * another press does nothing.
 */
import { countOption } from './bounds';
import type { Command, CommandResult, Handler } from './command-bus';
import { _undo, _withOriginScope } from './command-bus';
import { isThenable, moveUnlessRefused } from './settled';

// The `$undo` dispatch's result, read as the inverse's own answer: its value
// (a refusal it returned stays a refusal), or its error thrown, as a throw of
// the inverse was before.
const answer = (r: CommandResult): unknown => {
  if (!r.ok) throw r.error;
  return r.value;
};
const onSettledValue = (r: unknown): unknown =>
  isThenable(r) ? Promise.resolve(r).then((x) => answer(x as CommandResult)) : answer(r as CommandResult);

/** What the ledger needs from a bus: the two calls an undo and a redo make. */
export type LedgerBus = {
  getUndoHandler(action: string): Handler | undefined;
  /** The `canUndo` registered with the undo (register options), when any. */
  getUndoCheck?(action: string): ((cmd: Command) => boolean) | undefined;
  dispatch(action: string, target: any, payload?: any): unknown;
};

export type Ledger = {
  readonly past: Command[];
  readonly future: Command[];
  /** Record `cmd` if the rule keeps it. */
  record(cmd: Command, result: CommandResult): void;
  /** Something to undo, and the top command's `canUndo` (when registered) says it can be. */
  canUndo(): boolean;
  undo(): Command | undefined;
  redo(): Command | undefined;
  clear(): void;
};

export function createLedger(options: {
  maxSize?: number;
  filter?: (cmd: Command) => boolean;
  /** Also left out of the ledger (trigger actions, a paused view). */
  skip?: (cmd: Command) => boolean;
  bus?: LedgerBus;
  /**
   * After any change. The undo stack moves on every change; `futureMoved`
   * says whether the redo stack did, so a view can keep an identity it does
   * not need to renew.
   */
  onChange?: (futureMoved: boolean) => void;
}): Ledger {
  const { filter, skip, bus, onChange } = options;
  // `past.length > maxSize` gates EVICTION, so a NaN cap evicted nothing and the
  // stack grew without bound - measured at 500 entries against a cap of 50.
  const maxSize = countOption(options.maxSize ?? 50, 50);
  const past: Command[] = [];
  const future: Command[] = [];
  let inFlight = false;
  const checked = (): ((cmd: Command) => boolean) | undefined =>
    past.length === 0 ? undefined : bus?.getUndoCheck?.(past[past.length - 1].action);

  // The top step's check, read once per stack change: a command the history
  // skips reads this flag, not the bus's map (log s35.118, A/B).
  let topChecked = false;
  const changed = (futureMoved: boolean): void => {
    topChecked = checked() !== undefined;
    onChange?.(futureMoved);
  };
  // Moves `cmd` only if it is still in `from`. A revert that arrives after
  // clear() (an undo refused once the history was emptied) finds nothing and
  // must not bring the command back into a history the user cleared.
  const shift = (from: Command[], to: Command[], cmd: Command): void => {
    const at = from.lastIndexOf(cmd);
    if (at === -1) return;
    from.splice(at, 1);
    to.push(cmd);
    changed(true);
  };
  const run = (label: string, cmd: Command, forward: () => void, back: () => void, call: () => unknown): Command => {
    const wait = moveUnlessRefused(forward, back, call, label, cmd.action);
    if (wait) {
      inFlight = true;
      void wait.then(() => { inFlight = false; });
    }
    return cmd;
  };

  return {
    past,
    future,
    record(cmd, result) {
      const origin = cmd.meta?.origin;
      if (origin === 'redo' || origin === 'undo' || origin === 'sync' || !result.ok || skip?.(cmd) || (filter && !filter(cmd))) {
        if (topChecked) changed(false); // may have moved what canUndo reads
        return;
      }
      past.push(cmd);
      if (past.length > maxSize) past.shift();
      const hadFuture = future.length !== 0;
      future.length = 0;
      changed(hadFuture);
    },
    canUndo: () => past.length !== 0 && (checked()?.(past[past.length - 1]) ?? true),
    undo() {
      const cmd = past[past.length - 1];
      if (inFlight || !cmd || checked()?.(cmd) === false) return undefined;
      const handler = bus?.getUndoHandler(cmd.action);
      // Its own dispatches are rollback steps: origin 'undo', not recorded.
      return run('Undo handler', cmd, () => shift(past, future, cmd), () => shift(future, past, cmd),
        () => (handler ? onSettledValue(_undo(bus as LedgerBus, cmd)) : undefined));
    },
    redo() {
      const cmd = future[future.length - 1];
      if (inFlight || !cmd) return undefined;
      // The redone dispatch, and whatever its handler dispatches, carry origin
      // 'redo' (scoped), so neither is recorded again: `record` is the single
      // write path for new entries and `shift` for moves, on both bus types.
      return run('Redo dispatch', cmd, () => shift(future, past, cmd), () => shift(past, future, cmd),
        () => (bus ? _withOriginScope('redo', () => bus.dispatch(cmd.action, cmd.target, cmd.payload)) : undefined));
    },
    clear() {
      past.length = 0;
      future.length = 0;
      changed(true);
    },
  };
}
