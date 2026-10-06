/** The library's `$` commands are state changes: cache and idempotent never answer one from memory, debounce never postpones one. Log s35.150. */
import { afterEach, describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type Command, type CommandResult } from '../src/command-bus';
import { debounce, throttle } from '../src/plugins-core';
import { cache, idempotent, supersede } from '../src/plugins-extra';
import { defineChamberStore } from '../src/store';

const disposers: Array<{ dispose(): void }> = [];
afterEach(() => { for (const d of disposers.splice(0)) d.dispose(); });
const keep = <T extends { dispose(): void }>(p: T): T => { disposers.push(p); return p; };

// A sync bus answers now; the store types its calls for either bus.
const now = (r: CommandResult | Promise<CommandResult>): CommandResult => r as CommandResult;

type Cart = { items: string[] };
const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ items: [] }),
  reducers: { add: (s: Cart, item: string) => ({ items: [...s.items, item] }) },
});

describe('cache()', () => {
  it('a second $reset within the TTL resets again', () => {
    const bus = createCommandBus();
    bus.use(cache());
    const cart = useCart(bus);
    cart.add('milk');
    cart.$reset();
    cart.add('eggs');
    expect(now(cart.$reset()).ok).toBe(true);
    expect(cart.state.value.items).toEqual([]);
    cart.$dispose();
  });

  it('the same $undo twice runs the inverse twice (history sends the recorded command again after a redo)', () => {
    const bus = createCommandBus();
    bus.use(cache());
    let applied = 0;
    bus.register('inc', () => ++applied, { undo: () => { applied--; } });
    const cmd = { action: 'inc', target: null, meta: { id: 'c1' } } as unknown as Command;
    bus.dispatch('inc$undo', cmd);
    bus.dispatch('inc$undo', cmd);
    expect(applied).toBe(-2);
  });

  it('control: an app action is still cached', () => {
    const bus = createCommandBus();
    bus.use(cache());
    let loads = 0;
    bus.register('load', () => ++loads);
    bus.dispatch('load', 1);
    expect(bus.dispatch('load', 1).value).toBe(1);
    expect(loads).toBe(1);
  });
});

describe('idempotent()', () => {
  it('a second $reset within the TTL resets again', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(idempotent());
    const cart = useCart(bus);
    await cart.add('milk');
    await cart.$reset();
    await cart.add('eggs');
    expect((await cart.$reset()).ok).toBe(true);
    expect(cart.state.value.items).toEqual([]);
    cart.$dispose();
  });

  it('control: an app action is still collapsed', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(idempotent());
    let runs = 0;
    bus.register('order', async () => ++runs);
    await bus.dispatch('order', 1);
    expect((await bus.dispatch('order', 1)).value).toBe(1);
    expect(runs).toBe(1);
  });
});

describe('debounce()', () => {
  it('a $ command its list matches runs now', () => {
    const bus = createCommandBus();
    bus.use(keep(debounce(['cart*'], 50)));
    const cart = useCart(bus);
    expect(now(cart.$reset()).value).toEqual({ items: [] });
    cart.$dispose();
  });

  it('control: an app action its list matches is still postponed', () => {
    const bus = createCommandBus();
    bus.use(keep(debounce(['cart*'], 50)));
    const cart = useCart(bus);
    expect(now(cart.add('milk')).value).toMatchObject({ pending: true });
    expect(cart.state.value.items).toEqual([]);
    cart.$dispose();
  });
});

describe('supersede(): left as it is (docs only)', () => {
  it('an inverse receives the original command, whose signal supersede aborted', async () => {
    const bus = createAsyncCommandBus({ retry: false });
    bus.use(supersede());
    const ran: Command[] = [];
    const seen: Array<boolean | undefined> = [];
    bus.register('save', async (cmd) => { ran.push(cmd); await new Promise((r) => setTimeout(r, 0)); return 1; }, { undo: (orig) => { seen.push(orig.signal?.aborted); } });
    await Promise.all([bus.dispatch('save', 1), bus.dispatch('save', 1)]);
    expect((await bus.dispatch('save$undo', ran[0])).ok).toBe(true);
    expect((await bus.dispatch('save$undo', ran[1])).ok).toBe(true);
    expect(seen).toEqual([true, false]);
  });
});

describe('controls: refusing a $ command stays allowed and visible', () => {
  it('throttle still refuses a second $reset', () => {
    const bus = createCommandBus();
    bus.use(keep(throttle(['cart*'], 1_000)));
    const cart = useCart(bus);
    expect(now(cart.$reset()).ok).toBe(true);
    expect(now(cart.$reset()).ok).toBe(false);
    cart.$dispose();
  });

  it('a plugin with no actions still sees every $ command', () => {
    const bus = createCommandBus();
    const seen: string[] = [];
    bus.use((cmd, next) => { seen.push(cmd.action); return next(); });
    const cart = useCart(bus);
    cart.$reset();
    expect(seen).toEqual(['cart$reset']);
    cart.$dispose();
  });
});

/*
 * Plan .probes/1.27-plan.md item 6, as written. A `$` name is the library's
 * own command (src/library-names.ts): `<id>$reset`, `<id>$sync`,
 * `<action>$undo`. Each is a state change. A plugin may refuse one (35.114:
 * throttle, rateLimit, circuitBreaker; the caller sees it), but cache()
 * stored the first `$reset` and answered the second from memory with
 * `ok: true`, idempotent() collapsed it the same way, and debounce(['cart*'])
 * answered `cart$reset` with `{ pending }`.
 *
 * The fix sits where it costs least: cache does not STORE a `$` result (its
 * miss path; a hit pays nothing), idempotent does not RECORD one (its
 * completion path), debounce hands one on (its body; not a hot path).
 * history sends the same recorded command to `$undo` after a redo
 * (ledger.ts), so the second test is that case. supersede() neither answers
 * nor postpones (probe P2); its one effect on an undo, the aborted signal an
 * inverse receives, is pinned here and stated on RegisterOptions.undo.
 */
