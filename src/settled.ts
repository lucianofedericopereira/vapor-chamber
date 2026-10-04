/**
 * vapor-chamber - act on a command result that may not have arrived yet.
 *
 * A plugin is `(cmd, next) => result`, and on the ASYNC bus `next()` returns a
 * PROMISE of the result, whose `.ok` is `undefined`. A plugin that reads it as
 * the result fails silently: a logger logs every command as an error, a
 * history records nothing, a circuit breaker opens after five SUCCESSES, an
 * SSR plugin dehydrates nothing. `onSettled` settles it, and stays synchronous
 * on the sync bus.
 *
 * Two guards, because a rule applied by hand at each call site is missing
 * wherever nobody remembered it: the `Plugin` type (reading `.ok` straight off
 * `next()` does not compile), and `tests/settled-sweep.test.ts`, which checks
 * every module that returns a plugin - the IIFE/CDN build has no types.
 */

import type { CommandResult } from './command-bus';

/** A result, or the promise of one - what `next()` actually returns. */
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
 * `command-bus.ts` keeps its own copy of the predicate on purpose: it is in the
 * budgeted Blade consumer bundle and importing this module measured +22 brotli
 * there, which is not a price worth paying to deduplicate one expression.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  // Optional chaining rather than `value != null && typeof ...`: it
  // short-circuits to `undefined` on null and undefined alike, and `typeof
  // undefined` is not `'function'`, so the null guard is free instead of being
  // a second operand. Measured on the budgeted Blade bundle.
  return typeof (value as PromiseLike<unknown> | null | undefined)?.then === 'function';
}

/**
 * Run `fn` once the result is real, and PRESERVE SYNC-NESS: a sync `next()`
 * stays sync, so a plugin on the sync bus is byte-for-byte the same behaviour
 * it had before. Only the async arm is new.
 *
 * THERE IS NO REJECTION ARM, and that is a budget decision rather than a
 * design one. Two call sites in `chamber.ts` still hand-roll the check because
 * of it: a dispatch promise that REJECTS never reaches `fn`, and both of them
 * have cleanup that must run anyway (clearing a loading flag, recording the
 * error), so each spells out `.then(onOk, onErr)` plus a duplicate of the whole
 * success body for the sync path.
 *
 * An optional third parameter handed straight to `.then` fixes that and costs
 * nothing for existing callers, since `then(fn, undefined)` is `then(fn)`. It
 * was built and both sites converted; the whole suite passed. What it cost is
 * the edge: `chamber.ts` is in the budgeted Blade consumer bundle and did not
 * previously import this module, so pulling it in measured 6393 brotli against
 * a 6380 ceiling. Thirteen bytes to remove two duplicated bodies is a ceiling
 * question for the owner, not something to take silently, so it is not here.
 * Reinstate the parameter and convert those two sites together with the raise.
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
  // it measured +3 brotli there - paid by every consumer, to save a line in a
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
 * resolved; a throw or rejection is logged here, once for every caller, as
 * `<label> error for "<action>"`. Returns a promise when it had to wait, so
 * the caller can refuse a second press meanwhile. Shared by useCommandHistory
 * and the history() plugin, which had the defect twice.
 * tests/history-undo-lands.test.ts.
 */
export function moveUnlessRefused(
  move: () => void,
  revert: () => void,
  call: () => unknown,
  label: string,
  action: string,
): Promise<void> | undefined {
  const onError = (e: unknown): void => console.error(`[vapor-chamber] ${label} error for "${action}":`, e);
  const refused = (v: unknown): boolean =>
    v != null && typeof v === 'object' && (v as { ok?: unknown }).ok === false;
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
    return undefined;
  }
  if (!isThenable(outcome)) {
    if (refused(outcome)) revert();
    return undefined;
  }
  return Promise.resolve(outcome).then(
    (v) => { if (refused(v)) revert(); },
    (e) => { revert(); onError(e); },
  );
}
