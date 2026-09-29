/**
 * The wire contract (docs/plan-failures-and-contract.md 4.4), end to end, with
 * only `fetch` and the socket stubbed: each rule stated once and run on every
 * path it covers.
 *
 * - An answer is `{ state }`, `{ redirect }` or `{ problem }`; a single
 *   command's failure is its non-2xx problem. A failure reads
 *   `remote:<condition of its status>:<code>`, the same on every path.
 * - The status table says only what RFC 9110 says of a status.
 * - Retries follow the condition: a transient one, a `Retry-After`, a lost
 *   answer for an idempotent action or a keyed command. The async bus re-sends
 *   through the transport, invisibly to the plugins outside.
 * - The outbox drops a record on the backend's verdict and keeps it otherwise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, _failures, type BusError, type Command, type CommandResult } from '../src/command-bus';
import { isRetryableStatus } from '../src/http-errors';
import { conditionOfStatus, failureCondition } from '../src/command-bus';
import { createOutbox, type OutboxRecord } from '../src/outbox';
import { idempotent } from '../src/plugins-extra';
import { createBatchingHttpBridge, createHttpBridge, createWsBridge } from '../src/transports';
import { MockWebSocket, batchServer, reply, singleServer } from './backend-stubs';

type Problem = { status?: number; code?: string; detail?: string; [param: string]: unknown };
type Answer = { state?: unknown; redirect?: string; problem?: Problem };
type Path = 'single' | 'batch' | 'ws';
const PATHS: Path[] = ['single', 'batch', 'ws'];

const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Problem =>
  ({ status, code, detail: `${code} happened`, ...extra });

/** One command answered with `answer` through `path`, as the backend would send it there. */
async function through(path: Path, answer: Answer): Promise<CommandResult> {
  const bus = createAsyncCommandBus();
  if (path === 'single') {
    singleServer(() => answer.problem ? [answer.problem.status ?? 500, answer.problem] : [200, answer]);
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    return bus.dispatch('save', { id: 1 });
  }
  if (path === 'batch') {
    batchServer(() => answer);
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));
    return bus.dispatch('save', { id: 1 });
  }
  let socket!: MockWebSocket;
  vi.stubGlobal('WebSocket', class extends MockWebSocket {
    constructor(url: string) { super(url); socket = this; }
  });
  const ws = createWsBridge({ url: 'ws://test' });
  bus.use(ws);
  ws.connect();
  await Promise.resolve();
  const pending = bus.dispatch('save', { id: 1 });
  await Promise.resolve();
  const { id } = JSON.parse(socket.sent[0]!) as { id: string };
  socket.receive({ id, ...answer });
  return pending;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('an answer reads the same on every path', () => {
  for (const path of PATHS) {
    describe(path, () => {
      it('state is the value; no state is undefined (JSON drops it)', async () => {
        expect(await through(path, { state: { n: 1 } })).toSucceedWith({ n: 1 });
        expect(await through(path, {})).toSucceedWith(undefined);
      });

      it('a redirect fails the command, carrying the url', async () => {
        const result = await through(path, { redirect: '/login' });
        expect(result).toFailWith('transport:refused:redirect');
        expect((result.error as BusError).context).toMatchObject({ url: '/login' });
      });

      it('a problem is remote:<condition of its status>:<code>, detail the message, the rest context', async () => {
        const errors = [{ pointer: '/payload/email', detail: 'taken' }];
        const result = await through(path, { problem: problem(422, 'validation_failed', { errors, limit: 3 }) });
        expect(result).toFailWith('remote:invalid:validation_failed');
        expect(result.error?.message).toBe('validation_failed happened');
        expect((result.error as BusError).context).toMatchObject({ status: 422, code: 'validation_failed', errors, limit: 3 });
      });
    });
  }

  it('an empty 2xx (a 204) is a success with no value', async () => {
    singleServer(() => new Response(null, { status: 204 }));
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    expect(await bus.dispatch('save', {})).toSucceedWith(undefined);
  });

  it('a batch failure for the whole request fails every command with it', async () => {
    singleServer(() => [503, problem(503, 'unavailable')]);
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));
    for (const result of await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {})])) {
      expect(result).toFailWith('remote:limited:unavailable');
    }
  });
});

