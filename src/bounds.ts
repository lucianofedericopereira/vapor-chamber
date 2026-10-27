/**
 * vapor-chamber - the one rule for a numeric option.
 *
 * Internal. Every cap in this library is a number a caller supplies, and a
 * caller's number is frequently not one: `Number(localStorage.getItem(...))`, a
 * parsed env var, a JSON field, a form value. The failure is never loud.
 *
 * COMPARISON DIRECTION IS THE WHOLE STORY, and it decides which way a bad value
 * fails. Every comparison against NaN is false, so:
 *
 *   length < max     gate on RECORDING    NaN -> records nothing   FAILS SAFE
 *   length > max     gate on EVICTING     NaN -> evicts nothing    FAILS OPEN
 *   count >= max     gate on REFUSING     NaN -> refuses nothing   FAILS OPEN
 *
 * Two of the three are unbounded growth or a defeated guard, and they are the
 * two that are idiomatic to write: `history({ maxSize: NaN })` would keep
 * every entry, `circuitBreaker({ threshold: NaN })` would stay closed through
 * any run of failures, and `StreamParser({ maxDepth: NaN })` would never fire
 * the depth guard that exists to stop runaway nesting.
 *
 * WHY A MODULE AND NOT `Math.max(0, raw | 0)` AT EACH SITE. A rule spelled out
 * at each call site is missing wherever nobody remembered it.
 *
 * That idiom is also subtly wrong twice over. `Infinity | 0` is 0, which turns
 * "no bound" into "store nothing" - the opposite of the request. And `| 0`
 * truncates to 32 bits, so a cap of 3_000_000_000 goes negative. Here
 * `Math.trunc(Infinity)` is `Infinity` and `Math.min` carries it through, so
 * the unbounded case needs no branch of its own.
 *
 * WHY A BAD OPTION FALLS BACK TO THE DEFAULT rather than to zero. Folding NaN
 * to 0 on the argument that storing nothing is "bounded, and loud rather than
 * silent" does not hold: an outbox that queues nothing DISCARDS the commands
 * it exists to hold; `idempotent` that remembers nothing DOUBLE-EXECUTES
 * commands declared idempotent; a transition that times out in 1ms removes the
 * animation instead of the hang. None of those is louder than the unbounded
 * failure - only costlier. A NaN option is indistinguishable in intent from a
 * missing one (it is what a failed config read produces), so it behaves like a
 * missing one.
 */

/** The largest delay `setTimeout` accepts. Past it a timer fires IMMEDIATELY
 *  rather than never, turning a long backoff into no backoff at all. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Normalize a caller-supplied count, size, depth, attempt cap or delay.
 *
 * - NaN, or a value `Number()` reads as NaN (undefined, a non-numeric string,
 *   an object) -> `fallback`, the documented default. A numeric string is its
 *   number, and `null` and `false` read 0
 * - below `min`  -> `min`, which catches negatives and -Infinity together
 * - above `max`  -> `max`; left at `Infinity`, "no bound" passes through intact
 * - fractional   -> truncated toward zero
 *
 * `min` defaults to 0 because a cap of zero is meaningful (store nothing) and
 * distinct from a missing option. Sites where zero is nonsense - an attempt
 * count, a line length, a circuit threshold - pass `min: 1` and say why.
 * Delays pass `max: MAX_TIMEOUT_MS`.
 */
export function countOption(value: unknown, fallback: number, min = 0, max = Number.POSITIVE_INFINITY): number {
  const n = Number(value);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, Math.trunc(n)));
}

declare const delayBrand: unique symbol;

/**
 * A wait a timer keeps: a whole number from 0 to MAX_TIMEOUT_MS. Only
 * `delayOption` and `isDelay` make one. Every setTimeout and setInterval in
 * src takes a Delay or a number literal, and no file but this one casts to
 * it (tests/timer-delays.test.ts).
 */
export type Delay = number & { readonly [delayBrand]: true };

/**
 * A caller-supplied delay, by countOption's rule with MAX_TIMEOUT_MS as the
 * ceiling: NaN is `fallback`, a larger value the maximum. The fallback is the
 * library's own default. `undefined` as the default means "no timer" (the
 * HTTP transport's batch microtask).
 */
export function delayOption(value: unknown, fallback: number, min?: number): Delay;
export function delayOption(value: unknown, fallback: undefined, min?: number): Delay | undefined;
export function delayOption(value: unknown, fallback: number | undefined, min = 0): Delay | undefined {
  return countOption(value, fallback as number, min, MAX_TIMEOUT_MS) as Delay | undefined;
}

/**
 * True for a wait a timer can keep: a number from 0 to MAX_TIMEOUT_MS. The
 * rule every reader of a declared `retryIn` applies (the async bus's retry,
 * the outbox, a 202's poll), so the wait is checked where it is read, whoever
 * declared it. `typeof === 'number'` let NaN and Infinity through: a timer
 * fires at once on both, and the outbox re-flushed in a loop on either
 * (tests/retry-in-unusable.test.ts).
 */
export function isDelay(value: unknown): value is Delay {
  return typeof value === 'number' && value >= 0 && value <= MAX_TIMEOUT_MS;
}
