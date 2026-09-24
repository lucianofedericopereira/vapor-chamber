/**
 * FIXTURE - `.code` on a transport error has ONE owner, and it is the backend.
 *
 * WHY THIS FILE EXISTS. `defaultIsRetryable` read a `VC_` prefix on `.code` as
 * proof the library had minted it, while both HTTP bridges copied the BACKEND's
 * body code into that same field. So a backend chose which branch of the
 * predicate ran. Sending `code: 'VC_CORE_THROTTLED'` re-sent a 422 the HTTP
 * layer had already refused to re-send; sending `code: 'VC_VALIDATION_FAILED'`
 * suppressed the retry of a 503. Neither needed a hostile backend - `VC_` is a
 * convention nobody polices, and this repo has two other classes using it
 * (`BusError`, and `VcTestError` in `src/vitest-pure.ts`).
 *
 * The fix does not move `.code`. It stops asking `.code` a question `.code`
 * cannot answer: provenance comes from `emitter`, which `BusError`'s
 * constructor has always set, which no transport copies a body field into, and
 * which no backend would think to send - a backend has no reason to claim to be
 * a subsystem of this library, where `code` was always a plausible wire field.
 *
 * The library's own transport failures are `BusError`s carrying our codes. A
 * backend's refusal inside a 2xx is a plain Error carrying the BACKEND's code
 * and the same `emitter` tag - which is enough, because the rule is "retried
 * only if the code is one of RETRYABLE_CODES' six" and a backend code is not.
 * No verdict field, and the residue that leaves is pinned at the end of this
 * file.
 *
 * Counted in fetch calls rather than in fields, because an attempt count is what
 * the defect cost: every assertion below is a number of HTTP requests a consumer
 * paid for.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, RETRYABLE_CODES } from '../src/command-bus';
import { retry } from '../src/plugins-io';
import { createHttpBridge } from '../src/transports';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A bus with retry() in front of the bridge, and the fetch stub it drives. */
function retryingBus(status: number, body: unknown) {
  const fetchStub = vi.fn(async () => json(status, body));
  vi.stubGlobal('fetch', fetchStub);
  const bus = createAsyncCommandBus();
  // baseDelay 0: this measures attempt COUNTS, not backoff.
  bus.use(retry({ maxAttempts: 3, baseDelay: 0 }));
  bus.use(createHttpBridge({ endpoint: '/api/vc' }));
  return { bus, fetchStub };
}

type Coded = Error & { code?: string; emitter?: string };

