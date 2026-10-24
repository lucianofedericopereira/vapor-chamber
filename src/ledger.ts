/**
 * vapor-chamber - the one undo/redo ledger.
 *
 * Internal. `history()` (plugins-core.ts) and `useCommandHistory()`
 * (chamber.ts) both wrap the
 * ledger and its recorder, so the stacks, the recording rule, where a command
 * is recorded, undo and redo exist once. They differ only in what extra is
 * skipped (trigger actions, a KeepAlive pause) and how the stacks are exposed
 * (`getState()`, or signals).
 *
 * The recorder is an after-hook: it sees what the caller got, after the chain,
 * wherever plugins sit (tests/history-installs.test.ts).
 *
 * Recording keeps successes only, skips what an undo or a redo dispatched
 * (origin 'undo' / 'redo', scoped) and a command an app's sync layer mirrored
 * (origin 'sync', tests/plugins-core-gaps.test.ts), keeps to its scope, caps at
 * `maxSize` and clears the redo stack. Undo and redo move the stacks first, so
 * observers inside the call see the result, and move them BACK when the call
 * does not land (settled.ts, moveUnlessRefused). While one is in flight,
 * another press does nothing.
 *
 * One press undoes a command and the recorded commands it caused, such as a
 * reaction's follow-up, and one redo replays them, read from the stacks by
 * defined `causationId` (tests/history-group.test.ts). A child a handler
 * dispatched with its parent's id is recorded before the parent: a redo carries
 * it back without dispatching it, since the parent's handler dispatches it
 * again (tests/history-child-redo.test.ts). Each member moves on its own, so
 * `onChange` fires once per member, and a refused one goes back to its place.
 */
import { countOption } from './bounds';
import type { BaseBus, Command, CommandResult, Handler, ScopeOptions } from './command-bus';
import { _pastSeal, _scoped, _undo, _withOriginScope } from './command-bus';
import { _appliedRemotely, _hearers, type TabHearer } from './applied-remotely';
import { Accepted } from './accepted';
import { isThenable, moveUnlessRefused } from './settled';
import { _stateHalf, type StateHalf } from './store-base';
import { _plainRuntime } from './store/core';

// The `$undo` dispatch's result, read as the inverse's own answer: its value
// (a refusal it returned stays a refusal), or its error thrown, as a throw of
// the inverse was before.
const answer = (r: CommandResult): unknown => {
  if (!r.ok) throw r.error;
  return r.value;
};
const onSettledValue = (r: unknown): unknown =>
  isThenable(r) ? Promise.resolve(r).then((x) => answer(x as CommandResult)) : answer(r as CommandResult);

/**
 * The origins history does not record: what an undo or a redo dispatched, and
 * a change an app's sync layer mirrored. A reaction skips them too
 * (utilities.ts), so a redo does not run its follow-up twice.
 */
export const _unrecorded = (origin: string | undefined): boolean => origin === 'redo' || origin === 'undo' || origin === 'sync';

/** What the ledger needs from a bus: the two calls an undo and a redo make. */
export type LedgerBus = {
  getUndoHandler(action: string): Handler | undefined;
  /** The `canUndo` registered with the undo (register options), when any. */
  getUndoCheck?(action: string): ((cmd: Command) => boolean) | undefined;
  dispatch(action: string, target: any, payload?: any): unknown;
};

export type Ledger = {
  /** The undo stack, oldest first: the ledger's own array, `readonly`. A change after it was handed out writes a new one. */
  readonly past: readonly Command[];
  /** The redo stack, oldest first: the ledger's own array, `readonly`. A change after it was handed out writes a new one. */
  readonly future: readonly Command[];
  /** Record `cmd` if the rule keeps it. */
  record(cmd: Command, result: CommandResult): void;
  /** Something to undo, and the top command's `canUndo` (when registered) says it can be. */
  canUndo(): boolean;
  undo(): Command | undefined;
  redo(): Command | undefined;
  clear(): void;
} & TabHearer;

/** The ledger's state: its two stacks. */
type Steps = { past: Command[]; future: Command[] };

