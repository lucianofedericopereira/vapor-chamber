/**
 * The wire contract (docs/contract.md 4), end to end, with
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
 * - The files in contract/ replay against the client over a real server:
 *   the request it sends, then what the app sees.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Accepted } from '../src/accepted';
import { createAsyncCommandBus, _failures, type BusError, type Command, type CommandResult } from '../src/command-bus';
import { isRetryableStatus } from '../src/http-errors';
import { conditionOf, conditionOfStatus, failureCondition, RETRYABLE_CONDITIONS } from '../src/command-bus';
import { createFormBus } from '../src/form';
import { createOutbox, type OutboxRecord } from '../src/outbox';
import { idempotent } from '../src/plugins-extra';
import { defineChamberStore } from '../src/store';
import { httpTransport, wsTransport } from '../src/transports';
import { cases } from '../scripts/contract-cases.mjs';
import { MockWebSocket, batchServer, reply, singleServer } from './backend-stubs';

type Problem = { status?: number; code?: string; detail?: string; [param: string]: unknown };
type Answer = { state?: unknown; redirect?: string; problem?: Problem };
type Path = 'single' | 'batch' | 'ws';
const PATHS: Path[] = ['single', 'batch', 'ws'];

const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Problem =>
  ({ status, code, detail: `${code} happened`, ...extra });

/** One command answered with `answer` through `path`, as the backend would send it there. */
async function through(path: Path, answer: Answer): Promise<CommandResult> {
  if (path === 'single') {
    singleServer(() => answer.problem ? [answer.problem.status ?? 500, answer.problem] : [200, answer]);
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }) });
    return bus.dispatch('save', { id: 1 });
  }
  if (path === 'batch') {
    batchServer(() => answer);
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', batch: {} }) });
    return bus.dispatch('save', { id: 1 });
  }
  let socket!: MockWebSocket;
  vi.stubGlobal('WebSocket', class extends MockWebSocket {
    constructor(url: string) { super(url); socket = this; }
  });
  const ws = wsTransport({ url: 'ws://test' });
  const bus = createAsyncCommandBus({ transport: ws });
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
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }) });
    expect(await bus.dispatch('save', {})).toSucceedWith(undefined);
  });

  it('a batch failure for the whole request fails every command with it', async () => {
    singleServer(() => [503, problem(503, 'unavailable')]);
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', batch: {} }) });
    for (const result of await Promise.all([bus.dispatch('a', {}), bus.dispatch('b', {})])) {
      expect(result).toFailWith('remote:limited:unavailable');
    }
  });
});

describe('the status table: only what RFC 9110 says of a status', () => {
  it('each status declares its condition', () => {
    const table: Array<[number, string]> = [
      [404, 'missing'], [410, 'missing'], [409, 'conflict'], [412, 'conflict'],
      [401, 'unauthenticated'], [419, 'unauthenticated'], [403, 'refused'],
      [429, 'limited'], [503, 'limited'], [408, 'timeout'], [504, 'timeout'],
      [501, 'unexpected'], [502, 'unexpected'], [505, 'unexpected'],
      [500, 'failed'], [599, 'failed'], [400, 'invalid'], [413, 'invalid'], [422, 'invalid'],
    ];
    for (const [status, condition] of table) expect(conditionOfStatus(status), String(status)).toBe(condition);
  });

  it('the two conditions from gRPC are in the vocabulary, final by default', () => {
    // unauthenticated (sign in, then retry) split from refused; conflict (the
    // state changed underneath) split from already (it exists).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fail = _failures('test');
    const a = fail('unauthenticated:session', 'sign in');
    const b = fail('conflict:version', 'changed underneath');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect([conditionOf(a), conditionOf(b)]).toEqual(['unauthenticated', 'conflict']);
    expect(RETRYABLE_CONDITIONS.has('unauthenticated') || RETRYABLE_CONDITIONS.has('conflict')).toBe(false);
  });

  it('the HTTP client re-sends 408, 429 and every 5xx, and no other 4xx', () => {
    for (let status = 400; status < 600; status++) {
      expect(isRetryableStatus(status), String(status)).toBe(status === 408 || status === 429 || status >= 500);
    }
  });
});