describe('the status table: only what RFC 9110 says of a status', () => {
  it('each status declares its condition', () => {
    const table: Array<[number, string]> = [
      [404, 'missing'], [410, 'missing'], [409, 'already'],
      [401, 'refused'], [403, 'refused'], [419, 'refused'],
      [429, 'limited'], [503, 'limited'], [408, 'timeout'], [504, 'timeout'],
      [501, 'unexpected'], [502, 'unexpected'], [505, 'unexpected'],
      [500, 'failed'], [599, 'failed'], [400, 'invalid'], [413, 'invalid'], [422, 'invalid'],
    ];
    for (const [status, condition] of table) expect(conditionOfStatus(status), String(status)).toBe(condition);
  });

  it('the HTTP client re-sends 408, 429 and every 5xx, and no other 4xx', () => {
    for (let status = 400; status < 600; status++) {
      expect(isRetryableStatus(status), String(status)).toBe(status === 408 || status === 429 || status >= 500);
    }
  });
});

describe('off the contract', () => {
  it("a 2xx carrying a problem on the single endpoint is that failure, by the problem's own status", async () => {
    const bus = createAsyncCommandBus();
    singleServer(() => [200, { problem: problem(409, 'in_progress') }]);
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    expect(await bus.dispatch('save', { id: 1 })).toFailWith('remote:already:in_progress');
  });

  it('a non-2xx whose body is not a problem reads by its status alone', async () => {
    singleServer(() => reply(502, '<html>bad gateway</html>', 'text/html'));
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    const result = await bus.dispatch('save', {});
    expect(result).toFailWith('remote:unexpected:http');
    expect(result.error?.message).toBe('HTTP 502');
  });

  it('a problem with no status reads unknown, and says so', async () => {
    const result = await through('batch', { problem: { code: 'odd' } });
    expect(result).toFailWith('remote:unknown:odd');
    expect(result.error?.message).toBe('The backend answered with no status.');
  });

  it('a batch that answers nothing for a command: the outcome is unknown, so it is lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { results: [] })));
    const bus = createAsyncCommandBus();
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));
    expect(await bus.dispatch('save', {})).toFailWith('transport:lost:result');
  });

  it('the bus does not re-send a command whose batch result is missing, unless it carries a key', async () => {
    const fetch = vi.fn(async () => reply(200, { results: [] }));
    vi.stubGlobal('fetch', fetch);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 } });
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));
    await bus.dispatch('save', {});
    // The backend may have run it and dropped the result: re-sending an
    // unkeyed write could run it twice.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('no response is lost; a timeout the transport\'s; an abort the dispatch\'s', async () => {
    const cases: Array<[unknown, string]> = [
      [new TypeError('Failed to fetch'), 'transport:lost:reply'],
      [Object.assign(new Error('timed out'), { name: 'TimeoutError' }), 'transport:timeout:reply'],
      [new DOMException('Aborted', 'AbortError'), 'core:aborted:dispatch'],
    ];
    for (const [thrown, code] of cases) {
      const bus = createAsyncCommandBus();
      bus.use(createHttpBridge({ endpoint: '/api/vc', httpClient: { post: vi.fn().mockRejectedValue(thrown) } as never }));
      expect(await bus.dispatch('save', {}), code).toFailWith(code);
    }
  });
});

describe('failureCondition: any failure, by contract', () => {
  it("reads a library failure, an HTTP response's status, a name, a network TypeError; the rest is failed", () => {
    const cases: Array<[unknown, string]> = [
      [_failures('core')('limited:handler', 'x'), 'limited'],
      [Object.assign(new Error('x'), { response: { status: 503 } }), 'limited'],
      [Object.assign(new Error('x'), { name: 'TimeoutError' }), 'timeout'],
      [new DOMException('x', 'AbortError'), 'aborted'],
      [new TypeError('Failed to fetch'), 'lost'],
      [new Error('a handler threw'), 'failed'],
      ['not even an error', 'failed'],
    ];
    for (const [error, condition] of cases) expect(failureCondition(error)).toBe(condition);
  });
});

