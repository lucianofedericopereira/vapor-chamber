/**
 * A store `answer` that returns something other than an object writes nothing, the rule a declared `stores` value follows.
 * Why: writing null or undefined as the state would make every reader of `state.value.items` throw, and with `version` the version read would throw inside the transport step and fail a dispatch the server already applied.
 * Shows: null, a number and undefined from `answer` leave the state alone, the dispatch is ok, development warns once; the same holds with `version`; an object answer is written.
 * See: tests/store-declared-by-server.test.ts, log s35.186
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { defineChamberStore } from '../src/store';
import { httpTransport } from '../src/transports';

type Cart = { items: number[]; v?: number };
// Sent: no local change, the answer is the state.
const reducers = { add: null };

/** An http client whose post answers `{ state }` with each value in turn. */
const answering = (...states: unknown[]) => ({
  post: vi.fn(async () => ({ ok: true, status: 200, data: { state: states.shift() }, headers: {} })),
});

afterEach(() => { vi.restoreAllMocks(); });

describe('an answer that is not a state', () => {
  it('null, a number or undefined from `answer` is not written; the dispatch is ok; development warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', httpClient: answering(null, 3, { items: [7] }) as never }) });
    let mapped = 0;
    const cart = defineChamberStore('cart', {
      state: (): Cart => ({ items: [1] }),
      reducers,
      // The third reply maps to undefined, as a mapper that forgot to return would.
      answer: (_s, value) => (++mapped === 3 ? undefined : value) as Cart,
    })(bus);

    for (let i = 0; i < 3; i++) expect((await cart.add(2)).ok).toBe(true);

    expect(cart.state.value).toEqual({ items: [1] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('not an object');
    cart.$dispose();
  });

  it('with `version`, a null answer is not written and the dispatch is ok', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', httpClient: answering(null) as never }) });
    const cart = defineChamberStore('cart', {
      state: (): Cart => ({ items: [1], v: 1 }),
      reducers,
      answer: (_s, value) => value as Cart,
      version: (s) => s.v as number,
    })(bus);
    const r = await cart.add(2);
    expect(r.ok).toBe(true);
    expect(cart.state.value).toEqual({ items: [1], v: 1 });
    cart.$dispose();
  });

  it('control: an object answer is written', async () => {
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/vc', httpClient: answering({ items: [9] }) as never }) });
    const cart = defineChamberStore('cart', { state: (): Cart => ({ items: [1] }), reducers, answer: (_s, value) => value as Cart })(bus);
    await cart.add(2);
    expect(cart.state.value).toEqual({ items: [9] });
    cart.$dispose();
  });
});