describe('off the contract', () => {
  it("a 2xx carrying a problem on the single endpoint is that failure, by the problem's own status", async () => {
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }) });
    singleServer(() => [200, { problem: problem(409, 'in_progress') }]);
    expect(await bus.dispatch('save', { id: 1 })).toFailWith('remote:conflict:in_progress');
  });

  it('a non-2xx whose body is not a problem reads by its status alone', async () => {
    singleServer(() => reply(502, '<html>bad gateway</html>', 'text/html'));
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }) });
    const result = await bus.dispatch('save', {});
    expect(result).toFailWith('remote:unexpected:http');
    expect(result.error?.message).toBe('HTTP 502');
  });

  it("Laravel's origin refusal (useOriginOnly, 403 { message }) is remote:refused:problem, sent once", async () => {
    const sent = singleServer(() => [403, { message: 'Origin mismatch.' }]);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 }, transport: httpTransport({ endpoint: '/api/vc', csrf: true }) });
    expect(await bus.dispatch('save', {})).toFailWith('remote:refused:problem');
    expect(sent).toHaveLength(1);
  });

  it('a problem with no status reads unknown, and says so', async () => {
    const result = await through('batch', { problem: { code: 'odd' } });
    expect(result).toFailWith('remote:unknown:odd');
    expect(result.error?.message).toBe('The backend answered with no status.');
  });

  it('a batch that answers nothing for a command: the outcome is unknown, so it is lost', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { results: [] })));
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', batch: {} }) });
    expect(await bus.dispatch('save', {})).toFailWith('transport:lost:result');
  });

  it('the bus does not re-send a command whose batch result is missing, unless it carries a key', async () => {
    const fetch = vi.fn(async () => reply(200, { results: [] }));
    vi.stubGlobal('fetch', fetch);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 }, transport: httpTransport({ endpoint: '/api/vc/batch', batch: {} }) });
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
      const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc', httpClient: { post: vi.fn().mockRejectedValue(thrown) } as never }) });
      expect(await bus.dispatch('save', {}), code).toFailWith(code);
    }
  });
});