export function createLedger(options: ScopeOptions & {
  maxSize?: number;
  /** Also left out of the ledger (trigger actions, a paused view). */
  skip?: (cmd: Command) => boolean;
  bus: LedgerBus;
  /**
   * After any change. The undo stack moves on every change; `futureMoved`
   * says whether the redo stack did, so a view can keep an identity it does
   * not need to renew.
   */
  onChange?: (futureMoved: boolean) => void;
}): Ledger {
  const { skip, bus, onChange } = options;
  // The scope, asked once per action; null while there is none.
  const inside = _scoped(options);
  // `past.length > maxSize` gates EVICTION, so a NaN cap evicted nothing and the
  // stack grew without bound - measured at 500 entries against a cap of 50.
  const maxSize = countOption(options.maxSize ?? 50, 50);
  // History's steps are state (plan 1.32 4.2): a state half of their own, no
  // registration, nothing on the bus, no persist or share (Commands are not
  // data). A reader gets the stacks with no copy, `readonly` in the type (a
  // build-time check: a freeze would run per recorded dispatch). A stack is
  // changed in place until a reader got it: the next change then copies it
  // first, so a stack a reader holds never moves. A history nobody reads
  // pays a push per record (log 36.F6).
  const half: StateHalf<Steps> = _stateHalf<Steps>(_plainRuntime, { id: 'history', state: () => ({ past: [], future: [] }) }, null);
  const steps = half.cell.value;
  // Whether each stack was handed out since its last copy.
  let pastOut = false;
  let futureOut = false;
  // The stack to change: the one held, or a copy once a reader got it.
  const past = (): Command[] => {
    if (pastOut) {
      pastOut = false;
      steps.past = steps.past.slice();
    }
    return steps.past;
  };
  const future = (): Command[] => {
    if (futureOut) {
      futureOut = false;
      steps.future = steps.future.slice();
    }
    return steps.future;
  };
  let inFlight = false;
  const checked = (): ((cmd: Command) => boolean) | undefined => {
    const p = steps.past;
    return p.length === 0 ? undefined : bus.getUndoCheck?.(p[p.length - 1].action);
  };

  // The top step's check, read once per stack change: a command the history
  // skips reads this flag, not the bus's map (log s35.118, A/B).
  let topChecked = false;
  const changed = (futureMoved: boolean): void => {
    topChecked = checked() !== undefined;
    onChange?.(futureMoved);
  };
  // Moves `cmd` from one stack to the top of the other, only if it is still
  // there, and answers where it was (-1 when gone). A revert that arrives
  // after clear() (an undo refused once the history was emptied) finds
  // nothing and must not bring the command back into a history the user
  // cleared. A press moves its top step: `pop`. `toFuture`: an undo's move,
  // else a redo's.
  const shift = (toFuture: boolean, cmd: Command): number => {
    const from = toFuture ? past() : future();
    const at = placeOf(from, cmd);
    if (at === -1) return -1;
    if (at === from.length - 1) from.pop();
    else from.splice(at, 1);
    (toFuture ? future() : past()).push(cmd);
    changed(true);
    return at;
  };
  // Moves `cmd` back where it was (index `at`): a refused step keeps its
  // place, so the recording order a press reads stays true. `toPast`: an
  // undo's revert, else a redo's.
  const back = (toPast: boolean, cmd: Command, at: number): void => {
    const from = toPast ? future() : past();
    const i = placeOf(from, cmd);
    if (i === -1) return;
    from.splice(i, 1);
    (toPast ? past() : future()).splice(at, 0, cmd);
    changed(true);
  };
  // One step of a press, answering whether it landed.
  const undoOne = (cmd: Command): boolean | Promise<boolean> => {
    const handler = bus.getUndoHandler(cmd.action);
    // Where the move found it, for a revert.
    let at = -1;
    // Its own dispatches are rollback steps: origin 'undo', not recorded.
    return moveUnlessRefused(() => { at = shift(true, cmd); }, () => back(true, cmd, at),
      () => (handler ? onSettledValue(_undo(bus, cmd)) : undefined), 'Undo handler', cmd.action);
  };
  // The redone dispatch, and whatever its handler dispatches, carry origin
  // 'redo' (scoped), so neither is recorded again: `record` is the single
  // write path for new entries and `shift` for moves, on both bus types.
  const redoOne = (cmd: Command): boolean | Promise<boolean> => {
    let at = -1;
    return moveUnlessRefused(() => { at = shift(false, cmd); }, () => back(false, cmd, at),
      () => _withOriginScope('redo', () => bus.dispatch(cmd.action, cmd.target, cmd.payload)), 'Redo dispatch', cmd.action);
  };
  // One press: `one` on each member in order, each after the one before landed
  // and while `may` allows the next. In flight until the last settles. A press
  // of one step, the common one, builds no chain.
  const press = (members: Command[], one: (cmd: Command) => boolean | Promise<boolean>, may: (cmd: Command) => boolean): void => {
    const wait = members.length === 1 ? one(members[0]) : chain(members, one, may);
    if (isThenable(wait)) {
      inFlight = true;
      void Promise.resolve(wait).then(() => { inFlight = false; });
    }
  };
  const always = (): boolean => true;
  // A redo of several members, its own function so a one-step redo allocates
  // none of this. A member recorded before its declared cause is that handler's
  // child: the cause's handler dispatches it again (origin redo, not recorded),
  // so it is carried back, never dispatched, right after its cause lands.
  const redoGroup = (members: Command[]): void => {
    const carried = new Map<Command, Command>();
    for (let i = 0; i < members.length; i++) {
      const parent = laterCause(members, i);
      if (parent !== undefined) carried.set(members[i], parent);
    }
    const carry = (cmd: Command): boolean => {
      const at = steps.future.lastIndexOf(cmd);
      if (at !== -1) {
        future().splice(at, 1);
        // Before its cause, where it was recorded.
        const p = past();
        p.splice(p.lastIndexOf(carried.get(cmd) as Command), 0, cmd);
        changed(true);
      }
      return true;
    };
    press(runOrder(members, carried), (cmd) => (carried.has(cmd) ? carry(cmd) : redoOne(cmd)), always);
  };

  // A step can be undone: a transport did not carry it out (undo is local:
  // log s35.159), and its `canUndo` allows it.
  const undoable = (cmd: Command): boolean => !_appliedRemotely.has(cmd) && bus.getUndoCheck?.(cmd.action)?.(cmd) !== false;
  const can = (): boolean => {
    const p = steps.past;
    return p.length !== 0 && undoable(p[p.length - 1]);
  };
  // A recorded step: on the undo stack, capped, and the redo stack emptied.
  const keep = (cmd: Command): void => {
    const p = past();
    p.push(cmd);
    if (p.length > maxSize) p.shift();
    const hadFuture = steps.future.length !== 0;
    if (hadFuture) {
      // A redo stack a reader holds stays as it was: a new one in its place.
      if (futureOut) {
        futureOut = false;
        steps.future = [];
      } else steps.future.length = 0;
    }
    changed(hadFuture);
  };

  return {
    get past() {
      pastOut = true;
      return steps.past;
    },
    get future() {
      futureOut = true;
      return steps.future;
    },
    record(cmd, result) {
      // An `Accepted` is not the end (a held command, a 202): no step to undo yet.
      if (_unrecorded(cmd.meta?.origin) || !result.ok || result.value instanceof Accepted || skip?.(cmd) || (inside !== null && !inside(cmd.action))) {
        if (topChecked) changed(false); // may have moved what canUndo reads
        return;
      }
      keep(cmd);
    },
    // Another tab, with no dispatch (src/store-base.ts, `hear`): its command,
    // kept by the same rule, and its undo or redo, moved like this tab's own.
    // One the lead ran under this tab's unconfirmed writes goes under them
    // here too, as the store's ring holds it: every tab's history is then the
    // same, and its top is the store's top (log 36.F40). Moved after `keep`,
    // so a recorded dispatch's `keep` stays as it was.
    heard(cmd, under) {
      if (skip?.(cmd as Command) || (inside !== null && !inside(cmd.action))) {
        if (topChecked) changed(false);
        return;
      }
      keep(cmd as Command);
      if (under !== undefined) {
        const p = steps.past;
        for (let i = 0; i < p.length - 1; i++) {
          if (under.includes(p[i]!.meta?.id as string)) {
            const q = past();
            q.splice(i, 0, q.pop() as Command);
            changed(false);
            break;
          }
        }
      }
    },
    undone(cmd) {
      shift(true, cmd as Command);
    },
    redone(cmd) {
      shift(false, cmd as Command);
    },
    moved() {
      if (topChecked) changed(false);
    },
    canUndo: can,
    undo() {
      if (inFlight || !can()) return undefined;
      // The press, read from the stack now: the top, then each step below tied
      // to a member by a declared cause. Run top-down, the reverse of recording.
      const p = steps.past;
      const members: Command[] = [p[p.length - 1]];
      for (let i = p.length - 2; i >= 0 && related(members, p[i]); i--) members.push(p[i]);
      press(members, undoOne, undoable);
      return members.length === 1 ? members[0] : rootOf(members);
    },
    redo() {
      const f = steps.future;
      if (inFlight || f.length === 0) return undefined;
      // The press, in recording order: the top, then each step below tied to a member.
      const members: Command[] = [f[f.length - 1]];
      for (let i = f.length - 2; i >= 0 && related(members, f[i]); i--) members.push(f[i]);
      if (members.length === 1) {
        press(members, redoOne, always);
        return members[0];
      }
      redoGroup(members);
      return rootOf(members);
    },
    clear() {
      // New arrays: a reader holds the old ones as they were.
      steps.past = [];
      steps.future = [];
      pastOut = false;
      futureOut = false;
      changed(true);
    },
  };
}

