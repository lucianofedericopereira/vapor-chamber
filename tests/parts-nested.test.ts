/**
 * A plugin's parts (cache, idempotent, metrics) when another command runs between one command's parts, on a sync bus.
 * Why: these plugins keep the latest command in two fields, so a nested dispatch would leave the fields naming the inner command and the outer one would be cached, recorded or timed under the wrong key.
 * Shows: cache stores the first command under its own key; idempotent collapses the repeat of the first command, and with no key records nothing; metrics times outer and inner each from its own start, and a command settled without a start it saw reads 0 ms.
 * See: log s36.105, s36.107
 */
import { describe, expect, it } from 'vitest';
import { type Command, type PluginParts, createCommandBus } from '../src/command-bus';
import { cache, idempotent, metrics } from '../src/plugins-extra';

/** A limit whose admit dispatches `side` once, between a step's reuse and its begin for `load`. */
const nesting = (bus: { dispatch(a: string, t: unknown): unknown }): PluginParts => {
  let done = false;
  return { id: 'nest', admit: (cmd: Command) => { if (cmd.action === 'load' && !done) { done = true; bus.dispatch('side', {}); } return undefined; } };
};

describe('a step whose reuse and begin are split by a nested command', () => {
  it('cache still stores the first command under its own key', () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('load', (cmd: Command) => { runs++; return cmd.target.id; });
    bus.register('side', () => 0);
    bus.use(cache());
    bus.use(nesting(bus));
    expect(bus.dispatch('load', { id: 1 })).toMatchObject({ ok: true, value: 1 });
    expect(bus.dispatch('load', { id: 1 })).toMatchObject({ ok: true, value: 1 });
    expect(runs).toBe(1);
  });

  it('idempotent still collapses the repeat of the first command', () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('load', () => { runs++; return runs; });
    bus.register('side', () => 0);
    bus.use(idempotent({ key: (cmd) => (cmd.action === 'load' ? 'k' : 'side') }));
    bus.use(nesting(bus));
    bus.dispatch('load', {});
    bus.dispatch('load', {});
    expect(runs).toBe(1);
  });

  it('control: idempotent with no key for the command records nothing, nested or not', () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('load', () => { runs++; return runs; });
    bus.register('side', () => 0);
    bus.use(idempotent({ key: () => null }));
    bus.use(nesting(bus));
    bus.dispatch('load', {});
    bus.dispatch('load', {});
    expect(runs).toBe(2);
  });
});

describe('metrics when commands nest', () => {
  it('times the outer and the inner command, each from its own start', () => {
    const bus = createCommandBus();
    const m = metrics();
    bus.use(m);
    bus.register('inner', () => 1);
    bus.register('outer', () => bus.dispatch('inner', {}).value);
    bus.dispatch('outer', {});
    expect(m.entries().map((e) => [e.action, e.ok, e.durationMs >= 0])).toEqual([['inner', true, true], ['outer', true, true]]);
  });

  it('a command that settles without a start it saw reads 0 ms, before and after a nesting', () => {
    const bus = createCommandBus();
    bus.use({ settled() {} }); // off the bare path, which settles nothing
    const m = metrics();
    bus.register('x', () => { bus.use(m); return 1; });
    bus.dispatch('x', {}); // installed mid-dispatch: no start of its own
    expect(m.entries().map((e) => [e.action, e.durationMs])).toEqual([['x', 0]]);
    const bus2 = createCommandBus();
    bus2.use({ settled() {} });
    const m2 = metrics();
    const off = bus2.use(m2);
    bus2.register('inner', () => 1);
    bus2.register('outer', () => bus2.dispatch('inner', {}).value);
    bus2.dispatch('outer', {}); // the nesting builds its map of starts
    off();
    bus2.register('y', () => { bus2.use(m2); return 1; });
    bus2.dispatch('y', {});
    expect(m2.entries().map((e) => [e.action, e.durationMs])).toEqual([['inner', expect.any(Number)], ['outer', expect.any(Number)], ['y', 0]]);
  });
});
