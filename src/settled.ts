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
 */

import type { CommandResult } from './command-bus';

/** A result, or the promise of one - what `next()` actually returns. */
export type MaybeAsyncResult = CommandResult | Promise<CommandResult>;

/**
 * Run `fn` once the result is real, and PRESERVE SYNC-NESS: a sync `next()`
 * stays sync, so a plugin on the sync bus is byte-for-byte the same behaviour
 * it had before. Only the async arm is new.
 */
export function onSettled(
  result: MaybeAsyncResult,
  fn: (settled: CommandResult) => CommandResult,
): MaybeAsyncResult {
  return result != null && typeof (result as PromiseLike<CommandResult>).then === 'function'
    ? (result as Promise<CommandResult>).then(fn)
    : fn(result as CommandResult);
}
