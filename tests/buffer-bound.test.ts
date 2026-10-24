/** createBuffer reads maxSize by the library's one rule, countOption (audit D7). Rationale at the end. */
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

/*
 * The buffer read its bound as `(maxBufferSize ?? 256) | 0`, the one count in
 * the library not read through ../bounds. `| 0` maps Infinity and NaN to 0
 * and wraps 3e9 to a negative number, so all three buffered nothing: every
 * dispatch made before its handler registered was dropped with a DEV warning.
 * The owner ruled for the right fix (audit D7, log s36.11). Since 1.32 step 4i
 * the queue is its own module (src/buffer.ts) and the bound is `maxSize`.
 */
