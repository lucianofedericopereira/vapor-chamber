/** Every timestamp the library produces, and its form (docs/timestamps.md, log s35.128). */
import { describe, expect } from 'vitest';
import { resetCommandBus, setCommandBus, useCommandError } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { metrics } from '../src/plugins-extra';
import { it } from '../src/vitest';

const isEpochMs = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && Math.abs((v as number) - Date.now()) < 60_000;

describe('inside the process: epoch milliseconds (a number)', () => {
  it('meta.ts on every command', () => {
    const bus = createCommandBus();
    let ts: unknown;
    bus.register('x', (cmd) => { ts = cmd.meta?.ts; return 1; });
    bus.dispatch('x', null);
    expect(isEpochMs(ts)).toBe(true);
  });

  it("the metrics plugin's entry timestamp", () => {
    const bus = createCommandBus();
    const m = metrics();
    bus.use(m);
    bus.register('x', () => 1);
    bus.dispatch('x', null);
    expect(isEpochMs(m.entries()[0].timestamp)).toBe(true);
  });

  it("useCommandError's entry timestamp", () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    const errs = useCommandError();
    bus.register('x', () => { throw new Error('down'); });
    bus.dispatch('x', null);
    expect(isEpochMs(errs.errors.value[0].timestamp)).toBe(true);
    errs.dispose();
    resetCommandBus();
  });
});
