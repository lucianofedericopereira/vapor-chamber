/**
 * dispose() settles waiting request()s at once, and the sync request()
 * honours its caller's signal.
 *
 * Before: dispose() cancelled only throttle timers. A request() still
 * waiting on its responder kept its timer (default 5000 ms), which held a
 * Node process open - SSR is dispose()'s named use case - and then resolved
 * as VC_CORE_REQUEST_TIMEOUT, which the registry marks retryable, inviting a
 * retry against a bus whose responders were gone. Now each bus keeps one
 * cancel per waiting request (`waiting`, lazily null like `deferred`):
 * dispose() runs them, every waiting request settles as VC_CORE_ABORTED (not
 * retryable) with its timer cleared, and the next request() works. There is
 * no disposed state - the stance of Vue 3.6's EffectScope.stop() (rc.8,
 * @vue/reactivity), which polices nothing after stopping.
 *
 * The responder is not told: only the caller's own signal reaches
 * cmd.signal, and only on the async bus. The sync command keeps the four
 * fields every sync command has - Command.signal says sync bus paths ignore
 * the field, and docs/performance.md's shape note says why: a `signal` store
 * on the sync path is the class of change measured 25% worse. A bus-owned
 * signal on every request, composed with the caller's, was built first and
 * measured slower on both waiting paths (rc-alignment-work.md s33, V5).
 *
 * The sync request() also honours the caller's { signal } now: its type
 * accepted one and its body ignored it. Pre-aborted, it settles before the
 * responder runs; aborted while waiting, at once, timer cleared.
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
  it('settles them as VC_CORE_ABORTED at once and clears their timers', async () => {
    vi.useFakeTimers();
    const bus: any = make();
    let seen: unknown = 'not called';
    bus.respond('q', (cmd: any) => { seen = cmd.signal; return new Promise(() => {}); }); // never settles
    let result: CommandResult | undefined;
    bus.request('q', {}).then((r: CommandResult) => { result = r; });

    bus.dispose();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks; no time passes

    expect(code(result)).toBe('VC_CORE_ABORTED');
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

    expect(code(result)).toBe('VC_CORE_ABORTED');
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

    expect(code(r)).toBe('VC_CORE_ABORTED');
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

    expect(code(result)).toBe('VC_CORE_ABORTED');
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

  it('the sync command carries no signal - the four fields every sync command has', async ({ bus }) => {
    // The engine's own map check for this sits in tests/v8-shapes.test.ts.
    let requested: Command | undefined;
    bus.respond('q', (cmd) => { requested = cmd; return 'answer'; });
    const caller = new AbortController();

    const r = await bus.request('q', {}, undefined, { signal: caller.signal });

    expect(r.value).toBe('answer');
    expect(Object.keys(requested!)).toEqual(['action', 'target', 'payload', 'meta']);
  });
});

describe('async bus: the caller signal still reaches the responder', () => {
  it('on cmd.signal, as before', async ({ asyncBus: bus }) => {
    let seen: AbortSignal | undefined;
    bus.respond('q', async (cmd) => { seen = cmd.signal; return 'answer'; });
    const caller = new AbortController();

    const r = await bus.request('q', {}, undefined, { signal: caller.signal });

    expect(r.value).toBe('answer');
    expect(seen).toBe(caller.signal);
  });
});
