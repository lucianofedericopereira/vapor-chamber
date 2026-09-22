/**
 * vapor-chamber - act on a command result that may not have arrived yet.
 *
 * Internal. A plugin is `(cmd, next) => result`, and on the ASYNC bus `next()`
 * returns a PROMISE of the result. Five shipped plugins read `next()`'s return
 * value as though it were the result itself, and `promise.ok` is `undefined` -
 * so on an async bus, measured through the public API:
 *
 *   logger()          logged EVERY command through console.error as
 *                     `error: undefined`, successes included, and never once
 *                     printed the result value
 *   history()         recorded nothing at all - undo/redo silently inert
 *   circuitBreaker()  took the failure branch on every command, so it went
 *                     OPEN after five consecutive SUCCESSES and began
 *                     refusing traffic that was working
 *   metrics()         wrote `ok: undefined` and timed the promise's creation
 *                     rather than its settlement: 0.02ms for a 30ms handler
 *   persist()         never saved
 *
 * None throws. Every one of them reads as "the plugin is attached and quiet",
 * and the circuit breaker actively breaks a healthy system while looking like
 * it is protecting one.
 *
 * The type system did not catch it because these are declared `Plugin` (whose
 * `next` returns `CommandResult`) while being usable on either bus, and the
 * delivery where it bites hardest is the IIFE/CDN build, where there are no
 * types at all.
 *
 * Found by grepping the plugin family for `const x = next()` followed by a read
 * of `x.ok` with no thenable check - five hits - and then measuring each one
 * through the public API on an async bus. (A console line seen while running
 * the examples prompted the search; it turned out to be stale output from an
 * earlier page in the same tab, so it is not evidence of anything. The five
 * measurements above are.)
 *
 * One helper rather than five inline thenable checks, for the reason this
 * repository has now relearned four times: a rule applied by hand at each call
 * site is missing wherever nobody remembered it.
 *
 * AND THE SWEEP ITSELF WAS ONE OF THOSE HANDS. It was run over the plugin
 * family - `plugins-core.ts`, `plugins-extra.ts`, `plugins-io.ts` - and two
 * plugins live outside it and were missed for two releases:
 *
 *   createSSRPlugin()  recorded NOTHING on an async bus. `dehydrate()` came
 *                      back empty, so the client rehydrated no state at all
 *                      and the page read as one that simply had no commands
 *                      to record. Measured: the same dispatch records on a
 *                      sync bus and returns `[]` on an async one.
 *   schemaLogger()     printed the error branch for every command, successes
 *                      included, with `undefined` as the error - the identical
 *                      defect `logger()` had, three modules away from it.
 *
 * Both now go through this helper. The general lesson is unchanged and the
 * specific one is new: the grep that finds this bug class has to run over
 * everything that returns a `Plugin`, which is sixteen modules, not the three
 * whose filenames start with `plugins-`. `tests/settled-sweep.test.ts` asserts
 * that, so the next module to grow a plugin is covered by a test rather than
 * by somebody remembering.
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
export function onSettled(
  result: MaybeAsyncResult,
  fn: (settled: CommandResult) => CommandResult,
): MaybeAsyncResult {
  // The predicate is INLINE here rather than a call to `isThenable`, which is
  // the same test written twice in one file on purpose. `onSettled` is in the
  // budgeted Blade consumer bundle (it reaches it through `logger`), and
  // `isThenable` is not: no consumer of that bundle calls the predicate
  // directly. Calling it from here would anchor it into the import graph and
  // it measured +3 brotli there - paid by every consumer, to save a line in a
  // file that already has the rule at the top of it. Keeping the call site
  // free lets the export tree-shake away for anyone who does not use it.
  return (result != null && typeof (result as PromiseLike<CommandResult>).then === 'function')
    ? (result as Promise<CommandResult>).then(fn)
    : fn(result as CommandResult);
}
