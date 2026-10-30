/**
 * The generated HMR shim (virtual:vapor-chamber-hmr) on first load and on reload.
 * Why: if the shim created or read a bus on first load, an app's own setCommandBus() would warn and a reload could replace the app's bus.
 * Shows: first load creates no bus and setCommandBus() does not warn, a reload with no stored bus leaves the app's bus alone, and a reload restores the bus the dispose hook stored.
 * See: handoff finding 13, log s35.123.
 */
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';
import { vaporChamberHMR } from '../src/vite-hmr';
import { it } from '../src/vitest';

const KEY = '__VAPOR_CHAMBER_BUS__';

/** The generated shim, run here: its imports bound to the library source, no import.meta.hot. */
async function runShim(): Promise<void> {
  const code: string = await (vaporChamberHMR() as any).load('\0virtual:vapor-chamber-hmr');
  const body = code
    .replace(/^import .*$/gm, '')
    .replace(/^export .*$/gm, '')
    .replace(/import\.meta\.hot/g, 'undefined');
  new Function('getCommandBus', 'setCommandBus', 'resetCommandBus', 'isVaporAvailable', body)(
    getCommandBus, setCommandBus, resetCommandBus, () => false,
  );
}

// The suite's plugin installs a shared bus before each test; an app's first load has none.
beforeEach(() => resetCommandBus());

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[KEY];
  resetCommandBus();
  vi.restoreAllMocks();
});

describe('the HMR shim on first load', () => {
  it("does not create the shared bus, so the app's setCommandBus() does not warn", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runShim();
    const appBus = createCommandBus();
    setCommandBus(appBus);
    expect(warn).not.toHaveBeenCalled();
    expect(getCommandBus()).toBe(appBus);
  });

  it('a reload before any dispose stored a bus leaves the shared bus alone', async () => {
    await runShim();
    const appBus = createCommandBus();
    setCommandBus(appBus);
    await runShim(); // the marker is null: nothing to restore
    expect(getCommandBus()).toBe(appBus);
  });

  it('on a reload restores the bus the dispose hook stored', async () => {
    await runShim(); // first load
    const appBus = createCommandBus();
    setCommandBus(appBus);
    (globalThis as Record<string, unknown>)[KEY] = appBus; // what dispose() stores
    resetCommandBus(); // a module re-evaluated without its bus
    await runShim(); // the reload
    expect(getCommandBus()).toBe(appBus);
  });
});
