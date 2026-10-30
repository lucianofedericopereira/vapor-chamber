/**
 * A plugin's authorize and validate rules run only on the actions its scope (`actions` or `actionFilter`) covers.
 * Why: if rules ignored the scope, a gate scoped to one action would refuse every action, unlike the plugin's facts and work steps.
 * Shows: on the sync, async and test buses, a refusing rule blocks only its own action, and an `actionFilter` is asked once per action.
 */
import { describe, expect, it } from 'vitest';
import { type BaseBus, type CommandResult, type PluginParts, createAsyncCommandBus, createCommandBus, _errResult as err } from '../src/command-bus';
import { createTestBus } from '../src/testing';

const BUSES: Array<[string, () => BaseBus]> = [
  ['sync', () => createCommandBus()],
  ['async', () => createAsyncCommandBus({ retry: false })],
  ['test', () => createTestBus({ passthroughHandlers: true })],
];
const code = (r: CommandResult) => (r.ok ? 'ok' : (r.error as { code?: string }).code ?? r.error.message);
const refusing = (scope: Pick<PluginParts, 'actions' | 'actionFilter'>, part: 'authorize' | 'validate'): PluginParts => ({
  id: 'gate',
  ...scope,
  [part]: () => (_cmd: unknown, fail: (c: `${string}:${string}`, m: string) => Error) => err(fail('refused:action', 'refused')),
});

describe.each(BUSES)('rule scope on the %s bus', (_name, make) => {
  for (const part of ['authorize', 'validate'] as const) {
    it(`the ${part} rule with actions refuses only its actions`, async () => {
      const bus = make();
      bus.register('a', () => 1);
      bus.register('b', () => 2);
      bus.use(refusing({ actions: ['a'] }, part));
      expect(code(await bus.dispatch('a', {}))).toBe('gate:refused:action');
      expect(code(await bus.dispatch('b', {}))).toBe('ok');
    });

    it(`the ${part} rule with an actionFilter refuses only what it lets in, asked once per action`, async () => {
      const bus = make();
      bus.register('a', () => 1);
      bus.register('b', () => 2);
      const asked: string[] = [];
      bus.use(refusing({ actionFilter: (action) => { asked.push(action); return action === 'a'; } }, part));
      expect(code(await bus.dispatch('a', {}))).toBe('gate:refused:action');
      expect(code(await bus.dispatch('b', {}))).toBe('ok');
      expect(code(await bus.dispatch('b', {}))).toBe('ok');
      expect(asked).toEqual(['a', 'b']);
    });
  }
});
