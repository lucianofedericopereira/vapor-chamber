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
 * two that are idiomatic to write. Measured through the public API before this
 * module existed: `history({ maxSize: NaN })` kept 500 entries against a cap of
 * 50, `metrics({ maxEntries: NaN })` kept 1500 against 1000,
 * `circuitBreaker({ threshold: NaN })` sat closed through 20 straight failures,
 * and `StreamParser({ maxDepth: NaN })` accepted 5,000 levels of nesting
 * without once firing the depth guard that exists to stop exactly that.
 *
 * WHY A MODULE AND NOT `Math.max(0, raw | 0)` AT EACH SITE. That idiom was
 * already applied by hand at five sites, and this sweep found seven more it had
 * never reached - the same shape as the arrow sweep that left 48 arrows in 15
 * files and the glyph sweep that left four in shipped strings. A rule spelled
 * out at each call site is a rule that is missing wherever nobody remembered it.
 *
 * It is also subtly wrong twice over. `Infinity | 0` is 0, so those five sites
 * turned "no bound" into "store nothing" - the opposite of the request. And
 * `| 0` truncates to 32 bits, so a cap of 3_000_000_000 silently went negative.
 * Both disappear here: `Math.trunc(Infinity)` is `Infinity` and `Math.min`
 * carries it through, so the unbounded case needs no branch of its own.
 *
 * ONE SITE DELIBERATELY DOES NOT USE THIS, and saying so here is the point of
 * saying it at all - an exception nobody records is just a gap. `command-bus.ts`
 * keeps its inline `| 0` for `bufferLimit`, because importing this module into
 * the one file every consumer pulls costs 50 B brotli in the minimal Blade
 * bundle `esm-treeshake.test.ts` gates, which breaches that ceiling on its own.
 * `| 0` already handles the NaN case there; what it gives up is `Infinity`,
 * recorded at that call site.
 *
 * WHY A BAD OPTION FALLS BACK TO THE DEFAULT rather than to zero. The five
 * hand-clamped sites folded NaN to 0 on the argument that storing nothing is
 * "bounded, and loud rather than silent". Written out per site, that argument
 * collapses: an outbox that queues nothing DISCARDS the commands it exists to
 * hold; `idempotent` that remembers nothing DOUBLE-EXECUTES commands declared
 * idempotent; a transition that times out in 1ms removes the animation instead
 * of the hang. None of those is louder than the unbounded failure - only
 * costlier. A NaN option is indistinguishable in intent from a missing one (it
 * is what a failed config read produces), so it now behaves like a missing one.
 */

/** The largest delay `setTimeout` accepts. Past it a timer fires IMMEDIATELY
 *  rather than never, turning a long backoff into no backoff at all. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Normalize a caller-supplied count, size, depth, attempt cap or delay.
 *
 * - NaN, or anything that is not a number -> `fallback`, the documented default
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
