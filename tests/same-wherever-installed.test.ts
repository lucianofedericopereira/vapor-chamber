/** Every built-in plugin behaves the same wherever it is installed: on a command the transport sends, or on a local handler. The long note is at the end. */
import { existsSync, writeFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { type AsyncCommandBus, type CommandResult, createAsyncCommandBus } from '../src/command-bus';
import { history, authGuard, logger, validator } from '../src/plugins-core';
import { cache, circuitBreaker, idempotent, metrics, rateLimit, supersede } from '../src/plugins-extra';
import { validateSchemas, validateSchemasAsync } from '../src/plugins-schema';
import { schemaLogger, schemaValidator } from '../src/schema';
import { httpTransport } from '../src/transports';

type Arrangement = 'sent' | 'local handler';
const ARRANGEMENTS: Arrangement[] = ['sent', 'local handler'];

/** The work a command reaches: a POST to the server (sent) or the local handler. */
type World = { bus: AsyncCommandBus; work: () => number; peak: () => number; failing: (on: boolean) => void };
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function world(arrangement: Arrangement, install: (bus: AsyncCommandBus, w: World) => void, saveOptions: { optimistic?: boolean; exclusive?: object } = {}): World {
  let work = 0;
  let inflight = 0;
  let peak = 0;
  let fail = false;
  // The work honours its signal, as fetch and a well-behaved handler do.
  const busy = async <T>(fn: () => T, signal?: AbortSignal | null): Promise<T> => {
    work++; inflight++; peak = Math.max(peak, inflight);
    await tick(5);
    inflight--;
    if (signal?.aborted) throw signal.reason ?? Object.assign(new Error('aborted'), { name: 'AbortError' });
    return fn();
  };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': status < 300 ? 'application/json' : 'application/problem+json', ...headers } });
    const { command } = JSON.parse(init.body as string) as { command: string };
    return busy(() => (fail ? reply(500, { status: 500, code: 'boom', detail: 'down' }) : reply(200, { state: 'ok' })), init.signal);
  });
  const bus = createAsyncCommandBus({ retry: false, transport: arrangement === 'sent' ? httpTransport({ endpoint: '/vc' }) : undefined });
  const w: World = { bus, work: () => work, peak: () => peak, failing: (on) => { fail = on; } };
  // Each action has its undo; `save` takes the options a row declares. Sent,
  // an action has no handler (`null`), unless `optimistic` makes it the change shown.
  for (const action of ['save', 'load', 'search']) {
    const opts = { undo: () => { undone++; }, ...(action === 'save' ? saveOptions : {}) };
    const handler = async (cmd: { signal?: AbortSignal }) => busy(() => { if (fail) throw new Error('down'); return 'ok'; }, cmd.signal);
    bus.register(action, arrangement === 'sent' && !opts.optimistic ? null : handler, opts);
  }
  install(bus, w);
  return w;
}
let undone = 0;

