/**
 * vapor-chamber - act on a command result that may not have arrived yet.
 *
 * On the ASYNC bus a dispatch, a step's answer or an undo returns a PROMISE of
 * the result, whose `.ok` is `undefined`. Code that reads it as the result
 * fails silently. `onSettled` settles it, and stays synchronous on the sync
 * bus, so one function serves both (the register undo path, the ledger, the
 * store, an app reading `bus.dispatch` on either bus).
 */

import type { CommandResult } from './command-bus';
import { _report } from './report';

/** A result, or the promise of one - what a dispatch on either bus returns. */
export type MaybeAsyncResult = CommandResult | Promise<CommandResult>;

/**
 * Is this a thenable? The predicate the whole class turns on, in one place.
 *
 * `onSettled` covers the sites that MAP a result to a result. It cannot cover
 * the two saga loops in `utilities.ts`, and not because they are careless:
 * they sit inside `async` functions and want a VALUE, spelled
 * `isThenable(x) ? await x : x`. That is not `onSettled`'s shape and it is not
 * a candidate for one either - a helper returning the value would have to be
 * `async` itself, which costs a microtask on the SYNC path, and dodging
 * exactly that tick is why the ternary is written out.
 *
 * So the control flow stays at those call sites and only the predicate moves.
 * That is the part that was being retyped, and the part a typo makes silently
 * false - `typeof x.then === 'function'` on a value with no `then` is the same
 * `false` as a misspelled property, and both read as "this was synchronous".
 *
 * `command-bus.ts` writes the test inline at its own sites. It imports
 * `onSettled` from this module already, so the import costs nothing; the
 * sites are on the dispatch path, where a change is decided by `npm run ab`
 * (docs/V8-RULES.md rule 13), and none has been run.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  // Optional chaining rather than `value != null && typeof ...`: it
  // short-circuits to `undefined` on null and undefined alike, and `typeof
  // undefined` is not `'function'`, so the null guard is free instead of being
  // a second operand. Measured on the budgeted Blade bundle.
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';
}

/**
 * Run `fn` once the result is real, and PRESERVE SYNC-NESS: a sync result
 * stays sync, so the sync bus never waits a microtask for it. Only a promise
 * takes the async arm.
 *
 * THERE IS NO REJECTION ARM. One call site in `chamber.ts` (runDispatch)
 * hand-rolls the check instead: a dispatch promise that REJECTS never reaches
 * `fn`, and it has cleanup that must run anyway (clearing a loading flag,
 * recording the error), so it spells out
 * `.then(onOk, onErr)` plus the success body again for the sync path. Through
 * `onSettled` with a rejection arm, the sync path would build its two
 * callbacks on every dispatch, since they capture that dispatch's state: a
 * closure per call on a hot path (docs/V8-RULES.md rule 4). The duplicated
 * bodies stay until an `npm run ab` says the closures cost nothing.
 */
export function onSettled<R extends MaybeAsyncResult>(
  result: R,
  fn: (settled: CommandResult) => CommandResult,
): R {
  // The predicate is INLINE here rather than a call to `isThenable`, which is
  // the same test written twice in one file on purpose. `onSettled` is in the
  // budgeted Blade consumer bundle (it reaches it through `logger`), and
  // `isThenable` is not: no consumer of that bundle calls the predicate
  // directly. Calling it from here would anchor it into the import graph and
  // it measured +3 brotli there in v1.22.0 - paid by every consumer, to save a line in a
  // file that already has the rule at the top of it. Keeping the call site
  // free lets the export tree-shake away for anyone who does not use it.
  return (result != null && typeof (result as PromiseLike<CommandResult>).then === 'function')
    // Sync in, sync out; a promise in, a promise out: `R` either way.
    ? (result as Promise<CommandResult>).then(fn) as R
    : fn(result as CommandResult) as R;
}

/**
 * Move a history's stacks for an undo or redo, and move them BACK if it does
 * not land. Moving first means observers inside the call see the result (a
 * listener on a redo's re-dispatch reads the redone state; pinned by
 * tests/plugins-core-gaps.test.ts, "island-cart wiring"). Moving back means an
 * undo the server refused does not read "undone" - for a screen-reader user,
 * who cannot see that nothing changed, that is indistinguishable from success
 * (WCAG 3.3.4).
 *
 * Not landing is a throw, a rejection, or a failed CommandResult, returned or
 * resolved; a throw or rejection is reported here (`history:failed:move`),
 * once for every caller. Answers whether it landed, as a promise when
 * it had to wait, so the caller can refuse a second press meanwhile and take
 * the next step of a press only after this one landed. The ledger's undo and
 * redo share it; useCommandHistory and history() each had the defect.
 * tests/history-undo-lands.test.ts.
 */
export function moveUnlessRefused(
  move: () => void,
  revert: () => void,
  call: () => unknown,
  label: string,
  action: string,
): boolean | Promise<boolean> {
  const onError = (e: unknown): void => _report('error', 'history:failed:move', `${label} threw for "${action}"`, e, { action });
  const landed = (v: unknown): boolean => {
    const refused = v != null && typeof v === 'object' && (v as { ok?: unknown }).ok === false;
    if (refused) revert();
    return !refused;
  };
  let outcome: unknown;
  try {
    // The move is inside the try: an observer of the move that throws (a sync
    // subscriber of useCommandHistory's signals) is a call that did not land
    // (pinned by tests/history-throwing-subscriber.test.ts).
    move();
    outcome = call();
  } catch (e) {
    revert();
    onError(e);
    return false;
  }
  if (!isThenable(outcome)) return landed(outcome);
  return Promise.resolve(outcome).then(landed, (e) => { revert(); onError(e); return false; });
}
