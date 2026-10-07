/** register({ throttle }) and the throttle() plugin, the same burst through both. The long note is at the end. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus, inspectBus } from '../src/command-bus';
import { throttle } from '../src/plugins-core';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => vi.useRealTimers());

const WAIT = 100;

/** One bus per entry point; `handled` counts handler runs, `heard` what a listener saw. */
function rig(kind: 'register' | 'plugin') {
  const bus = createCommandBus();
  const handled: string[] = [];
  const heard: Array<boolean> = [];
  const plugin = throttle(['cart*'], WAIT);
  if (kind === 'plugin') bus.use(plugin);
  bus.register('cartAdd', (cmd) => { handled.push(String(cmd.target.id)); return 1; }, {
    ...(kind === 'register' ? { throttle: WAIT } : {}),
    undo: () => 0,
  });
  bus.on('cartAdd', (_c, r) => heard.push(r.ok));
  const send = (id: number) => {
    const r = bus.dispatch('cartAdd', { id });
    const e = r.error as { code?: string; context?: { retryIn?: number; wait?: number } } | undefined;
    return r.ok ? 'ok' : `${e?.code} retryIn=${e?.context?.retryIn} wait=${e?.context?.wait}`;
  };
  return { bus, plugin, handled, heard, send };
}

describe('the same burst through both entry points', () => {
  for (const kind of ['register', 'plugin'] as const) {
    it(`${kind}: the first per target runs, a repeat inside the window is refused with retryIn, the window reopens`, () => {
      const { bus, handled, heard, send } = rig(kind);
      const out = [send(1), send(2)];
      vi.advanceTimersByTime(30);
      out.push(send(1));
      vi.advanceTimersByTime(70);
      out.push(send(1));
      const owner = kind === 'register' ? 'core' : 'throttle';
      expect({ out, handled, heard }).toEqual({
        out: ['ok', 'ok', `${owner}:limited:handler retryIn=70 wait=100`, 'ok'],
        handled: ['1', '2', '1'],
        heard: [true, true, false, true],
      });
      bus.dispose();
    });
  }

  it('the refusal codes differ by owner, each in the registry and the whitepaper row', () => {
    const r = rig('register'), p = rig('plugin');
    r.send(1); p.send(1);
    expect([r.send(1).split(' ')[0], p.send(1).split(' ')[0]]).toEqual(['core:limited:handler', 'throttle:limited:handler']);
  });
});

describe('timers after dispose', () => {
  it('control: an admitted call leaves one timer on each', () => {
    const r = rig('register'), p = rig('plugin');
    r.send(1); p.send(1);
    expect([inspectBus(r.bus).activeTimers, vi.getTimerCount()]).toEqual([1, 2]);
  });

  it('bus.dispose() clears the register timers; the plugin dispose() clears its own and forgets its windows', () => {
    const r = rig('register');
    r.send(1);
    r.bus.dispose();
    const afterRegister = vi.getTimerCount();
    const p = rig('plugin');
    p.send(1);
    p.plugin.dispose();
    const afterPlugin = vi.getTimerCount();
    expect({ afterRegister, afterPlugin, reopened: p.send(1) }).toEqual({ afterRegister: 0, afterPlugin: 0, reopened: 'ok' });
  });
});

describe('an undo of a throttled action', () => {
  // Scope, not the gate: the plugin matches `cart*` by name, which covers
  // `cartAdd$undo`; register({ throttle }) gates the one handler it wraps.
  // "throttle still refuses a `$reset`" is a control kept by log s35.150.
  const two = (kind: 'register' | 'plugin') => {
    const { bus } = rig(kind);
    const cmd = { action: 'cartAdd', target: { id: 1 }, payload: undefined };
    const a = bus.dispatch('cartAdd$undo', cmd);
    const b = bus.dispatch('cartAdd$undo', cmd);
    bus.dispose();
    return { a: a.ok, b: b.ok, code: (b.error as { code?: string })?.code };
  };
  it('register: the undo command is not gated', () => {
    expect(two('register')).toEqual({ a: true, b: true, code: undefined });
  });
  it('plugin over cart*: the second undo of one command inside the window is refused', () => {
    expect(two('plugin')).toEqual({ a: true, b: false, code: 'throttle:limited:handler' });
  });
});

describe('on an async bus with retry', () => {
  for (const kind of ['register', 'plugin'] as const) {
    it(`${kind}: the refusal is returned, not re-sent`, async () => {
      const bus = createAsyncCommandBus({ retry: { maxAttempts: 3, actionPolicies: { 'cart*': 'idempotent' } } });
      let runs = 0;
      if (kind === 'plugin') bus.use(throttle(['cart*'], WAIT));
      bus.register('cartAdd', async () => { runs++; return 1; }, kind === 'register' ? { throttle: WAIT } : {});
      await bus.dispatch('cartAdd', { id: 1 });
      const pending = bus.dispatch('cartAdd', { id: 1 });
      await vi.advanceTimersByTimeAsync(WAIT * 3);
      const r = await pending;
      expect({ ok: r.ok, code: (r.error as { code?: string })?.code, runs }).toEqual({ ok: false, code: `${kind === 'register' ? 'core' : 'throttle'}:limited:handler`, runs: 1 });
      bus.dispose();
    });
  }
});

/*
 * Plan 1.28 item 8 (log s35.207). One gate (`_throttleGate`,
 * src/command-bus.ts), two entry points: `register(..., { throttle })` gates
 * the handler, the `throttle()` plugin (src/plugins-core.ts) gates the chain
 * below it. The probe sends the same burst through both and records which
 * calls run, the refusal's code and owner, `retryIn`, and the timers left
 * after dispose.
 *
 * The same answer from both: the first call per action and target runs, a
 * repeat inside the window is refused with `retryIn` and `wait` in its
 * context, the window reopens after `wait`, a listener hears the refusal, and
 * neither refusal is re-sent by the async bus's retry. Dispose clears the
 * timers on both, and the plugin's own `dispose()` also forgets its windows.
 *
 * Two differences, both decided earlier. The refusal's owner: `core` for
 * `register`, `throttle` for the plugin (src/schema.ts, the whitepaper's
 * throttle row). The scope: the plugin matches its list by name, so `cart*`
 * also covers `cartAdd$undo`, and log s35.150 kept "throttle still refuses a
 * `$reset`" as a control. `register({ throttle })` gates the one handler it
 * wraps, never the undo command.
 */
