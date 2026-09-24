/**
 * FIXTURE - the backend's `code` survives a failure that arrives as DATA.
 *
 * WHY THIS FILE EXISTS. Both HTTP bridges enriched an error when the failure
 * THREW and built a bare one when the same failure arrived as an envelope,
 * twelve lines apart in the same function. `postCommand` throws an HttpError
 * on a non-2xx with the parsed body attached, and the catch path copies
 * `status`, `code` and `response` off it. A 200 carrying `{ ok: false, code }`
 * throws nothing, so the envelope path built `new Error(body.error)` and the
 * code was read by nobody.
 *
 * That is not a missing feature. `examples/laravel-backend/VaporChamberController.php`
 * sends the field and its `fail()` docblock promises it arrives as
 * `HttpError.code`. On the batch path the promise was false twice over:
 * `batch()` answers 200 with per-command status in the body, so nothing throws,
 * so no HttpError is ever built.
 *
 * Raised by the first alpha consumer against v1.22.0.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function httpBus() {
  const bus = createAsyncCommandBus();
  bus.use(createHttpBridge({ endpoint: '/api/vc' }));
  return bus;
}

function batchBus() {
  const bus = createAsyncCommandBus();
  bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));
  return bus;
}

type Coded = Error & { code?: string; status?: number };

describe('the backend code survives an envelope failure', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('createHttpBridge: a 200 carrying { ok: false, code } delivers the code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json(200, { ok: false, error: 'Out of stock', code: 'stock_depleted' })));

    const result = await httpBus().dispatch('cartAdd', { id: 1 });

    expect(result.ok).toBe(false);
    const err = result.error as Coded;
    expect(err.message).toBe('Out of stock');
    expect(err.code).toBe('stock_depleted');
  });

  it('createBatchingHttpBridge: each failed result carries its own code', async () => {
    // The bridge mints its own ids, so the stub echoes back the ones it was
    // sent. A stub that invents ids takes the missing-result path instead and
    // passes for the wrong reason - which is how the first draft of this test
    // reported both codes undefined.
    const byAction: Record<string, [string, string]> = {
      cartAdd: ['Out of stock', 'stock_depleted'],
      payCharge: ['Card declined', 'payment_refused'],
    };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { commands: { id: string; command: string }[] };
      return json(200, {
        results: sent.commands.map((c) => {
          const [error, code] = byAction[c.command] as [string, string];
          return { id: c.id, ok: false, error, code };
        }),
      });
    }));

    const bus = batchBus();
    const [a, b] = await Promise.all([
      bus.dispatch('cartAdd', { id: 1 }),
      bus.dispatch('payCharge', { id: 2 }),
    ]);

    // Per-result, not one shared error: the codes must not be interchangeable.
    const codes = [a, b].map((r) => (r.error as Coded).code).sort();
    expect(codes).toEqual(['payment_refused', 'stock_depleted']);
  });

  /**
   * SECOND CONTROL, and it is labelled that way after the fact.
   *
   * This was written to cover the bridge's `!res.ok` branch, on the assumption
   * that `postCommand` resolves rather than throws for some non-2xx shapes -
   * it does return `{ ok: raw.ok }`. But a 503 THROWS, so this drives the
   * catch path, which has copied `code` since v1.20.0. It passed against the
   * pre-fix module, which is how the mislabel surfaced.
   *
   * Left in as a control rather than deleted: it pins that a 5xx keeps
   * delivering both fields. The `!res.ok` branch does carry `code` now and is
   * covered elsewhere, but NOT discriminated by this file - no assertion here
   * would fail if that one line were reverted.
   */
  it('CONTROL: a 5xx delivers both code and status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json(503, { error: 'Upstream down', code: 'upstream_unavailable' })));

    const result = await httpBus().dispatch('cartAdd', { id: 1 });

    expect(result.ok).toBe(false);
    const err = result.error as Coded;
    expect(err.code).toBe('upstream_unavailable');
    expect(err.status).toBe(503);
  });

  /**
   * POSITIVE CONTROL. A negative result is only evidence if the same probe
   * fires where it must: this asserts the THROW path still carries the code,
   * in the same file and through the same harness, so a fix that quietly broke
   * the path that already worked cannot pass by making the tests above green.
   */
  it('CONTROL: the throw path still carries the code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json(422, { ok: false, error: 'Invalid', code: 'validation_failed' })));

    const result = await httpBus().dispatch('orderPlace', { id: 1 });

    const err = result.error as Coded;
    expect(err.code).toBe('validation_failed');
    expect(err.status).toBe(422);
  });

  /**
   * Deliberately NOT asserted above: `error.status` on the envelope cases.
   *
   * On that path the response really is 200. `status` is not a field being
   * dropped, it is a field that does not exist, so asserting it would fail
   * after a correct fix and read as the fix being incomplete. The consumer who
   * raised this proposed exactly that assertion and withdrew it; recorded here
   * so nobody re-adds it.
   *
   * It is also why this change does NOT close the retry hole. `defaultIsRetryable`
   * reads `e.status ?? e.response?.status`, finds neither on an envelope error,
   * and returns true - so a batched 422 is still re-sent. Closing that needs the
   * status contract, which changes a documented shape and is its own step.
   */
  it('an envelope error carries no status, and that is the point', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      json(200, { ok: false, error: 'Out of stock', code: 'stock_depleted' })));

    const result = await httpBus().dispatch('cartAdd', { id: 1 });

    expect((result.error as Coded).status).toBeUndefined();
  });
});
