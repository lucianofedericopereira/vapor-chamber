/**
 * A sync handler on the async bus answers with no async frame of its own.
 * Why: every store reducer on an async bus is a sync handler; wrapping it in an async function costs each local command a promise and an await.
 * Shows: a sync handler settles in fewer turns than an async one, the counter sees one await; values, throws, promises, rejections and its own abort answer as they should.
 * See: tests/abort.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { defineTransport } from '../src/transports';

/** Microtask turns between the call and its promise settling. */
async function turns(p: Promise<unknown>): Promise<number> {
  let done = false;
  p.then(() => { done = true; });
  let n = 0;
  while (!done && n < 1_000) {
    await null;
    n++;
  }
  return n;
}

describe('a sync handler on the async bus', () => {
  it('settles in fewer turns than an async handler, dispatch and query', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('now', (cmd) => cmd.target);
    bus.register('later', async (cmd) => cmd.target);
    expect(await turns(bus.dispatch('now', 1))).toBeLessThan(await turns(bus.dispatch('later', 1)));
    expect(await turns(bus.query('now', 1))).toBeLessThan(await turns(bus.query('later', 1)));
  });

  it('control: an async handler with one more await costs one more turn', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('later', async (cmd) => cmd.target);
    bus.register('slower', async (cmd) => { await null; return cmd.target; });
    expect(await turns(bus.dispatch('slower', 1))).toBeGreaterThan(await turns(bus.dispatch('later', 1)));
  });
});

describe('a sync handler keeps its answers', () => {
  it('a value, a throw, a returned promise and a rejected one', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.register('value', () => 7);
    bus.register('throws', () => { throw new Error('no'); });
    bus.register('promise', () => Promise.resolve(8));
    bus.register('rejects', () => Promise.reject(new Error('later no')));
    expect(await bus.dispatch('value', 0)).toEqual({ ok: true, value: 7, error: undefined });
    expect((await bus.dispatch('throws', 0)).error?.message).toBe('no');
    expect(await bus.dispatch('promise', 0)).toEqual({ ok: true, value: 8, error: undefined });
    expect((await bus.dispatch('rejects', 0)).error?.message).toBe('later no');
  });

  it('a throw of its own signal\'s reason is that abort', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    const ac = new AbortController();
    bus.register('cancel', (cmd) => { ac.abort(); cmd.signal!.throwIfAborted(); });
    const r = await bus.dispatch('cancel', 0, undefined, { signal: ac.signal });
    expect((r.error as { code?: string }).code).toBe('core:aborted:dispatch');
  });

  it('a transport\'s local fallback still gets a promise from a sync handler', async () => {
    let local: unknown;
    const transport = defineTransport((_cmd, fallback) => { local = fallback(); return local as Promise<never>; }, { localFallback: true });
    const bus = createAsyncCommandBus({ retry: false, transport });
    bus.register('go', () => 1);
    expect(await bus.dispatch('go', 0)).toEqual({ ok: true, value: 1, error: undefined });
    expect(local).toBeInstanceOf(Promise);
  });
});