/** The real single bridge on a bus with the default retry, no waits; `sent` counts the POSTs. */
function retried(answer: () => Response | [number, unknown], use: Array<unknown> = [], actions: Record<string, 'idempotent'> = {}) {
  const sent = singleServer(() => answer());
  const bus = createAsyncCommandBus({ retry: { baseDelay: 0, actions } });
  for (const p of use) bus.use(p as never);
  bus.use(createHttpBridge({ endpoint: '/api/vc' }));
  return { bus, sent };
}

/** A plugin outside the transport that counts the dispatches it sees. */
function counter() {
  const seen: string[] = [];
  const plugin = (cmd: Command, next: () => CommandResult | Promise<CommandResult>) => { seen.push(cmd.action); return next(); };
  return { plugin, seen };
}

describe('the bus re-sends through the transport by the condition', () => {
  it('does not re-send a redirect: the backend answered with a navigation, and onRedirect fires once', async () => {
    const onRedirect = vi.fn();
    const sent = singleServer(() => [200, { redirect: '/login' }]);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 } });
    bus.use(createHttpBridge({ endpoint: '/api/vc', onRedirect }));
    const result = await bus.dispatch('save', {});
    expect(result.ok).toBe(false);
    expect(sent.length).toBe(1);
    expect(onRedirect).toHaveBeenCalledTimes(1);
  });

  it('re-sends a transient answer; an uncertain one only when idempotent; never a final one', async () => {
    const counts: Array<[number, number, number]> = [
      [503, 3, 3], [429, 3, 3], [504, 3, 3], [408, 3, 3],
      [500, 1, 3], [502, 1, 3],
      [422, 1, 1], [409, 1, 1], [404, 1, 1], [403, 1, 1],
    ];
    for (const [status, plain, declared] of counts) {
      const a = retried(() => [status, problem(status, 'x')]);
      await a.bus.dispatch('save', {});
      const b = retried(() => [status, problem(status, 'x')], [], { save: 'idempotent' });
      await b.bus.dispatch('save', {});
      expect([a.sent.length, b.sent.length], String(status)).toEqual([plain, declared]);
    }
  });

  it('re-sends any status carrying Retry-After, after the wait it declares', async () => {
    vi.useFakeTimers();
    let first = true;
    const { bus, sent } = retried(() => {
      if (!first) return [200, { state: 'done' }];
      first = false;
      return new Response(JSON.stringify(problem(409, 'in_progress')), { status: 409, headers: { 'content-type': 'application/problem+json', 'retry-after': '2' } });
    });
    const pending = bus.dispatch('save', {});
    await vi.advanceTimersByTimeAsync(1999);
    expect(sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toSucceedWith('done');
  });

  it('a lost answer is re-sent only for a keyed command or an idempotent action', async () => {
    const lost = (): never => { throw new TypeError('Failed to fetch'); };
    const plain = retried(lost);
    expect(await plain.bus.dispatch('pay', {})).toFailWith('transport:lost:reply');
    expect(plain.sent.length).toBe(1);
    const keyed = retried(lost, [idempotent()]);
    await keyed.bus.dispatch('pay', {});
    expect(keyed.sent.length).toBe(3);
    const declared = retried(lost, [], { pay: 'idempotent' });
    await declared.bus.dispatch('pay', {});
    expect(declared.sent.length).toBe(3);
  });

  it('single: the outside sees one dispatch; the failure says how many sends were made', async () => {
    const sent = singleServer(() => [503, problem(503, 'unavailable')]);
    const { plugin, seen } = counter();
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 } });
    bus.use(plugin);
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    const result = await bus.dispatch('save', {});
    expect(sent.length).toBe(3);
    expect(seen).toEqual(['save']);
    expect((result.error as BusError).context?.attempts).toBe(3);
  });

  it('batch: a transient command joins the next batch, a final one settles', async () => {
    let busyLeft = 1;
    const batches: string[][] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const { commands } = JSON.parse(String(init.body)) as { commands: Array<{ id: string; command: string }> };
      batches.push(commands.map((c) => c.command));
      return reply(200, { results: commands.map((c) =>
        c.command === 'bad' ? { id: c.id, problem: problem(422, 'validation_failed') }
          : c.command === 'busy' && busyLeft-- > 0 ? { id: c.id, problem: problem(503, 'unavailable') }
            : { id: c.id, state: c.command }) });
    }));
    const { plugin, seen } = counter();
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 } });
    bus.use(plugin);
    bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));
    const [busy, bad, fine] = await Promise.all(['busy', 'bad', 'fine'].map((a) => bus.dispatch(a, {})));
    expect(busy).toSucceedWith('busy');
    expect(bad).toFailWith('remote:invalid:validation_failed');
    expect(fine).toSucceedWith('fine');
    expect(batches).toEqual([['busy', 'bad', 'fine'], ['busy']]);
    expect(seen).toEqual(['busy', 'bad', 'fine']);
  });

  it('a command the transport passes on is re-run at its handler, not at the transport', async () => {
    let calls = 0;
    const sent = singleServer(() => [200, { state: 'x' }]);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 } });
    bus.use(createHttpBridge({ endpoint: '/api/vc', actions: ['remote*'] }));
    bus.register('localSave', async () => { calls++; throw _failures('app')('limited:local', 'x'); });
    await bus.dispatch('localSave', {});
    expect(calls).toBe(3);
    expect(sent.length).toBe(0);
  });

  it('a user abort mid-flight settles at once: one request, no backoff sleep left behind', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      }));
    vi.stubGlobal('fetch', fetchMock);
    const bus = createAsyncCommandBus();
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    const ctrl = new AbortController();
    const pending = bus.dispatch('save', {}, undefined, { signal: ctrl.signal });
    await vi.advanceTimersByTimeAsync(0);
    ctrl.abort();
    const result = await pending;
    expect(result).toFailWith('core:aborted:dispatch');
    expect(vi.getTimerCount()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a handler's own throw is uncertain: re-run only when idempotent; a plugin's throw is a bug, never", async () => {
    let calls = 0;
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0, actions: { flaky: 'idempotent' } } });
    bus.register('plain', async () => { calls++; throw new Error('flaky'); });
    bus.register('flaky', async () => { calls++; throw new Error('flaky'); });
    await bus.dispatch('plain', {});
    expect(calls).toBe(1);
    calls = 0;
    await bus.dispatch('flaky', {});
    expect(calls).toBe(3);

    let pluginCalls = 0;
    const withBug = createAsyncCommandBus({ retry: { baseDelay: 0 } });
    withBug.use(() => { pluginCalls++; throw new Error('bug'); });
    withBug.register('x', async () => 'x');
    expect(await withBug.dispatch('x', {})).toFailWith('plugin:failed:plugin');
    expect(pluginCalls).toBe(1);

    // A fresh bus: the budget above is half spent.
    calls = 0;
    const fresh = createAsyncCommandBus({ retry: { baseDelay: 0 } });
    fresh.register('busy', async () => { calls++; throw _failures('app')('limited:quota', 'busy'); });
    expect(await fresh.dispatch('busy', {})).toFailWith('app:limited:quota');
    expect(calls).toBe(3);
  });
});

