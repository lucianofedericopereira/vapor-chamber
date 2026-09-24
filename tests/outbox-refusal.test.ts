/**
 * The outbox and a command the SERVER refuses.
 *
 * `runFlush` stopped at the first failure of any kind and kept that record at
 * the head, which is right for a transient failure (order is preserved and the
 * next flush tries again) and wrong for a refusal: the server has already
 * answered, so every later flush re-sends the same record, gets the same
 * answer, and the commands queued behind it never leave. Measured on v1.23.0
 * before this fix, with the reference controller's batch shape:
 *
 *   flush 1: { replayed: 0, failed: 1 } pending 3
 *   flush 2: { replayed: 0, failed: 1 } pending 3
 *   flush 3: { replayed: 0, failed: 1 } pending 3
 *
 * The only way out was `clear()`, which drops the good records too.
 *
 * Whether a failure is final is the APP's call, and the library already has
 * one answer for it: the default predicate `retry()` uses. So the outbox asks
 * the same question with the same default, and takes the app's own
 * `isRetryable` when it is given one. A retryable failure keeps blocking,
 * exactly as before; a final one is dropped, reported as `'outboxRejected'`
 * with the record and the error, and the flush moves on.
 *
 * Every case goes through a real bridge with only `fetch` stubbed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { createOutbox } from '../src/outbox';
import type { OutboxRecord } from '../src/outbox';
import { createBatchingHttpBridge, createHttpBridge } from '../src/transports';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function memoryStorage() {
  let data: OutboxRecord[] | null = null;
  return {
    load: () => (data ? data.slice() : null),
    save: (records: OutboxRecord[]) => { data = records.slice(); },
    clear: () => { data = null; },
    get data() { return data; },
  };
}

/** Queue `actions` while offline, then come back online. */
async function queued(bridge: 'batch' | 'single', actions: string[], options: Parameters<typeof createOutbox>[0] = {}) {
  let online = false;
  const storage = memoryStorage();
  const outbox = createOutbox({ storage, isOnline: () => online, autoFlush: false, ...options });
  const bus = createAsyncCommandBus();
  outbox.install(bus);
  bus.use(bridge === 'batch'
    ? createBatchingHttpBridge({ endpoint: '/api/vc/batch' })
    : createHttpBridge({ endpoint: '/api/vc' }));
  for (const action of actions) await bus.dispatch(action, { action });
  online = true;
  const rejected: Array<{ record: OutboxRecord; error: Error & { code?: string } }> = [];
  bus.on('outboxRejected', (cmd) => rejected.push(cmd.target));
  return { outbox, bus, storage, rejected };
}

/** The reference controller's `batch()`: one 200, a result per command. */
function batchServer(answer: (command: string) => Record<string, unknown>) {
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const { commands } = JSON.parse(init.body as string);
    for (const c of commands) sent.push(c.command);
    return json(200, { results: commands.map((c: { id: string; command: string }) => ({ id: c.id, ...answer(c.command) })) });
  });
  return sent;
}

/** The reference controller's `__invoke`: the command's own status. */
function singleServer(answer: (command: string) => [number, Record<string, unknown>]) {
  const sent: string[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const { command } = JSON.parse(init.body as string);
    sent.push(command);
    const [status, body] = answer(command);
    return json(status, body);
  });
  return sent;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a refused record does not block the queue', () => {
  it('batched refusal at the head: rejected, reported, and the rest replay', async () => {
    batchServer((command) => command === 'orderBad'
      ? { ok: false, error: 'title required', code: 'validation_failed' }
      : { ok: true, state: 'saved' });
    const { outbox, storage, rejected } = await queued('batch', ['orderBad', 'orderA', 'orderB']);

    const summary = await outbox.flush();

    expect(summary).toEqual({ replayed: 2, failed: 0, rejected: 1 });
    expect(outbox.pending.value).toBe(0);
    expect(storage.data).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].record.action).toBe('orderBad');
    expect(rejected[0].error.code).toBe('validation_failed');
  });

  it('a 422 from the single-command endpoint is rejected the same way', async () => {
    singleServer((command) => command === 'orderBad'
      ? [422, { ok: false, error: 'title required', code: 'validation_failed' }]
      : [200, { ok: true, state: 'saved' }]);
    const { outbox, rejected } = await queued('single', ['orderBad', 'orderA']);

    expect(await outbox.flush()).toEqual({ replayed: 1, failed: 0, rejected: 1 });
    expect(rejected[0].error.message).toBe('title required');
  });

  it('CONTROL: a transient failure still blocks, in order, and the next flush drains', async () => {
    let down = true;
    const sent = singleServer(() => (down ? [503, { ok: false, error: 'maintenance' }] : [200, { ok: true, state: 1 }]));
    const { outbox, storage, rejected } = await queued('single', ['orderA', 'orderB']);

    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(sent).toEqual(['orderA']);                               // orderB never overtook it
    expect(storage.data!.map((r) => r.action)).toEqual(['orderA', 'orderB']);
    expect(rejected).toEqual([]);

    down = false;
    expect(await outbox.flush()).toEqual({ replayed: 2, failed: 0, rejected: 0 });
  });
});

describe('the default keeps what a later flush can still fix', () => {
  it.each([
    [401, 'session expired - the user signs in and the flush goes through'],
    [429, 'rate limited - later is the whole point'],
    [500, 'server error - transient by definition'],
  ])('a %i is kept at the head (%s)', async (status) => {
    singleServer(() => [status, { ok: false, error: 'not now' }]);
    const { outbox, rejected } = await queued('single', ['orderA', 'orderB']);

    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(outbox.pending.value).toBe(2);
    expect(rejected).toEqual([]);
  });
});

describe('the app decides what is final', () => {
  it('isRetryable: () => true keeps every failure blocking, the pre-fix behaviour', async () => {
    batchServer(() => ({ ok: false, error: 'nope', code: 'validation_failed' }));
    const { outbox } = await queued('batch', ['orderBad', 'orderA'], { isRetryable: () => true });

    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(outbox.pending.value).toBe(2);
  });

  it("isRetryable sees the record, so the policy can be per action and in the app's own codes", async () => {
    batchServer((command) => command === 'orderLocked'
      ? { ok: false, error: 'try later', code: 'in_progress' }
      : { ok: false, error: 'nope', code: 'validation_failed' });
    const isRetryable = vi.fn((error: Error & { code?: string }, record: OutboxRecord) =>
      error.code === 'in_progress' && record.action === 'orderLocked');
    const { outbox } = await queued('batch', ['orderBad', 'orderLocked', 'orderAfter'], { isRetryable });

    // orderBad is final and dropped; orderLocked is retryable and blocks.
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 1 });
    expect(outbox.pending.value).toBe(2);
    expect(isRetryable.mock.calls.map(([, record]) => record.action)).toEqual(['orderBad', 'orderLocked']);
  });
});