describe('failureCondition: any failure, by contract', () => {
  it("reads a library failure, an HTTP response's status, a name, a network TypeError; the rest is failed", () => {
    const cases: Array<[unknown, string]> = [
      [_failures('pace')('limited:dispatch', 'x'), 'limited'],
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
  const bus = createAsyncCommandBus({ retry: { baseDelay: 0, actionPolicies: actions }, transport: httpTransport({ endpoint: '/api/vc' }) });
  for (const p of use) bus.use(p as never);
  return { bus, sent };
}

/** A plugin outside the transport that counts the dispatches it sees. */
function counter() {
  const seen: string[] = [];
  const plugin = { started: (cmd: Command) => { seen.push(cmd.action); } };
  return { plugin, seen };
}

describe('the bus re-sends through the transport by the condition', () => {
  it('does not re-send a redirect: the backend answered with a navigation, and onRedirect fires once', async () => {
    const onRedirect = vi.fn();
    const sent = singleServer(() => [200, { redirect: '/login' }]);
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 }, transport: httpTransport({ endpoint: '/api/vc', onRedirect }) });
    const result = await bus.dispatch('save', {});
    expect(result.ok).toBe(false);
    expect(sent.length).toBe(1);
    expect(onRedirect).toHaveBeenCalledTimes(1);
  });

  it('re-sends a transient answer; an uncertain one only when idempotent; never a final one', async () => {
    const counts: Array<[number, number, number]> = [
      [503, 3, 3], [429, 3, 3], [408, 3, 3],
      [504, 1, 3], [500, 1, 3], [502, 1, 3],
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

  it('re-sends a keyed command answered with Retry-After, after the wait it declares; an unkeyed one fails once with retryIn', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let first = true;
    const inProgress = () => new Response(JSON.stringify(problem(409, 'in_progress')), { status: 409, headers: { 'content-type': 'application/problem+json', 'retry-after': '2' } });
    const { bus, sent } = retried(() => {
      if (!first) return [200, { state: 'done' }];
      first = false;
      return inProgress();
    }, [idempotent()]);
    const pending = bus.dispatch('save', {});
    await vi.advanceTimersByTimeAsync(1999);
    expect(sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toSucceedWith('done');
    const plain = retried(inProgress);
    const unkeyed = plain.bus.dispatch('save', {});
    // Past three declared waits: a bus that re-sends fails here, never hangs.
    await vi.advanceTimersByTimeAsync(6000);
    const r = await unkeyed;
    expect(plain.sent.length).toBe(1);
    expect((r.error as BusError).context).toMatchObject({ status: 409, retryIn: 2000 });
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
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 }, transport: httpTransport({ endpoint: '/api/vc' }) });
    bus.use(plugin);
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
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 }, transport: httpTransport({ endpoint: '/api/vc/batch', batch: {} }) });
    bus.use(plugin);
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
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0 }, transport: { 'remote*': httpTransport({ endpoint: '/api/vc' }) } });
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
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }) });
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
    const bus = createAsyncCommandBus({ retry: { baseDelay: 0, actionPolicies: { flaky: 'idempotent' } } });
    bus.register('plain', async () => { calls++; throw new Error('flaky'); });
    bus.register('flaky', async () => { calls++; throw new Error('flaky'); });
    await bus.dispatch('plain', {});
    expect(calls).toBe(1);
    calls = 0;
    await bus.dispatch('flaky', {});
    expect(calls).toBe(3);

    let pluginCalls = 0;
    const withBug = createAsyncCommandBus({ retry: { baseDelay: 0 } });
    withBug.use({ admit: () => { pluginCalls++; throw new Error('bug'); } });
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

/** What the caller of a held command hears when it is dropped: its `done` settles with the failure. */
function onRefused(r: CommandResult, heard: (error: BusError) => void): void {
  void (r.value as Accepted).done.then((end) => { if (!end.ok) heard(end.error as BusError); });
}

