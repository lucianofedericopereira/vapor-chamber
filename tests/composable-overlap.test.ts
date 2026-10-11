/**
 * Overlapping dispatches through one composable.
 *
 * `loading` was one boolean written per dispatch, so the first dispatch to
 * settle cleared it while another still ran; and useCommandQuery's `data` took
 * every answer in the order they landed, so an older query answering last
 * overwrote the latest (search-as-you-type showed "ab" results under "abc").
 * Now `loading` holds while any dispatch is in flight and `data` is the latest
 * query's answer. `lastError` stays the last failure to arrive.
 */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { useCommand, useCommandQuery } from '../src/chamber';
import { useVaporAsyncCommand } from '../src/chamber-vapor';

const gated = () => {
  const bus = createAsyncCommandBus({ retry: false });
  const gates = new Map<string, () => void>();
  bus.register('save', (cmd) => new Promise((r) => gates.set(String(cmd.target.id), () => r(cmd.target.id))));
  bus.register('search', (cmd) => new Promise((r) => gates.set(cmd.target.q, () => r(`results for ${cmd.target.q}`))));
  bus.register('fail', (cmd) => new Promise((_r, j) => gates.set(String(cmd.target.id), () => j(new Error(`failed ${cmd.target.id}`)))));
  const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { bus, gates, tick };
};

describe('composables - overlapping dispatches', () => {
  it('useCommand stays loading until the last one settles', async () => {
    const { bus, gates, tick } = gated();
    const { dispatch, loading } = useCommand({ bus });
    const a = dispatch('save' as never, { id: 1 } as never);
    const b = dispatch('save' as never, { id: 2 } as never);
    await tick();
    gates.get('1')!(); await a;
    expect(loading.value).toBe(true);
    gates.get('2')!(); await b;
    expect(loading.value).toBe(false);
  });

  it('useVaporAsyncCommand stays loading until the last one settles', async () => {
    const { bus, gates, tick } = gated();
    const { dispatch, loading } = useVaporAsyncCommand(bus);
    const a = dispatch('save', { id: 1 });
    const b = dispatch('save', { id: 2 });
    await tick();
    gates.get('1')!(); await a;
    expect(loading.value).toBe(true);
    gates.get('2')!(); await b;
    expect(loading.value).toBe(false);
  });

  it("useCommandQuery's data is the latest query's answer", async () => {
    const { bus, gates, tick } = gated();
    const { query, data, loading } = useCommandQuery({ bus });
    const older = query('search', { q: 'ab' });
    const newer = query('search', { q: 'abc' });
    await tick();
    gates.get('abc')!(); await newer;
    gates.get('ab')!(); await older;
    expect(data.value).toBe('results for abc');
    expect(loading.value).toBe(false);
  });

  it('lastError keeps an older failure that lands after a newer success', async () => {
    const { bus, gates, tick } = gated();
    const { dispatch, lastError } = useCommand({ bus });
    const failing = dispatch('fail' as never, { id: 1 } as never);
    const ok = dispatch('save' as never, { id: 2 } as never);
    await tick();
    gates.get('2')!(); await ok;
    gates.get('1')!(); await failing;
    expect(lastError.value?.message).toContain('failed 1');
  });

  it('a nested dispatch on a sync bus keeps the outer one loading', () => {
    const bus = createCommandBus();
    const { dispatch, loading } = useCommand({ bus });
    let inner: boolean | undefined;
    bus.register('outer', () => { dispatch('inner' as never, {} as never); inner = loading.value; return 1; });
    bus.register('inner', () => 2);
    dispatch('outer' as never, {} as never);
    expect({ inner, after: loading.value }).toEqual({ inner: true, after: false });
  });
});

describe('runDispatch - a failure while another dispatch is in flight', () => {
  it('a sync throw leaves loading true for the one still running', async () => {
    const { runDispatch } = await import('../src/chamber');
    const { signal } = await import('../src/signal');
    const loading = signal(true);
    const lastError = signal<Error | null>(null);
    const throwing = { dispatch: () => { throw new Error('boom'); } } as never;
    runDispatch(throwing, false, 'x', undefined, undefined, loading, lastError, { n: 1, seq: 1 });
    expect(loading.value).toBe(true);
    expect(lastError.value?.message).toBe('boom');
  });

  it('a rejection leaves loading true for the one still running', async () => {
    const { runDispatch } = await import('../src/chamber');
    const { signal } = await import('../src/signal');
    const loading = signal(true);
    const lastError = signal<Error | null>(null);
    const rejecting = { dispatch: () => Promise.reject(new Error('lost')) } as never;
    await runDispatch(rejecting, false, 'x', undefined, undefined, loading, lastError, { n: 1, seq: 1 });
    expect(loading.value).toBe(true);
    expect(lastError.value?.message).toBe('lost');
  });
});
