// Pacing is the sender's: `pace()` debounces or throttles a dispatch before it reaches the bus; rationale at the end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { pace } from '../src/pace';
import { _registerAsLibrary } from '../src/library-names';
import { useCommand } from '../src/chamber';
import { defineVaporCommand } from '../src/chamber-vapor';
import { createAsyncCommandBus, createCommandBus, inspectBus, type BusError, type Command, type CommandResult } from '../src/command-bus';

const products = ['wireless mouse', 'wired keyboard', 'usb hub'];
const search = (cmd: Command) => products.filter((p) => p.includes(cmd.payload as string));
const code = (r: CommandResult): string | undefined => (r.error as BusError | undefined)?.code;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('pace: debounce', () => {
  it('three quick keystrokes on one action and target run once, with the last value', async () => {
    const bus = createCommandBus();
    const runs: unknown[] = [];
    bus.register('searchQuery', (cmd) => { runs.push(cmd.payload); return search(cmd); });
    const send = pace(bus.dispatch, { debounce: 300 });
    const calls = ['w', 'wi', 'wir'].map((text) => send('searchQuery', {}, text));
    await vi.advanceTimersByTimeAsync(300);
    const [first, second, last] = await Promise.all(calls);
    expect({ runs, last: last.value, superseded: [code(first), code(second)] }).toEqual({
      runs: ['wir'],
      last: ['wireless mouse', 'wired keyboard'],
      superseded: ['pace:aborted:dispatch', 'pace:aborted:dispatch'],
    });
  });

  it('the text as the target is a key per keystroke: nothing coalesces (why the text is the payload)', async () => {
    const bus = createCommandBus();
    const runs: unknown[] = [];
    bus.register('searchQuery', (cmd) => { runs.push(cmd.target); });
    const send = pace(bus.dispatch, { debounce: 300 });
    const calls = ['w', 'wi', 'wir'].map((text) => send('searchQuery', text));
    await vi.advanceTimersByTimeAsync(300);
    await Promise.all(calls);
    expect(runs).toEqual(['w', 'wi', 'wir']);
  });

  it('answers with the async bus result, and a superseded call never reaches the bus', async () => {
    const bus = createAsyncCommandBus();
    const seen: string[] = [];
    bus.on('*', (cmd) => { seen.push(cmd.payload as string); });
    bus.register('searchQuery', async (cmd) => search(cmd));
    const send = pace(bus.dispatch, { debounce: 50 });
    const early = send('searchQuery', {}, 'usb');
    const late = send('searchQuery', {}, 'hub');
    await vi.advanceTimersByTimeAsync(50);
    expect({ early: (await early).ok, late: (await late).value, seen }).toEqual({ early: false, late: ['usb hub'], seen: ['hub'] });
  });

  it('a $ action runs at once, unpaced', async () => {
    const bus = createCommandBus();
    let ran = 0;
    _registerAsLibrary(bus, 'cart$reset', () => { ran++; return 'reset'; });
    const send = pace(bus.dispatch, { debounce: 300 });
    const r = await send('cart$reset', null);
    expect({ ran, value: r.value }).toEqual({ ran: 1, value: 'reset' });
  });

  it('dispose settles a waiting call and runs nothing', async () => {
    const bus = createCommandBus();
    let ran = 0;
    bus.register('save', () => { ran++; });
    const send = pace(bus.dispatch, { debounce: 100 });
    const call = send('save', {}, 1);
    send.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect({ ran, code: code(await call) }).toEqual({ ran: 0, code: 'pace:aborted:dispatch' });
  });

  it('a send that throws settles as a failed result', async () => {
    const bus = createCommandBus({ onMissing: 'throw' });
    const send = pace(bus.dispatch, { debounce: 10 });
    const call = send('nobody', {}, 1);
    await vi.advanceTimersByTimeAsync(10);
    expect((await call).ok).toBe(false);
  });
});