/** Queue `actions` offline, then come back online; `rejected` collects what each caller hears. */
async function queued(answer: (command: string) => Answer, actions: string[], options: Parameters<typeof createOutbox>[0] = {}) {
  let online = false;
  const outbox = createOutbox({ storage: null, isOnline: () => online, autoFlush: false, ...options });
  const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc/batch', batch: {} }), outbox });
  batchServer((command) => answer(command));
  const rejected: Array<{ record: { action: string }; error: BusError }> = [];
  for (const action of actions) onRefused(await bus.dispatch(action, { action }), (error) => rejected.push({ record: { action }, error }));
  online = true;
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
    const outbox = createOutbox({ storage: null, isOnline: () => online, autoFlush: false });
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }), outbox });
    singleServer((command) => command === 'orderBad' ? [422, problem(422, 'validation_failed')] : [200, { state: command }]);
    const rejected: string[] = [];
    onRefused(await bus.dispatch('orderBad', {}), (error) => rejected.push(error.code));
    await bus.dispatch('orderAfter', {});
    online = true;
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
    for (const status of [503, 500, 401, 419, 408, 429]) {
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
      const outbox = createOutbox({ storage: null, isOnline: () => online });
      const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }), outbox });
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

  /** One record queued offline over the single endpoint, back online, `autoFlush` on. */
  async function oneQueued(answer: (nth: number) => Response | [number, unknown]) {
    let nth = 0;
    const sent = singleServer(() => answer(++nth));
    let online = false;
    const outbox = createOutbox({ storage: null, isOnline: () => online });
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }), outbox });
    const rejected: string[] = [];
    onRefused(await bus.dispatch('orderA', {}), (error) => rejected.push(error.code));
    online = true;
    return { outbox, sent, rejected };
  }
  const answering = (status: number, code: string, retryAfter?: string): Response =>
    new Response(JSON.stringify(problem(status, code)), {
      status,
      headers: { 'content-type': 'application/problem+json', ...(retryAfter === undefined ? {} : { 'retry-after': retryAfter }) },
    });

  it('a Retry-After of 0 is flushed again a second later, not at once, and it still drains', async () => {
    vi.useFakeTimers();
    let busy = true;
    // The valve ends the run if the re-flush loops: 500 answers inside one tick of the clock.
    const { outbox, sent } = await oneQueued((nth) => (busy && nth <= 500 ? answering(503, 'unavailable', '0') : [200, { state: 1 }]));

    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    await vi.advanceTimersByTimeAsync(999);
    expect(sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.length).toBe(2);
    // Then backing off: 2 s, 4 s (t = 3 s, 7 s).
    await vi.advanceTimersByTimeAsync(9000);
    expect(sent.length).toBe(4);
    expect(outbox.pending.value).toBe(1);

    busy = false;
    await vi.advanceTimersByTimeAsync(5000); // the 8 s wait from t = 7 s
    expect(sent.length).toBe(5);
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /** Fake-clock times (ms from the first flush) at which the backend was asked. */
  function clocked(answer: (nth: number) => Response | [number, unknown]) {
    const at: number[] = [];
    const t0 = Date.now();
    return { at, answer: (nth: number) => { at.push(Date.now() - t0); return answer(nth); } };
  }
  const gaps = (at: number[]) => at.slice(1).map((t, i) => t - at[i]!);

  it('a repeated Retry-After backs off: the waits double from 1 s and stop at 30 s', async () => {
    vi.useFakeTimers();
    const clock = clocked(() => answering(503, 'unavailable', '1'));
    const { outbox } = await oneQueued(clock.answer);
    await outbox.flush();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(gaps(clock.at)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
    outbox.dispose();
  });

  it('ten minutes of a busy backend cost 24 requests, and the record drains a second after it recovers', async () => {
    vi.useFakeTimers();
    let busy = true;
    const { outbox, sent } = await oneQueued(() => (busy ? answering(503, 'unavailable', '1') : [200, { state: 1 }]));
    await outbox.flush();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sent.length).toBe(24); // 601 before the backoff: one a second
    busy = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.length).toBe(25);
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
  });

  it('a declared wait longer than the schedule wins: Retry-After 20 waits 20 s where the schedule says 8', async () => {
    vi.useFakeTimers();
    const clock = clocked((n) => answering(503, 'unavailable', n === 4 ? '20' : '1'));
    const { outbox } = await oneQueued(clock.answer);
    await outbox.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    // 1, 2, 4; then the declared 20 over the schedule's 8; then the schedule again, doubled and capped.
    expect(gaps(clock.at)).toEqual([1000, 2000, 4000, 20_000, 30_000]);
    outbox.dispose();
  });

  it('a successful replay resets the backoff: the next record waits 1 s again, not 8 s', async () => {
    vi.useFakeTimers();
    let online = false;
    const outbox = createOutbox({ storage: null, isOnline: () => online });
    const bus = createAsyncCommandBus({ transport: httpTransport({ endpoint: '/api/vc' }), outbox });
    await bus.dispatch('orderA', {});
    await bus.dispatch('orderB', {});
    online = true;
    // orderA is busy three times (t = 0, 1 s, 3 s), lands at t = 7 s; orderB is then busy once.
    let nth = 0;
    const clock = clocked((n) => (n <= 3 || n === 5 ? answering(503, 'unavailable', '1') : [200, { state: 1 }]));
    const sent = singleServer(() => clock.answer(++nth));
    await outbox.flush();
    await vi.advanceTimersByTimeAsync(8000);
    expect(sent).toEqual(['orderA', 'orderA', 'orderA', 'orderA', 'orderB', 'orderB']);
    expect(gaps(clock.at)).toEqual([1000, 2000, 4000, 0, 1000]);
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
  });

  it('a flush during a scheduled wait replaces that wait: one timer, never two', async () => {
    vi.useFakeTimers();
    const clock = clocked(() => answering(503, 'unavailable', '1'));
    const { outbox } = await oneQueued(clock.answer);
    await outbox.flush(); // t = 0, next at 1 s
    await vi.advanceTimersByTimeAsync(500);
    // t = 0.5 s, by hand: the 503 holds the action, so it is not sent (tests/hold.test.ts).
    // Its failure still replaces the wait: next at 0.5 + 2 = 2.5 s, the 1 s wait cancelled.
    await outbox.flush();
    await vi.advanceTimersByTimeAsync(6500);
    expect(clock.at).toEqual([0, 2500, 6500]);
    outbox.dispose();
  });

  it('a 409 that declares a Retry-After is not a verdict: the record is kept and flushed again then', async () => {
    vi.useFakeTimers();
    const { outbox, sent, rejected } = await oneQueued((nth) => (nth === 1 ? answering(409, 'in_progress', '1') : [200, { state: 1 }]));

    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(rejected).toEqual([]);
    expect(outbox.pending.value).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sent.length).toBe(2);
    expect(outbox.pending.value).toBe(0);
    outbox.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();

    // Control: the same 409 with no Retry-After is still the verdict it was.
    const bare = await oneQueued(() => answering(409, 'in_progress'));
    expect(await bare.outbox.flush()).toEqual({ replayed: 0, failed: 0, rejected: 1 });
    expect(bare.rejected).toEqual(['remote:conflict:in_progress']);
    bare.outbox.dispose();
  });

  it('the app decides per record, in its own codes', async () => {
    const isRetryable = vi.fn((error: Error, record: OutboxRecord) =>
      (error as BusError).code === 'remote:conflict:in_progress' && record.action === 'orderLocked');
    const { outbox } = await queued((c) => ({ problem: c === 'orderLocked' ? problem(409, 'in_progress') : problem(422, 'bad') }), ['orderBad', 'orderLocked', 'orderAfter'], { isRetryable });
    expect(await outbox.flush()).toEqual({ replayed: 0, failed: 1, rejected: 1 });
    expect(isRetryable.mock.calls.map(([, record]) => record.action)).toEqual(['orderBad', 'orderLocked']);
  });
});

