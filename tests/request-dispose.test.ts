/**
 * dispose() settles waiting request()s at once, and the sync request() honours its caller's signal.
 * Why: a waiting request left alive by dispose() would keep its timer (default 5000 ms) holding a Node process open (SSR) and resolve as the retryable core:timeout:request against a bus whose responders are gone; dispose() settles it as the non-retryable core:aborted:dispatch. There is no disposed state, so the next request() works.
 * Shows: on both buses dispose() settles a waiting request with core:aborted:dispatch and no timer left, leaves a caller's signal unaborted, and a later request() succeeds; on the sync bus a pre-aborted or mid-flight abort settles the request (responder not run in the first case); the sync command keeps its five fields with signal undefined; on the async bus the responder gets an AbortSignal that a lone caller's abort aborts, with its reason.
 * See: docs/performance.md, tests/v8-shapes.test.ts
 */
import { describe, expect, vi, afterEach } from 'vitest';
import { createCommandBus, createAsyncCommandBus, type BusError, type Command, type CommandResult } from '../src/command-bus';
import { it } from '../src/vitest';

afterEach(() => {
  vi.useRealTimers();
});

const code = (r: CommandResult | undefined): string | undefined => (r?.error as BusError | undefined)?.code;

describe.each([
  ['sync', () => createCommandBus()],
  ['async', () => createAsyncCommandBus()],
] as const)('%s bus: dispose() settles waiting request()s', (_kind, make) => {
  it('settles them as core:aborted:dispatch at once and clears their timers', async () => {
    vi.useFakeTimers();
    const bus: any = make();
    let seen: unknown = 'not called';
    bus.respond('q', (cmd: any) => { seen = cmd.signal; return new Promise(() => {}); }); // never settles
    let result: CommandResult | undefined;
    bus.request('q', {}).then((r: CommandResult) => { result = r; });

    bus.dispose();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks; no time passes

    expect(code(result)).toBe('core:aborted:dispatch');
    expect(vi.getTimerCount()).toBe(0);
    expect(seen).toBeUndefined(); // no caller signal, so the responder saw none
  });

  it('settles a request that also carries a caller signal, and leaves that signal alone', async () => {
    vi.useFakeTimers();
    const bus: any = make();
    bus.respond('q', () => new Promise(() => {}));
    const caller = new AbortController();
    let result: CommandResult | undefined;
    bus.request('q', {}, undefined, { signal: caller.signal }).then((r: CommandResult) => { result = r; });

    bus.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(code(result)).toBe('core:aborted:dispatch');
    expect(vi.getTimerCount()).toBe(0);
    expect(caller.signal.aborted).toBe(false);
  });

  it('a request() after dispose() works - no disposed state', async () => {
    const bus: any = make();
    bus.respond('q', () => 'first');
    bus.dispose();
    bus.respond('q', () => 'second');
    const r: CommandResult = await bus.request('q', {});
    expect(r).toSucceedWith('second');
  });

  it('a request that settled on its own leaves nothing for dispose()', async () => {
    vi.useFakeTimers();
    const bus: any = make();
    bus.respond('q', () => new Promise((r) => setTimeout(() => r('late'), 10)));
    let result: CommandResult | undefined;
    bus.request('q', {}).then((r: CommandResult) => { result = r; });
    await vi.advanceTimersByTimeAsync(10);
    expect(result?.value).toBe('late');

    bus.dispose();
    await vi.advanceTimersByTimeAsync(0);

    expect(result?.value).toBe('late'); // settled once
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('sync bus: request() honours the caller signal', () => {
  it('an already-aborted signal settles before the responder runs', async ({ bus }) => {
    const responder = vi.fn(() => 'answer');
    bus.respond('q', responder);
    const caller = new AbortController();
    caller.abort();

    const r = await bus.request('q', {}, undefined, { signal: caller.signal });

    expect(code(r)).toBe('core:aborted:dispatch');
    expect(responder).not.toHaveBeenCalled();
  });

  it('an abort mid-flight settles at once and clears the timer', async () => {
    vi.useFakeTimers();
    const bus = createCommandBus();
    bus.respond('q', () => new Promise(() => {}));
    const caller = new AbortController();
    let result: CommandResult | undefined;
    bus.request('q', {}, undefined, { signal: caller.signal }).then((r) => { result = r; });

    caller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(code(result)).toBe('core:aborted:dispatch');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a signal that never aborts changes nothing, and its listener is gone once the request settles', async () => {
    vi.useFakeTimers();
    const bus = createCommandBus();
    bus.respond('q', () => new Promise((r) => setTimeout(() => r('late'), 10)));
    const caller = new AbortController();
    let result: CommandResult | undefined;
    bus.request('q', {}, undefined, { signal: caller.signal }).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(10);
    expect(result?.value).toBe('late');
    expect(vi.getTimerCount()).toBe(0);

    caller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(result?.value).toBe('late'); // settled once; the abort reached nothing
  });

  it('the sync command carries no signal: its slot stays undefined, the five fields every command has', async ({ bus }) => {
    let requested: Command | undefined;
    bus.respond('q', (cmd) => { requested = cmd; return 'answer'; });
    const caller = new AbortController();

    const r = await bus.request('q', {}, undefined, { signal: caller.signal });

    expect(r.value).toBe('answer');
    expect(Object.keys(requested!)).toEqual(['action', 'target', 'payload', 'meta', 'signal']);
    expect(requested!.signal).toBeUndefined();
  });
});

describe('async bus: the caller signal still reaches the responder', () => {
  it('on cmd.signal, as before', async ({ asyncBus: bus }) => {
    let seen: AbortSignal | undefined;
    bus.respond('q', async (cmd) => { seen = cmd.signal; return 'answer'; });
    const caller = new AbortController();

    const r = await bus.request('q', {}, undefined, { signal: caller.signal });

    expect(r.value).toBe('answer');
    // cmd.signal is the bus's own signal, aborted once every caller holding the request has aborted (tests/request-join.test.ts).
    expect(seen).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(false);
  });

  it('a lone caller abort reaches cmd.signal with its reason', async ({ asyncBus: bus }) => {
    let seen: AbortSignal | undefined;
    bus.respond('q', (cmd) => new Promise((resolve) => { seen = cmd.signal; cmd.signal?.addEventListener('abort', () => resolve(0)); }));
    const caller = new AbortController();
    const p = bus.request('q', {}, undefined, { signal: caller.signal });
    const why = new Error('gone');
    caller.abort(why);
    await p;
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBe(why);
  });
});