describe('pace: latest wins', () => {
  it('a newer run of a key aborts the one in flight: the stale answer never lands after it', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const store: unknown[] = [];
    bus.register('searchQuery', async (cmd) => {
      const ms = cmd.payload === 'slow' ? 100 : 10;
      await new Promise((r) => setTimeout(r, ms));
      if (cmd.signal?.aborted) throw cmd.signal.reason;
      store.push(cmd.payload);
      return cmd.payload;
    });
    const send = pace(bus.dispatch, { debounce: 5 });
    const first = send('searchQuery', {}, 'slow');
    await vi.advanceTimersByTimeAsync(10);
    const second = send('searchQuery', {}, 'fast');
    await vi.advanceTimersByTimeAsync(200);
    const [a, b] = await Promise.all([first, second]);
    expect({ first: a.ok, firstCondition: code(a)?.split(':')[1], second: b.value, store })
      .toEqual({ first: false, firstCondition: 'aborted', second: 'fast', store: ['fast'] });
  });

  it('control: two keys run side by side, neither aborted', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async (cmd) => { await new Promise((r) => setTimeout(r, 20)); return cmd.target; });
    const send = pace(bus.dispatch, { throttle: 1000 });
    const one = send('save', { id: 1 });
    const two = send('save', { id: 2 });
    await vi.advanceTimersByTimeAsync(30);
    expect([(await one).value, (await two).value]).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it('dispose aborts the run in flight', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('save', async (cmd) => { await new Promise((r) => setTimeout(r, 50)); if (cmd.signal?.aborted) throw cmd.signal.reason; return 'saved'; });
    const send = pace(bus.dispatch, { throttle: 1000 });
    const run = send('save', {});
    await vi.advanceTimersByTimeAsync(1);
    send.dispose();
    await vi.advanceTimersByTimeAsync(60);
    expect((await run).ok).toBe(false);
  });
});

describe('pace: throttle', () => {
  it('runs the first call, refuses a repeat inside the wait with retryIn, and the bus sees one', async () => {
    const bus = createCommandBus();
    const seen: unknown[] = [];
    bus.on('*', (cmd) => { seen.push(cmd.payload); });
    bus.register('cartAdd', () => 'added');
    const send = pace(bus.dispatch, { throttle: 500 });
    const first = await send('cartAdd', { id: 1 }, 'a');
    await vi.advanceTimersByTimeAsync(200);
    const second = await send('cartAdd', { id: 1 }, 'b');
    const other = await send('cartAdd', { id: 2 }, 'c');
    expect({
      first: first.value,
      code: code(second),
      context: (second.error as { context?: unknown })?.context,
      other: other.value,
      seen,
    }).toEqual({ first: 'added', code: 'pace:limited:dispatch', context: { retryIn: 300, wait: 500 }, other: 'added', seen: ['a', 'c'] });
    await vi.advanceTimersByTimeAsync(300);
    expect((await send('cartAdd', { id: 1 }, 'd')).value).toBe('added');
  });

  it('a $ action runs at once, and a send that rejects settles as a failed result', async () => {
    const bus = createCommandBus();
    let ran = 0;
    _registerAsLibrary(bus, 'cart$reset', () => { ran++; });
    const send = pace(bus.dispatch, { throttle: 1000 });
    await send('cart$reset', null);
    await send('cart$reset', null);
    const failing = pace(() => Promise.reject(new Error('down')), { throttle: 10 });
    const r = await failing('save', {});
    expect({ ran, ok: r.ok, message: r.error?.message }).toEqual({ ran: 2, ok: false, message: 'down' });
  });

  it('dispose forgets the windows', async () => {
    const bus = createCommandBus();
    bus.register('ping', () => 'pong');
    const send = pace(bus.dispatch, { throttle: 1000 });
    await send('ping', null);
    send.dispose();
    expect((await send('ping', null)).value).toBe('pong');
  });
});

describe('the composables take the pace options', () => {
  it('useCommand({ debounce }) coalesces keystrokes on one key', async () => {
    const bus = createCommandBus();
    const runs: unknown[] = [];
    bus.register('searchQuery', (cmd) => { runs.push(cmd.payload); return search(cmd); });
    const scope = effectScope();
    const cmd = scope.run(() => useCommand({ bus, debounce: 300 }))!;
    const calls = ['u', 'us', 'usb'].map((text) => cmd.dispatch('searchQuery', {}, text));
    await vi.advanceTimersByTimeAsync(300);
    const results: CommandResult[] = await Promise.all(calls);
    expect({ runs, last: results[2].value }).toEqual({ runs: ['usb'], last: ['usb hub'] });
    scope.stop();
  });

  it('useCommand() with no pace option dispatches at once, as before', () => {
    const bus = createCommandBus();
    bus.register('ping', () => 'pong');
    const cmd = useCommand({ bus });
    expect(cmd.dispatch('ping', null).value).toBe('pong');
    cmd.dispose();
  });

  it('a scope that ends settles a waiting useCommand call', async () => {
    const bus = createCommandBus();
    let ran = 0;
    bus.register('save', () => { ran++; });
    const scope = effectScope();
    const cmd = scope.run(() => useCommand({ bus, debounce: 100 }))!;
    const call = cmd.dispatch('save', {}, 1);
    scope.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect({ ran, code: code(await call) }).toEqual({ ran: 0, code: 'pace:aborted:dispatch' });
  });

  it('defineVaporCommand({ throttle }) refuses a repeat inside the wait', async () => {
    const bus = createCommandBus();
    const scope = effectScope();
    const cmd = scope.run(() => defineVaporCommand('scrollMark', () => 'marked', { bus, throttle: 100 }))!;
    const first = await cmd.dispatch({}, 1);
    const second = await cmd.dispatch({}, 2);
    expect({ first: first.value, second: code(second) }).toEqual({ first: 'marked', second: 'pace:limited:dispatch' });
    scope.stop();
  });
});