/**
 * Where `cmd` sits in `stack`: a press moves its top step, so one comparison
 * finds it; a scan only when it is not on top. The scan on every step cost an
 * undo+redo 15 ns (log 36.71).
 */
function placeOf(stack: readonly Command[], cmd: Command): number {
  const top = stack.length - 1;
  return stack[top] === cmd ? top : stack.lastIndexOf(cmd);
}

/**
 * `cmd` is tied to a member by a declared cause: it caused a member, a member
 * caused it, or both name the same cause. One loop over the members.
 */
function related(members: Command[], cmd: Command): boolean {
  const id = cmd.meta?.id;
  const cause = cmd.meta?.causationId;
  for (let i = 0; i < members.length; i++) {
    const m = members[i].meta;
    const c = m?.causationId;
    if ((c !== undefined && (c === id || c === cause)) || (cause !== undefined && m?.id === cause)) return true;
  }
  return false;
}

/** The member `cmd` declares as its cause, or undefined. */
function causeIn(members: Command[], cmd: Command): Command | undefined {
  const cause = cmd.meta?.causationId;
  if (cause === undefined) return undefined;
  for (let i = 0; i < members.length; i++) if (members[i].meta?.id === cause) return members[i];
  return undefined;
}

/**
 * The press's root: the member whose declared cause is not a member. Members
 * are tied by declared causes and an id is minted at dispatch, so a cause
 * always precedes its children and no cycle exists: some member has no cause
 * among them. The walk stops on it, or on the last member.
 */
