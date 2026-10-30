/**
 * Plugin installation on the sync, async and test buses: one install per plugin object, a warning for a shared id, and the parts inspect lists.
 * Why: a second use() of one object would place its parts twice (two rules, two steps, two observers) while one remover takes out one; two plugins sharing an id make their failures carry one owner.
 * Shows: re-installing the same object throws `core:invalid:plugin` until it is removed, new instances install, a shared id warns once and both install, plugins without an id do not warn, and inspect names each plugin's declared parts in bus order.
 * See: log s36.115.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BaseBus, type PluginParts, createAsyncCommandBus, createCommandBus, inspectBus } from '../src/command-bus';
import { createTestBus } from '../src/testing';

const BUSES: Array<[string, () => BaseBus]> = [
  ['sync', () => createCommandBus()],
  ['async', () => createAsyncCommandBus({ retry: false })],
  ['test', () => createTestBus({ passthroughHandlers: true })],
];
const codeOf = (f: () => unknown) => { try { f(); } catch (e) { return (e as { code?: string }).code; } return 'no throw'; };
const plugins = (bus: BaseBus) => ('inspect' in bus && typeof bus.inspect === 'function' ? (bus.inspect() as { plugins: unknown[] }).plugins : inspectBus(bus).plugins);

afterEach(() => { vi.restoreAllMocks(); });

describe.each(BUSES)('installing a plugin on the %s bus', (_name, make) => {
  it('a second use() of the same plugin is refused, and its removal allows it again', () => {
    const bus = make();
    const p: PluginParts = { settled() {} };
    const off = bus.use(p);
    expect(codeOf(() => bus.use(p))).toBe('core:invalid:plugin');
    off();
    expect(codeOf(() => bus.use(p))).toBe('no throw');
  });

  it('control: two instances of one plugin install', () => {
    const bus = make();
    const make1 = (): PluginParts => ({ settled() {} });
    expect(codeOf(() => { bus.use(make1()); bus.use(make1()); })).toBe('no throw');
  });

  it('two plugins sharing an id are said once each, and both install', () => {
    const bus = make();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.use({ id: 'log', settled() {} });
    expect(warn).not.toHaveBeenCalled();
    bus.use({ id: 'log', actions: ['a*'], settled() {} });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('"log"');
    expect(plugins(bus)).toHaveLength(2);
  });

  it('control: plugins without an id are not said', () => {
    const bus = make();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    bus.use({ settled() {} });
    bus.use({ settled() {} });
    expect(warn).not.toHaveBeenCalled();
  });

  it('inspect names the parts each plugin declares, in one order', () => {
    const bus = make();
    bus.use({ id: 'a', authorize: () => undefined, settled() {}, started() {} });
    bus.use({ id: 'b', admit: () => undefined, begin: () => undefined, attach: () => {} });
    expect((plugins(bus) as Array<{ parts: string[] }>).map((p) => p.parts)).toEqual([
      ['started', 'settled', 'authorize'],
      ['admit', 'begin', 'attach'],
    ]);
  });
});
