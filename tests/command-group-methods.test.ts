/**
 * useCommandGroup's query, emit, use, on and dispose, inside its namespace.
 * Why: a group keeps everything it touches inside its prefix, and dispose takes back all it installed.
 * Shows: query and emit are namespaced; on('add') is the exact event, on('*') the whole namespace; use installs a plugin; dispose unhooks all three.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useCommandGroup, setCommandBus, resetCommandBus, getCommandBus } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

describe('useCommandGroup - query / emit / use / on / dispose', () => {
  beforeEach(() => setCommandBus(createCommandBus()));
  afterEach(() => resetCommandBus());

  it('namespaces query and emit', () => {
    const cart = useCommandGroup('cart');
    cart.register('total', () => 42);
    expect(cart.query('total', {}).value).toBe(42);

    const seen: any[] = [];
    cart.on('updated', (cmd) => seen.push(cmd.target));
    cart.emit('updated', { items: 3 });
    expect(seen).toEqual([{ items: 3 }]);
  });

  it('on(pattern) namespaces a specific event and on("*") matches the whole namespace', () => {
    const cart = useCommandGroup('cart');
    const exact: string[] = [];
    const all: string[] = [];
    cart.on('add', (cmd) => exact.push(cmd.action));   // -> 'cartAdd'
    cart.on('*', (cmd) => all.push(cmd.action));        // -> 'cart*'
    cart.register('add', () => {});
    cart.register('remove', () => {});
    cart.dispatch('add', {});
    cart.dispatch('remove', {});
    expect(exact).toEqual(['cartAdd']);                 // only the exact event
    expect(all).toEqual(['cartAdd', 'cartRemove']);     // wildcard over the namespace
  });

  it('use(plugin) installs a plugin scoped to the shared bus', () => {
    const cart = useCommandGroup('cart');
    const calls: string[] = [];
    cart.use({ started: (cmd) => { calls.push(cmd.action); } });
    cart.register('add', () => 1);
    cart.dispatch('add', {});
    expect(calls).toEqual(['cartAdd']);
  });

  it('dispose() unhooks registrations, listeners, and plugins', () => {
    const cart = useCommandGroup('cart');
    const calls: string[] = [];
    cart.use({ started: (_cmd) => { calls.push('plugin'); } });
    cart.on('*', () => calls.push('listener'));
    cart.register('add', () => { calls.push('handler'); });

    cart.dispatch('add', {});
    expect(calls).toEqual(['plugin', 'handler', 'listener']);

    calls.length = 0;
    cart.dispose();

    // handler unregistered -> dispatch misses; plugin + listener gone too
    const r = getCommandBus().dispatch('cartAdd', {});
    expect(r).toFailWith('core:missing:handler');
    expect(calls).toEqual([]);
  });
});