// The contract files (scripts/generate-contract.mjs) replayed against the
// client. A real server answers each request with its pact's response and
// records it. The client sends the table's request, so a case edited without
// regenerating fails here too. What the app sees is checked against `sees`.

type PactRequest = { method: string; path: string; headers?: Record<string, string[]>; body?: { content?: any } };
type PactResponse = { status: number; headers?: Record<string, string[]>; body?: { content?: any } };
type Interaction = { description: string; request: PactRequest; response: PactResponse };
type Sees = Record<string, unknown>;
type BatchCommand = { id: string; command: string; target: unknown; payload?: unknown; key?: string };
type Case = { id: string; request: { command?: string; target?: unknown; payload?: unknown; key?: string; batch?: BatchCommand[]; get?: string }; sees: Sees };
/** One answer of the server. `again` answers every request until the test ends. `ids` answers a batch with the ids it received, or the pact's own. */
type Step = { expect: PactRequest; respond: PactResponse; again?: boolean; ids?: 'echo' | 'literal' };
type Sent = { at: number; method?: string; url?: string; headers: IncomingHttpHeaders; body: any };

const table = cases as unknown as Case[];
const CONTRACT = new URL('../contract/', import.meta.url);
const pact: Record<string, Interaction> = Object.fromEntries(readdirSync(CONTRACT)
  .filter((file) => file.endsWith('.pact.json'))
  .flatMap((file) => (JSON.parse(readFileSync(new URL(file, CONTRACT), 'utf8')) as { interactions: Interaction[] }).interactions)
  .map((i) => [i.description, i]));

let steps: Step[] = [];
let sent: Sent[] = [];
let t0 = 0;
let base = '';