describe('defineVaporCommand: dispatched, then its scope ends in the same tick', () => {
  it('debounce: the waiting call settles aborted, the handler never runs, the action is released', async () => {
    const bus = createCommandBus();
    let ran = 0;
    const scope = effectScope();
    const cmd = scope.run(() => defineVaporCommand('searchType', () => { ran++; }, { bus, debounce: 50 }))!;
    const call = cmd.dispatch({}, 'mou');
    scope.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect({ ran, code: code(await call), held: bus.hasHandler('searchType') })
      .toEqual({ ran: 0, code: 'pace:aborted:dispatch', held: false });
  });

  it('control: debounce with the scope alive runs the handler once', async () => {
    const bus = createCommandBus();
    let ran = 0;
    const scope = effectScope();
    const cmd = scope.run(() => defineVaporCommand('searchType', () => { ran++; return 'found'; }, { bus, debounce: 50 }))!;
    const call = cmd.dispatch({}, 'mou');
    await vi.advanceTimersByTimeAsync(100);
    expect({ ran, value: (await call).value }).toEqual({ ran: 1, value: 'found' });
    scope.stop();
  });

  it('throttle on a sync bus: the first call already ran, its value stands', async () => {
    const bus = createCommandBus();
    let ran = 0;
    const scope = effectScope();
    const cmd = scope.run(() => defineVaporCommand('scrollMark', () => { ran++; return 'marked'; }, { bus, throttle: 100 }))!;
    const call = cmd.dispatch({}, 1);
    scope.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect({ ran, value: (await call).value }).toEqual({ ran: 1, value: 'marked' });
  });

  it('control: after the scope ends a direct dispatch finds no handler', async () => {
    const bus = createCommandBus();
    const scope = effectScope();
    scope.run(() => defineVaporCommand('scrollMark', () => 'marked', { bus, throttle: 100 }));
    scope.stop();
    expect(code(bus.dispatch('scrollMark', {}))).toBe('core:missing:handler');
  });

  it('throttle on an async bus: the run in flight is aborted', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const scope = effectScope();
    const save = async (c: Command) => { await new Promise((r) => setTimeout(r, 50)); if (c.signal?.aborted) throw c.signal.reason; return 'saved'; };
    const cmd = scope.run(() => defineVaporCommand('autosave', save, { bus, throttle: 100 }))!;
    const call = cmd.dispatch({}, 1);
    await vi.advanceTimersByTimeAsync(1);
    scope.stop();
    await vi.advanceTimersByTimeAsync(60);
    expect((await call).ok).toBe(false);
  });

  it('control: the same async run with the scope alive answers', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const scope = effectScope();
    const save = async (c: Command) => { await new Promise((r) => setTimeout(r, 50)); if (c.signal?.aborted) throw c.signal.reason; return 'saved'; };
    const cmd = scope.run(() => defineVaporCommand('autosave', save, { bus, throttle: 100 }))!;
    const call = cmd.dispatch({}, 1);
    await vi.advanceTimersByTimeAsync(60);
    expect((await call).value).toBe('saved');
    scope.stop();
  });
});

describe('the bus does not pace', () => {
  it('has no debounce or throttle plugin, no register throttle and no activeTimers', async () => {
    const root = await import('../src/index');
    const bus = createCommandBus();
    expect({
      debounce: 'debounce' in root,
      throttle: 'throttle' in root,
      activeTimers: 'activeTimers' in inspectBus(bus),
    }).toEqual({ debounce: false, throttle: false, activeTimers: false });
  });
});

// Plan 1.32 section 3 gives pacing to the sender, and revision 22 of the record moves
// `debounce` and `throttle` off the bus. A paced call always returns a promise, on either
// bus: a debounced call settles later, and one shape serves both modes.
//
// Debounce keys by `commandKey(action, target)`, as the plugins did. Search as you type
// passes the typed text as the PAYLOAD, so three keystrokes share one key and run once with
// the last value. The second test shows the other choice: the text as the target makes a
// key per keystroke, and nothing coalesces. A superseded call answers
// `pace:aborted:dispatch` (the record's section C) and never reaches the bus, so the bus's
// listeners and `errors` see only the run that happened.
//
// Throttle admits the first call per key in each wait and refuses the rest with
// `pace:limited:dispatch`, `context.retryIn` and `wait`, as the bus's gate did. The refusal
// is a result at the sender: no handler, no listener, no retry.