/** Queue `actions` offline, then come back online; `rejected` collects outboxRejected. */
async function queued(answer: (command: string) => Answer, actions: string[], options: Parameters<typeof createOutbox>[0] = {}) {
  let online = false;
  let data: OutboxRecord[] | null = null;
  const storage = { load: () => data?.slice() ?? null, save: (r: OutboxRecord[]) => { data = r.slice(); }, clear: () => { data = null; } };
  const outbox = createOutbox({ storage, isOnline: () => online, autoFlush: false, ...options });
  const bus = createAsyncCommandBus();
  outbox.install(bus);
  batchServer((command) => answer(command));
  bus.use(createBatchingHttpBridge({ endpoint: '/api/vc/batch' }));
  for (const action of actions) await bus.dispatch(action, { action });
  online = true;
  const rejected: Array<{ record: OutboxRecord; error: BusError }> = [];
  bus.on('outboxRejected', (cmd) => rejected.push(cmd.target));
  return { outbox, rejected };
}

describe('the outbox drops a record on the backend\'s verdict, and only then', () => {
  it('a 4xx verdict is rejected and reported; the rest replay behind it', async () => {
    const { outbox, rejected } = await queued((c) => (c === 'orderBad' ? { problem: problem(422, 'validation_failed') } : { state: 'saved' }), ['orderBad', 'orderA', 'orderB']);
    expect(await outbox.flush()).toEqual({ replayed: 2, failed: 0, rejected: 1 });
    expect(rejected.map((r) => [r.record.action, r.error.code])).toEqual([['orderBad', 'remote:invalid:validation_failed']]);
  });

  it('a 422 from the single endpoint is rejected the same way', async () => {
    let online = false;
    let data: OutboxRecord[] | null = null;
    const storage = { load: () => data?.slice() ?? null, save: (r: OutboxRecord[]) => { data = r.slice(); }, clear: () => { data = null; } };
    const outbox = createOutbox({ storage, isOnline: () => online, autoFlush: false });
    const bus = createAsyncCommandBus();
    outbox.install(bus);
    singleServer((command) => command === 'orderBad' ? [422, problem(422, 'validation_failed')] : [200, { state: command }]);
    bus.use(createHttpBridge({ endpoint: '/api/vc' }));
    await bus.dispatch('orderBad', {});
    await bus.dispatch('orderAfter', {});
    online = true;
    const rejected: string[] = [];
    bus.on('outboxRejected', (cmd) => rejected.push((cmd.target as { error: BusError }).error.code));
    expect(await outbox.flush()).toEqual({ replayed: 1, failed: 0, rejected: 1 });
    expect(rejected).toEqual(['remote:invalid:validation_failed']);
    expect(outbox.pending.value).toBe(0);
  });

  it('a kept record blocks the ones behind it, and the next flush drains them in order', async () => {
    let down = true;
    const order: string[] = [];
    const { outbox } = await queued((c) => { order.push(c); return down ? { problem: problem(503, 'maintenance') } : { state: 1 }; }, ['orderA', 'orderB']);
    order.length = 0;
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(order).toEqual(['orderA']);
    down = false;
    expect(await outbox.flush()).toEqual({ replayed: 2, failed: 0, rejected: 0 });
    expect(order).toEqual(['orderA', 'orderA', 'orderB']);
  });

  it('a transient answer, a server failure and an expired session keep the record, in order', async () => {
    for (const status of [503, 500, 401, 419]) {
      const { outbox, rejected } = await queued(() => ({ problem: problem(status, 'x') }), ['orderA', 'orderB']);
      expect(await outbox.flush(), String(status)).toEqual({ replayed: 0, failed: 1, rejected: 0 });
      expect(outbox.pending.value).toBe(2);
      expect(rejected).toEqual([]);
    }
  });

  it('a kept record is flushed again after the Retry-After its answer declared; dispose() ends the wait', async () => {
    for (const disposeFirst of [false, true]) {
      vi.useFakeTimers();
      let busy = true;
      const sent = singleServer(() => {
        if (!busy) return [200, { state: 1 }];
        return new Response(JSON.stringify(problem(503, 'unavailable')), {
          status: 503, headers: { 'content-type': 'application/problem+json', 'retry-after': '1' },
        });
      });
      let online = false;
      const storage = { load: () => null, save: () => {}, clear: () => {} };
      const outbox = createOutbox({ storage, isOnline: () => online });
      const bus = createAsyncCommandBus();
      outbox.install(bus);
      bus.use(createHttpBridge({ endpoint: '/api/vc' }));
      await bus.dispatch('orderA', {});
      online = true;

      expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
      busy = false;
      if (disposeFirst) outbox.dispose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent.length, String(disposeFirst)).toBe(disposeFirst ? 1 : 2);
      expect(outbox.pending.value).toBe(disposeFirst ? 1 : 0);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('the app decides per record, in its own codes', async () => {
    const isRetryable = vi.fn((error: Error, record: OutboxRecord) =>
      (error as BusError).code === 'remote:already:in_progress' && record.action === 'orderLocked');
    const { outbox } = await queued((c) => ({ problem: c === 'orderLocked' ? problem(409, 'in_progress') : problem(422, 'bad') }), ['orderBad', 'orderLocked', 'orderAfter'], { isRetryable });
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 1 });
    expect(isRetryable.mock.calls.map(([, record]) => record.action)).toEqual(['orderBad', 'orderLocked']);
  });
});