/** Answer the next requests with `next`, and forget what was sent before. */
function serve(...next: Step[]): void {
  steps = next;
  sent = [];
  t0 = Date.now();
}

const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined;
    sent.push({ at: Date.now() - t0, method: req.method, url: req.url, headers: req.headers, body });
    const step = steps[0];
    if (!step) { res.writeHead(599).end(); return; }
    if (!step.again) steps.shift();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const [name, values] of Object.entries(step.respond.headers ?? {})) headers[name.toLowerCase()] = values.join(', ');
    let content = step.respond.body?.content;
    // Pact cannot tie a response value to a request value, and the client
    // mints its own batch ids: answer each result with the id the client
    // sent at the pact command's position.
    if (step.ids === 'echo') {
      const pactIds = (step.expect.body!.content.commands as BatchCommand[]).map((c) => c.id);
      content = { results: content.results.map((r: { id: string }) => ({ ...r, id: body.commands[pactIds.indexOf(r.id)]?.id })) };
    }
    res.writeHead(step.respond.status, headers).end(content === undefined ? '' : JSON.stringify(content));
  });
});

beforeAll(async () => {
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

/** How a sent request differs from a pact request: method, path, every pact header, the body (a batch's without its ids). Extra headers pass, as in Pact. */
function compare(want: PactRequest, got: Sent | undefined): string[] {
  if (!got) return ['no request sent'];
  const off: string[] = [];
  if (got.method !== want.method) off.push(`method ${got.method}`);
  if (got.url !== want.path) off.push(`path ${got.url}`);
  for (const [name, values] of Object.entries(want.headers ?? {})) {
    if (got.headers[name.toLowerCase()] !== values.join(', ')) off.push(`header ${name}: ${got.headers[name.toLowerCase()]}`);
  }
  const content = want.body?.content;
  const withoutIds = (b: any) => (b?.commands ? { ...b, commands: b.commands.map(({ id: _id, ...rest }: BatchCommand) => rest) } : b);
  if (!isDeepStrictEqual(withoutIds(got.body), withoutIds(content))) off.push(`body ${JSON.stringify(got.body)}`);
  return off;
}

/** How what the app saw differs from `sees`. A case with no `code` or `results` wants a success. */
function check(sees: Sees, app: Sees): string[] {
  const want: Sees = 'code' in sees || 'results' in sees ? sees : { ok: true, ...sees };
  return Object.entries(want).flatMap(([name, value]) => {
    if (name === 'results') {
      return (value as Sees[]).flatMap((s, n) => check(s, (app.results as Sees[] | undefined)?.[n] ?? {}).map((m) => `results[${n}].${m}`));
    }
    return isDeepStrictEqual(app[name], value) ? [] : [`${name}: saw ${JSON.stringify(app[name])}, wants ${JSON.stringify(value)}`];
  });
}

const view = (r: CommandResult): Sees => {
  if (r.ok) return r.value instanceof Accepted ? { ok: true, accepted: true } : { ok: true, value: r.value };
  const context = (r.error as BusError).context;
  return { ok: false, code: (r.error as BusError).code, retryIn: context?.retryIn, url: context?.url, type: context?.type };
};

/** A bus with the HTTP transport, and the idempotent plugin when the case has a key. */
function busFor(c: Case, retry = false) {
  const transport = httpTransport({ endpoint: `${base}/api/vc` });
  const bus = retry ? createAsyncCommandBus({ transport }) : createAsyncCommandBus({ retry: false, transport });
  const key = c.request.key;
  if (key !== undefined) bus.use(idempotent({ key: () => key }));
  return bus;
}

const send = (bus: ReturnType<typeof busFor>, c: Case, payload = c.request.payload) =>
  bus.dispatch(c.request.command!, c.request.target ?? {}, payload);

async function single(c: Case): Promise<Sees> {
  const bus = busFor(c);
  return view(await send(bus, c));
}

/**
 * A FormBus submits the payload. Its fields are the payload's own plus the
 * field the case marks, unset, so JSON drops it and the body is the pact's.
 * `field` is the one field marked, or null when no field could take the
 * failure and `submit()` rejected with it.
 */
async function form(c: Case): Promise<Sees> {
  const bus = busFor(c);
  const fields: Record<string, unknown> = { ...(c.request.payload as object) };
  if (typeof c.sees.field === 'string' && !(c.sees.field in fields)) fields[c.sees.field] = undefined;
  let result: CommandResult | undefined;
  const f = createFormBus({ fields, reactive: false, onSubmit: async (values) => {
    result = await send(bus, c, values);
    if (!result.ok) throw result.error;
  } });
  let field: unknown;
  try {
    field = (await f.submit()) === false ? Object.keys(f.errors.value).join() : 'submitted';
  } catch (error) {
    field = error === result?.error && Object.keys(f.errors.value).length === 0 ? null : `threw ${error}`;
  }
  return { ...view(result!), field };
}

async function store(c: Case): Promise<Sees> {
  const bus = busFor(c);
  const s = defineChamberStore('contract', { state: (): Record<string, unknown> => ({}), reducers: {} })(bus);
  try {
    return { ...view(await send(bus, c)), store: s.state.value };
  } finally {
    s.$dispose();
  }
}

/** The batch's commands in one window; a command with a `key` is keyed by the idempotent plugin. */
async function batch(c: Case): Promise<Sees> {
  const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: `${base}/api/vc/batch`, batch: {} }) });
  const items = c.request.batch!;
  bus.use(idempotent({ key: (cmd) => items.find((x) => x.command === cmd.action && isDeepStrictEqual(x.payload, cmd.payload))?.key }));
  const results = await Promise.all(items.map((x) => bus.dispatch(x.command, x.target, x.payload)));
  return { results: results.map(view) };
}

