/**
 * Overlapping queries through one useCommandQuery: `loading` and `data` while several are in flight.
 * Why: the first query to settle must not clear loading while another runs, and an older answer landing last must not overwrite the latest.
 * Shows: loading holds until the last query settles; data is the latest query's answer; a failure keeps loading and hands no data on; a nested sync query too.
 * See: tests/usecommand-pending.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { useCommandQuery } from '../src/chamber';

const gated = () => {
  const bus = createAsyncCommandBus({ retry: false });
  const gates = new Map<string, () => void>();
  bus.register('search', (cmd) => new Promise((r) => gates.set(cmd.target.q, () => r(`results for ${cmd.target.q}`))));
  bus.register('fail', (cmd) => new Promise((_r, j) => gates.set(String(cmd.target.id), () => j(new Error(`failed ${cmd.target.id}`)))));
  const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  return { bus, gates, tick };
};

describe('useCommandQuery - overlapping queries', () => {
  it('stays loading until the last one settles', async () => {
    const { bus, gates, tick } = gated();
    const { query, loading } = useCommandQuery({ bus });
    const a = query('search', { q: 'a' });
    const b = query('search', { q: 'b' });
    await tick();
    gates.get('a')!(); await a;
    expect(loading.value).toBe(true);
    gates.get('b')!(); await b;
    expect(loading.value).toBe(false);
  });

  it("data is the latest query's answer", async () => {
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

  it('a failure while another is in flight keeps loading, and hands no data on', async () => {
    const { bus, gates, tick } = gated();
    const { query, data, loading } = useCommandQuery({ bus });
    const failing = query('fail', { id: 1 });
    const live = query('search', { q: 'x' });
    await tick();
    gates.get('1')!(); await failing;
    expect({ loading: loading.value, data: data.value }).toEqual({ loading: true, data: null });
    gates.get('x')!(); await live;
    expect({ loading: loading.value, data: data.value }).toEqual({ loading: false, data: 'results for x' });
  });

  it('a nested query on a sync bus keeps the outer one loading', () => {
    const bus = createCommandBus();
    const { query, loading } = useCommandQuery({ bus });
    let inner: boolean | undefined;
    bus.register('outer', () => { query('inner', {}); inner = loading.value; return 1; });
    bus.register('inner', () => 2);
    query('outer', {});
    expect({ inner, after: loading.value }).toEqual({ inner: true, after: false });
  });
});

describe('runDispatch - a failure while another query is in flight', () => {
  it('a sync throw leaves loading true for the one still running', async () => {
    const { runDispatch } = await import('../src/chamber');
    const { signal } = await import('../src/signal');
    const loading = signal(true);
    const throwing = { query: () => { throw new Error('boom'); } } as never;
    const r = runDispatch(throwing, true, 'x', undefined, undefined, loading, { n: 1, seq: 1 }) as { ok: boolean; error?: Error };
    expect({ loading: loading.value, ok: r.ok, message: r.error?.message }).toEqual({ loading: true, ok: false, message: 'boom' });
  });

  it('a rejection leaves loading true for the one still running', async () => {
    const { runDispatch } = await import('../src/chamber');
    const { signal } = await import('../src/signal');
    const loading = signal(true);
    const rejecting = { query: () => Promise.reject(new Error('lost')) } as never;
    const r = await runDispatch(rejecting, true, 'x', undefined, undefined, loading, { n: 1, seq: 1 });
    expect({ loading: loading.value, ok: r.ok, message: r.error?.message }).toEqual({ loading: true, ok: false, message: 'lost' });
  });
});