describe('a transport error has one owner per field', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The backend received, processed and refused, and said so in a 200 body. That
   * is not a transient transport failure, so re-sending cannot change it.
   *
   * This is the hole `tests/envelope-code.test.ts` left open on purpose and
   * recorded: an envelope error carries no `status`, so the status rule never
   * ran and the fallback ("every other error is retried") did. It is closed here
   * WITHOUT stamping a status the response did not have. The transport tags the
   * refusal `emitter: 'transport'`, because it is the layer that knows the
   * refusal arrived in a 2xx, and the existing code rule does the rest.
   */
  it('a refusal inside a 2xx is not re-sent', async () => {
    const { bus, fetchStub } = retryingBus(200, { ok: false, error: 'Out of stock', code: 'stock_depleted' });

    const result = await bus.dispatch('cartAdd', { id: 1 });

    expect(result.ok).toBe(false);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    // And the backend's own code still arrives - the v1.23.0 contract stands.
    expect((result.error as Coded).code).toBe('stock_depleted');
  });

  /**
   * A backend that answers `{ redirect }` with no `onRedirect` configured will
   * answer the same way every time. This was retried to exhaustion because the
   * error the bridge built for it carried no code at all - one of seven
   * library-minted transport failures that were indistinguishable from an
   * unclassified error.
   */
  it('an unhandled backend redirect is not re-sent, and says what it was', async () => {
    const { bus, fetchStub } = retryingBus(200, { redirect: '/login' });

    const result = await bus.dispatch('cartAdd', { id: 1 });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const err = result.error as Coded;
    expect(err.code).toBe('VC_TRANSPORT_REDIRECT');
    expect(err.emitter).toBe('transport');
  });

  /**
   * The two-owner defect itself, in both directions. A backend string in `.code`
   * must not reach the library's retryable-code set, so the status rule below it
   * decides - which is what it was always meant to do.
   */
  it('a backend code beginning VC_ no longer overrules the status rule', async () => {
    const throttled = retryingBus(422, { ok: false, error: 'Invalid', code: 'VC_CORE_THROTTLED' });
    await throttled.bus.dispatch('orderPlace', { id: 1 });
    // 422: the HTTP layer's own verdict that re-sending cannot help.
    expect(throttled.fetchStub).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    const rejected = retryingBus(503, { error: 'Upstream down', code: 'VC_VALIDATION_FAILED' });
    await rejected.bus.dispatch('orderPlace', { id: 2 });
    // 503: retryable by isRetryableStatus, and no longer suppressible from the wire.
    expect(rejected.fetchStub).toHaveBeenCalledTimes(3);
  });

  /**
   * POSITIVE CONTROL. Every count above is a claim about the predicate, and a
   * count only proves that if the same harness produces DIFFERENT counts where
   * it must. Same bus, same stub, same predicate, no `code` at all: the status
   * rule decides, 503 retried and 422 not. If either of these moves, the numbers
   * above are measuring the harness.
   */
  it('CONTROL: with no code, the status rule still decides', async () => {
    const transient = retryingBus(503, { error: 'Upstream down' });
    await transient.bus.dispatch('orderPlace', { id: 1 });
    expect(transient.fetchStub).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();

    const permanent = retryingBus(422, { ok: false, error: 'Invalid' });
    await permanent.bus.dispatch('orderPlace', { id: 2 });
    expect(permanent.fetchStub).toHaveBeenCalledTimes(1);
  });

  /**
   * SECOND CONTROL, and the one that discriminates the mechanism rather than the
   * outcome. A library-minted transport failure that IS transient must still be
   * retried: the fix must not have turned `emitter: 'transport'` into a blanket
   * "never retry", which would pass the first three assertions for the wrong
   * reason. `RETRYABLE_CODES` decides, as it does for every core code.
   */
  it('CONTROL: a transport failure with a retryable code is still retried', async () => {
    const { bus, fetchStub } = retryingBus(503, { error: 'Upstream down' });
    // A 503 reaches the catch path as an HttpError with status 503 and no
    // emitter, so this pins the OTHER arm: the status rule, untouched.
    await bus.dispatch('orderPlace', { id: 1 });
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  /**
   * THE RESIDUE, pinned so it is a known quantity rather than a surprise.
   *
   * A 2xx refusal is tagged `emitter: 'transport'` while its `.code` stays the
   * BACKEND's, so `RETRYABLE_CODES.has(code)` is asked about a string the
   * backend chose. Seven strings collide. This is what one of them does.
   *
   * It is strictly smaller than what it replaces: the `VC_` prefix matched an
   * unbounded set and went both ways, and before this change EVERY 2xx refusal
   * was retried. Closing it completely needs a field the backend cannot write,
   * which is the `retryable` boolean this deliberately does not have - see the
   * note on `backendError`.
   */
  it('RESIDUE: a 2xx refusal whose code collides with a retryable one is re-sent', async () => {
    const { bus, fetchStub } = retryingBus(200, { ok: false, error: 'Slow down', code: 'VC_CORE_THROTTLED' });

    await bus.dispatch('cartAdd', { id: 1 });

    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  /**
   * THE RESIDUE IS EXACTLY `RETRYABLE_CODES`, enumerated from the set itself
   * rather than from a number in a comment.
   *
   * Two things this pins that prose cannot. Every member collides, so nobody can
   * add one believing it is inert - the set is a wire-facing surface now, which is
   * the note on its declaration. And every NON-member does not, so the mechanism
   * is shown to be reading the set rather than refusing or retrying wholesale.
   *
   * It also makes the size self-correcting: add a code to RETRYABLE_CODES and this
   * test covers it without being edited, which is the difference between a pinned
   * invariant and a remembered one.
   */
  it('RESIDUE: the colliding strings are exactly RETRYABLE_CODES, and no others', async () => {
    const attemptsFor = async (code: string) => {
      const { bus, fetchStub } = retryingBus(200, { ok: false, error: 'refused', code });
      await bus.dispatch('cartAdd', { id: 1 });
      vi.unstubAllGlobals();
      return fetchStub.mock.calls.length;
    };

    const collide: string[] = [];
    for (const code of RETRYABLE_CODES) {
      if ((await attemptsFor(code)) > 1) collide.push(code);
    }
    expect(collide.sort()).toEqual([...RETRYABLE_CODES].sort());

    // The control, and it is the half that proves the set is being read: a
    // library-shaped code that is NOT in the set, a permanent one that is in the
    // registry, and an ordinary business code all stay at one attempt.
    for (const code of ['VC_CORE_HANDLER_THREW', 'VC_VALIDATION_FAILED', 'stock_depleted']) {
      expect(await attemptsFor(code), `${code} must not collide`).toBe(1);
    }
  });

  /**
   * And the reason `VC_CORE_HANDLER_THREW` appears in that control rather than in
   * the set above: it was IN `RETRYABLE_CODES` until v1.23.0 while being minted by
   * no site in `src/`, so it was a collision surface that nothing could ever have
   * used legitimately. Removing it took the residue from seven strings to six and
   * MEASURED -24 B raw in all three IIFEs. This asserts the removal from the
   * consumer's side - the set no longer contains it - so a re-add fails here as
   * well as in the control above.
   */
  it('a code nothing mints is not a retryable code', () => {
    expect(RETRYABLE_CODES.has('VC_CORE_HANDLER_THREW')).toBe(false);
    expect(RETRYABLE_CODES.size).toBe(6);
  });

  /**
   * The first rule tests that an `emitter` PROPERTY is present, not that the
   * error is a `BusError`, and a handler's throw reaches `result.error`
   * unwrapped (`tryCatchHandler` is `catch (e) { return errResult(e as Error) }`).
   * So a handler can take the library branch. Asserted rather than defended
   * against - the handler author is whoever configured `retry()` - but asserted,
   * because the docblock claims it and an unchecked claim is how `.code` drifted.
   */
  it('a handler throwing an object with an emitter takes the library branch', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 3, baseDelay: 0 }));
    let calls = 0;
    bus.register('domainThing', () => {
      calls++;
      throw Object.assign(new Error('nope'), { emitter: 'core', code: 'VC_VALIDATION_FAILED' });
    });

    const result = await bus.dispatch('domainThing', { id: 1 });

    expect(result.ok).toBe(false);
    // Not in RETRYABLE_CODES, so one attempt. Without the emitter it would have
    // taken the status rule, found none, and run three times.
    expect(calls).toBe(1);
  });

  /**
   * The same shape with a code that IS in RETRYABLE_CODES, so the branch is
   * shown to be reading the set rather than refusing everything it recognises.
   */
  it('CONTROL: the same route with a retryable code runs every attempt', async () => {
    const bus = createAsyncCommandBus();
    bus.use(retry({ maxAttempts: 3, baseDelay: 0 }));
    let calls = 0;
    bus.register('domainThing', () => {
      calls++;
      throw Object.assign(new Error('busy'), { emitter: 'core', code: 'VC_CORE_THROTTLED' });
    });

    await bus.dispatch('domainThing', { id: 1 });

    expect(calls).toBe(3);
  });
});