/**
 * Whether a keyed answer with Retry-After is re-sent with retry on: after the
 * wait, with the same request. The second answer is not in the pact: a plain
 * success ends the run.
 */
async function resent(c: Case, i: Interaction): Promise<boolean> {
  const waitMs = Number(i.response.headers!['Retry-After']![0]) * 1000;
  serve({ expect: i.request, respond: i.response }, { expect: i.request, respond: { status: 200, body: { content: { state: { n: 1 } } } } });
  const bus = busFor(c, true);
  const r = await send(bus, c);
  return r.ok && sent.length === 2 && compare(i.request, sent[1]).length === 0 && sent[1]!.at - sent[0]!.at >= waitMs;
}

/**
 * A 202 whose Location its Accepted's `done` follows, single or batched. The
 * server answers every poll with the GET case of that path. maxWait ends a
 * job that never finishes, so `done` always settles.
 */
async function polled(c: Case, i: Interaction, poll: Interaction) {
  const items = c.request.batch;
  serve({ expect: i.request, respond: i.response, ...(items ? { ids: 'echo' as const } : {}) }, { expect: poll.request, respond: poll.response, again: true });
  const transport = httpTransport({ endpoint: `${base}/api/vc${items ? '/batch' : ''}`, poll: { maxWait: 5000 }, ...(items ? { batch: {} } : {}) });
  const bus = createAsyncCommandBus({ retry: false, transport });
  const answers = items ? await Promise.all(items.map((x) => bus.dispatch(x.command, x.target, x.payload))) : [await send(bus, c)];
  const finished = await (answers[0]!.value as Accepted).done;
  bus.dispose();
  return { first: items ? { results: answers.map(view) } : view(answers[0]!), finished, gets: sent.slice(1) };
}

