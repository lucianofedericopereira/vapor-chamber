/**
 * createBuffer reads maxSize by the library's one rule, countOption.
 * Why: `| 0` maps Infinity and NaN to 0 and wraps 3e9 negative, dropping every dispatch made before its handler registered.
 * Shows: sync and async, Infinity keeps all, NaN takes the default 256, a bound past 2^31 is kept; 2 keeps the newest two, 0 keeps none.
 * See: audit D7, log s36.11, tests/bounds.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBuffer } from '../src/buffer';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';

function replayed(make: typeof createCommandBus, maxSize: unknown): unknown[] {
  using _warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const bus = make({ buffer: createBuffer({ maxSize: maxSize as number }) });
  for (let i = 0; i < 3; i++) bus.dispatch('late', i);
  const got: unknown[] = [];
  bus.register('late', (cmd) => { got.push(cmd.target); return 1; });
  return got;
}

describe('maxSize', () => {
  for (const [name, make] of [['sync', createCommandBus], ['async', createAsyncCommandBus]] as const) {
    it(`${name}: Infinity keeps every early dispatch (no bound)`, () => {
      expect(replayed(make as typeof createCommandBus, Infinity)).toEqual([0, 1, 2]);
    });

    it(`${name}: NaN takes the default 256, as every other count does`, () => {
      expect(replayed(make as typeof createCommandBus, Number('nope'))).toEqual([0, 1, 2]);
    });

    it(`${name}: a bound past 2^31 is kept, not wrapped negative`, () => {
      expect(replayed(make as typeof createCommandBus, 3e9)).toEqual([0, 1, 2]);
    });

    it(`${name}: control, a bound of 2 keeps the newest two and 0 keeps none`, () => {
      expect(replayed(make as typeof createCommandBus, 2)).toEqual([1, 2]);
      expect(replayed(make as typeof createCommandBus, 0)).toEqual([]);
    });
  }
});