function rootOf(members: Command[]): Command {
  let i = 0;
  while (i < members.length - 1 && causeIn(members, members[i]) !== undefined) i++;
  return members[i];
}

/** Members in recording order: the member recorded after the one at `i` that it declares as its cause. */
function laterCause(members: Command[], i: number): Command | undefined {
  const cause = members[i].meta?.causationId;
  if (cause === undefined) return undefined;
  for (let j = i + 1; j < members.length; j++) if (members[j].meta?.id === cause) return members[j];
  return undefined;
}

/** The redo's run: each replayed member in recording order, each followed by the children it carries. */
function runOrder(members: Command[], carried: Map<Command, Command>): Command[] {
  const run: Command[] = [];
  const children = (parent: Command): void => {
    for (let i = 0; i < members.length; i++) {
      const c = members[i];
      if (carried.get(c) === parent) {
        run.push(c);
        children(c);
      }
    }
  };
  for (let i = 0; i < members.length; i++) {
    if (carried.has(members[i])) continue;
    run.push(members[i]);
    children(members[i]);
  }
  return run;
}

/** A press of several steps: each after the one before landed, while `may` allows the next. */
function chain(members: Command[], one: (cmd: Command) => boolean | Promise<boolean>, may: (cmd: Command) => boolean): unknown {
  let i = 0;
  const go = (): unknown => {
    const landed = one(members[i]);
    const then = (ok: boolean): unknown => (ok && ++i < members.length && may(members[i]) ? go() : undefined);
    return isThenable(landed) ? landed.then(then) : then(landed);
  };
  return go();
}

/**
 * The one recorder: an after-hook, installed past a seal, and a hearer of the
 * bus's stores across tabs. Returns its removal.
 */
export function recordOn(bus: BaseBus, ledger: Ledger): () => void {
  const off = _pastSeal(bus, () => bus.onAfter((cmd: Command, result: CommandResult) => ledger.record(cmd, result)));
  let set = _hearers.get(bus);
  if (set === undefined) _hearers.set(bus, (set = new Set()));
  set.add(ledger);
  return () => {
    off();
    (set as Set<TabHearer>).delete(ledger);
  };
}
