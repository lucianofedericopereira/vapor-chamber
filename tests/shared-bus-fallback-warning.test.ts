/**
 * setCommandBus() replacing a fallback bus that getCommandBus() already handed out warns once in DEV; the normal paths stay quiet.
 * Why: code that called getCommandBus() before the replacement would keep the old bus, splitting dispatches and listeners across two buses with no error; a warning on the HMR shim or the vitest setup file would be noise.
 * Shows: the warning fires once for a different bus, and not when the bus is set before any get, set again unchanged, or set after a reset; the vitest setup file swaps its bus without warning while the package build does warn.
 * See: log s35.73, src/shared-bus.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus, createCommandBus } from '../src/command-bus';
import { getCommandBus, resetCommandBus, setCommandBus } from '../src/shared-bus';

const SPLIT = /setCommandBus\(\) replaced the bus getCommandBus\(\) had created/;
const splitWarnings = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter((args: unknown[]) => SPLIT.test(String(args[0]))).length;

describe('shared bus: replacing the fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetCommandBus();
  });

  it('warns when a different bus replaces the fallback getCommandBus() handed out', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetCommandBus();
    const early = getCommandBus();
    setCommandBus(createAsyncCommandBus());
    expect(splitWarnings(warn)).toBe(1);
    expect(getCommandBus()).not.toBe(early);
  });

  it('warns once, not on every later replacement', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetCommandBus();
    getCommandBus();
    setCommandBus(createCommandBus());
    setCommandBus(createCommandBus());
    expect(splitWarnings(warn)).toBe(1);
  });

  it('is quiet when the bus is set before anything asked for one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetCommandBus();
    setCommandBus(createAsyncCommandBus());
    getCommandBus();
    setCommandBus(createCommandBus());
    expect(splitWarnings(warn)).toBe(0);
  });

  it('is quiet when the same bus is set again (the HMR shim restoring its bus)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetCommandBus();
    const kept = getCommandBus();
    setCommandBus(kept);
    expect(splitWarnings(warn)).toBe(0);
    expect(getCommandBus()).toBe(kept);
  });

  it('is quiet after resetCommandBus(): reset, then set', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    resetCommandBus();
    getCommandBus();
    resetCommandBus();
    setCommandBus(createCommandBus());
    expect(splitWarnings(warn)).toBe(0);
  });
});

describe('shared bus: the vitest setup file swaps quietly', () => {
  // A plain function, not vi.spyOn: restoreMocks would restore a spy before the setup file's beforeEach runs for the next test.
  const original = console.warn;
  const seen: string[] = [];

  // The setup file installs its bus through the package (dist), so the fallback must be left on the package's own shared bus.
  it('leaves a fallback bus behind', async () => {
    const vc = await import('vapor-chamber');
    vc.resetCommandBus();
    vc.getCommandBus();
    console.warn = (...args: unknown[]) => { seen.push(String(args[0])); };
  });

  it('the setup file installed a new bus before this test, with no warning', () => {
    console.warn = original;
    expect(seen.filter((m) => SPLIT.test(m))).toEqual([]);
  });

  it('positive control: the package does warn on that replacement', async () => {
    const vc = await import('vapor-chamber');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vc.resetCommandBus();
    vc.getCommandBus();
    vc.setCommandBus(vc.createCommandBus());
    expect(splitWarnings(warn)).toBe(1);
    vc.resetCommandBus();
  });
});
