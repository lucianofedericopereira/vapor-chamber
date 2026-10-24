/** The library's `$` commands are state changes: cache and idempotent never answer one from memory. Log s35.150. */
import { describe, expect, it } from 'vitest';
import { createAsyncCommandBus, createCommandBus, type Command, type CommandResult } from '../src/command-bus';
import { cache, idempotent, supersede } from '../src/plugins-extra';
import { defineChamberStore } from '../src/store';

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
  it('a plugin with no actions still sees every $ command', () => {
    const bus = createCommandBus();
    const seen: string[] = [];
    bus.use({ started: (cmd) => { seen.push(cmd.action); } });
    const cart = useCart(bus);
    cart.$reset();
    expect(seen).toEqual(['cart$reset']);
    cart.$dispose();
  });
});

/*
 * Log s35.150. A `$` name is the library's
 * own command (src/library-names.ts): `<id>$reset`,
 * `<action>$undo`. Each is a state change. A plugin may refuse one (35.114:
 * rateLimit, circuitBreaker; the caller sees it), but cache()
 * stored the first `$reset` and answered the second from memory with
 * `ok: true`, and idempotent() collapsed it the same way. The sender's
 * `pace` runs a `$` call at once (tests/pace.test.ts).
 *
 * The fix sits where it costs least: cache does not STORE a `$` result (its
 * miss path; a hit pays nothing), idempotent does not RECORD one (its
 * completion path).
 * history sends the same recorded command to `$undo` after a redo
 * (ledger.ts), so the second test is that case. supersede() neither answers
 * nor postpones (probe P2); its one effect on an undo, the aborted signal an
 * inverse receives, is pinned here and stated on RegisterOptions.undo.
 */