describe('the contract files, replayed against the client', () => {
  for (const c of table) {
    if (c.request.get) continue;
    const i = pact[c.id]!;
    const poll = table.find((g) => g.request.get !== undefined && g.request.get === c.sees.polls);

    if (poll) {
      it(`${c.id} and ${poll.id}: the 202 sends the pact request, and its Accepted polls what ${poll.id} answers`, async () => {
        const p = pact[poll.id]!;
        const { first, finished, gets } = await polled(c, i, p);
        expect(compare(i.request, sent[0])).toEqual([]);
        expect(check(c.sees, { ...first, polls: gets[0]?.url })).toEqual([]);
        for (const get of gets) expect(compare(p.request, get)).toEqual([]);
        const wait = Number(p.response.headers?.['Retry-After']?.[0] ?? 0) * 1000;
        expect(check(poll.sees, {
          ok: true,
          waitsAgain: gets.length >= 2 && gets[1]!.at - gets[0]!.at >= wait,
          done: finished.ok ? finished.value : (finished.error as BusError).code,
        })).toEqual([]);
        // A job that never finishes ends at maxWait.
        if (!('done' in poll.sees)) expect(finished).toFailWith('transport:timeout:job');
      });
      continue;
    }

    it(`${c.id}: sends the pact request, and the app sees what the case says`, async () => {
      serve({ expect: i.request, respond: i.response, ...(c.request.batch ? { ids: 'echo' as const } : {}) });
      const app = c.request.batch ? await batch(c)
        : 'field' in c.sees ? await form(c)
          : 'store' in c.sees ? await store(c)
            : await single(c);
      expect(sent).toHaveLength(1);
      expect(compare(i.request, sent[0])).toEqual([]);
      if ('resent' in c.sees) app.resent = await resent(c, i);
      expect(check(c.sees, app)).toEqual([]);
    });
  }

  it('every interaction has a case, and every case one interaction', () => {
    expect(Object.keys(pact).sort()).toEqual(table.map((c) => c.id).sort());
  });

  it('every GET case is reached by a case whose 202 names its path', () => {
    for (const g of table.filter((c) => c.request.get)) {
      expect(table.some((c) => c.sees.polls === g.request.get), g.id).toBe(true);
    }
  });
});

describe('the replay catches a client that breaks the contract', () => {
  const core1 = table.find((c) => c.id === 'core-1')!;

  it('a sent body or header that differs from the pact is reported', async () => {
    const i = pact['core-1']!;
    serve({ expect: i.request, respond: i.response });
    await single(core1);
    const body = { content: { ...i.request.body!.content, payload: { altered: true } } };
    expect(compare({ ...i.request, body }, sent[0])).toHaveLength(1);
    expect(compare({ ...i.request, headers: { ...i.request.headers, Accept: ['text/html'] } }, sent[0])).toHaveLength(1);
  });

  it('a code the app does not see fails the check', async () => {
    const c = table.find((x) => x.id === 'core-2')!;
    serve({ expect: pact['core-2']!.request, respond: pact['core-2']!.response });
    const app = await single(c);
    expect(check(c.sees, app)).toEqual([]);
    expect(check({ ...c.sees, code: 'remote:conflict:other' }, app)).toHaveLength(1);
  });

  it("a batch answered with the pact's literal ids loses both results", async () => {
    const c = table.find((x) => x.id === 'batch-1')!;
    serve({ expect: pact['batch-1']!.request, respond: pact['batch-1']!.response, ids: 'literal' });
    const app = await batch(c);
    expect((app.results as Sees[]).map((r) => r.code)).toEqual(['transport:lost:result', 'transport:lost:result']);
  });

  it('the same 409 with Retry-After to an unkeyed command is not re-sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const i = pact['idem-2']!;
    const unkeyed = { ...table.find((x) => x.id === 'idem-2')!, request: { command: 'vcContractFail', payload: { status: 500, code: 'boom' } } };
    serve({ expect: i.request, respond: i.response }, { expect: i.request, respond: { status: 200, body: { content: { state: { n: 1 } } } } });
    const bus = busFor(unkeyed, true);
    expect(await send(bus, unkeyed)).toFailWith('remote:conflict:in_progress');
    expect(sent).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a reply without stores leaves the store as it was', async () => {
    serve({ expect: pact['core-1']!.request, respond: pact['core-1']!.response });
    expect((await store(core1)).store).toEqual({});
  });
});