const schema = { save: { target: { id: 'number' } } } as never;
const rejecting = { '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message: 'bad' }] }) } } as never;
const code = (r: CommandResult) => (r.ok ? 'ok' : (r.error as { code?: string }).code ?? r.error.message);
const groupsFor = (spy: { mock: { calls: unknown[][] } }, action: string) => spy.mock.calls.filter((c) => String(c[0]).includes(action)).length;

/** Each plugin: what it is for, as one observable value an app sees. */
type Case = { name: string; expected: unknown; run: (a: Arrangement) => Promise<unknown> };
const CASES: Case[] = [
  { name: 'logger', expected: 1, run: async (a) => {
    const spy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    const w = world(a, (bus) => bus.use(logger()));
    await w.bus.dispatch('save', { id: 1 });
    return groupsFor(spy, 'save');
  } },
  { name: 'validator', expected: { result: 'validator:invalid:payload', work: 0 }, run: async (a) => {
    const w = world(a, (bus) => bus.use(validator({ save: () => 'bad' })));
    return { result: code(await w.bus.dispatch('save', { id: 1 })), work: w.work() };
  } },
  { name: 'history', expected: 1, run: async (a) => {
    const w = world(a, () => {});
    const h = history({ bus: w.bus });
    await w.bus.dispatch('save', { id: 1 });
    return h.getState().past.length;
  } },
  { name: 'authGuard', expected: { result: 'authGuard:unauthenticated:action', work: 0 }, run: async (a) => {
    const w = world(a, (bus) => bus.use(authGuard({ isAuthenticated: () => false, protected: ['save'] })));
    return { result: code(await w.bus.dispatch('save', { id: 1 })), work: w.work() };
  } },
  { name: 'register({ optimistic })', expected: 1, run: async (a) => {
    undone = 0;
    const w = world(a, () => {}, { optimistic: true });
    w.failing(true);
    const r = await w.bus.dispatch('save', { id: 1 });
    await (r.value as { done: Promise<unknown> }).done;
    return undone;
  } },
  { name: 'cache', expected: 1, run: async (a) => {
    const w = world(a, (bus) => bus.use(cache()));
    await w.bus.dispatch('load', { id: 1 });
    await w.bus.dispatch('load', { id: 1 });
    return w.work();
  } },
  { name: 'circuitBreaker', expected: { third: 'circuitBreaker:limited:action', work: 2 }, run: async (a) => {
    const w = world(a, (bus) => bus.use(circuitBreaker({ threshold: 2 })));
    w.failing(true);
    await w.bus.dispatch('save', { id: 1 });
    await w.bus.dispatch('save', { id: 1 });
    return { third: code(await w.bus.dispatch('save', { id: 1 })), work: w.work() };
  } },
  { name: 'rateLimit', expected: { second: 'rateLimit:limited:action', work: 1 }, run: async (a) => {
    const w = world(a, (bus) => bus.use(rateLimit({ max: 1, window: 1000 })));
    await w.bus.dispatch('save', { id: 1 });
    return { second: code(await w.bus.dispatch('save', { id: 1 })), work: w.work() };
  } },
  { name: 'metrics', expected: 1, run: async (a) => {
    const m = metrics();
    const w = world(a, (bus) => bus.use(m));
    await w.bus.dispatch('save', { id: 1 });
    return m.entries().length;
  } },
  { name: 'register({ exclusive })', expected: 1, run: async (a) => {
    const w = world(a, () => {}, { exclusive: {} });
    await Promise.all([w.bus.dispatch('save', { id: 1 }), w.bus.dispatch('save', { id: 2 })]);
    return w.peak();
  } },
  { name: 'idempotent', expected: 1, run: async (a) => {
    const w = world(a, (bus) => bus.use(idempotent()));
    await Promise.all([w.bus.dispatch('save', { id: 1 }), w.bus.dispatch('save', { id: 1 })]);
    return w.work();
  } },
  { name: 'supersede', expected: 'core:aborted:dispatch', run: async (a) => {
    const w = world(a, (bus) => bus.use(supersede()));
    const first = w.bus.dispatch('search', { q: 1 });
    void w.bus.dispatch('search', { q: 1 });
    return code(await first);
  } },
  { name: 'validateSchemas', expected: { work: 0 }, run: async (a) => {
    const w = world(a, (bus) => bus.use(validateSchemas({ save: rejecting })));
    await w.bus.dispatch('save', { id: 1 });
    return { work: w.work() };
  } },
  { name: 'validateSchemasAsync', expected: { work: 0 }, run: async (a) => {
    const w = world(a, (bus) => bus.use(validateSchemasAsync({ save: rejecting })));
    await w.bus.dispatch('save', { id: 1 });
    return { work: w.work() };
  } },
  { name: 'schemaValidator', expected: { result: 'schemaValidator:invalid:payload', work: 0 }, run: async (a) => {
    const w = world(a, (bus) => bus.use(schemaValidator(schema)));
    return { result: code(await w.bus.dispatch('save', { id: 'x' })), work: w.work() };
  } },
  { name: 'schemaLogger', expected: 1, run: async (a) => {
    const spy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
    const w = world(a, (bus) => bus.use(schemaLogger(schema)));
    await w.bus.dispatch('save', { id: 1 });
    return groupsFor(spy, 'save');
  } },
];

const report: Array<{ plugin: string; expected: unknown; observed: Record<string, unknown> }> = [];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(() => {
  // A local report only: .probes is not in a clean checkout.
  if (existsSync(new URL('../.probes/', import.meta.url))) writeFileSync(new URL('../.probes/same-wherever-installed.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`);
});

async function everywhere(c: Case): Promise<Record<string, unknown>> {
  const observed: Record<string, unknown> = {};
  for (const a of ARRANGEMENTS) {
    observed[a] = await c.run(a);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
  return observed;
}
const want = (c: Case, observed: Record<string, unknown>) => Object.fromEntries(Object.keys(observed).map((a) => [a, c.expected]));

describe('every built-in plugin behaves the same wherever it is installed', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const observed = await everywhere(c);
      report.push({ plugin: c.name, expected: c.expected, observed });
      expect(observed).toEqual(want(c, observed));
    });
  }
});

/*
 * The goal of the work after the 1.32 reset (handoff-streams.md, RESET note),
 * written as a test so no plan, prompt or agent can redefine it: a plugin
 * behaves the same wherever it is installed. Each case states what the plugin
 * is for as one value an app sees (a request not sent, an entry recorded, a
 * refusal, a rollback run) and checks it on a command the bus's transport
 * sends and on one a local handler runs. Step 1 of .probes/plan-1.32.md wrote
 * three arrangements: the plugin installed before the bridge, after it, and on
 * a local handler, each row `it.fails` while "after the bridge" differed.
 * Step 3a declares the transport at the bus. It is the work, inside every
 * plugin, so "after" no longer exists and every row is `it`. History (4h) and
 * the outbox (4i) are no longer plugins: history records after the chain and
 * the outbox holds at the work step, so they have no install position.
 */
