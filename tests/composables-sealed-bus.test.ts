/**
 * Composables observe a sealed bus: seal protects the topology, not the observation layer.
 * Why: useCommandError and useCommandHistory add an after-hook, which a sealed bus refuses; they install it past the seal and seal again.
 * Shows: both record on a sealed bus, which stays sealed and still refuses register; useSharedCommandState works there; an unsealed bus stays unsealed.
 * See: audit B13, log s35.173.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resetCommandBus, setCommandBus, useCommandError, useCommandHistory, useSharedCommandState } from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

afterEach(() => resetCommandBus());

function sealedBus() {
  const bus = createCommandBus();
  bus.register('inc', () => 1, { undo: () => {} });
  bus.register('fail', () => { throw new Error('boom'); });
  setCommandBus(bus);
  bus.seal();
  return bus;
}

describe('on a sealed bus', () => {
  it('useCommandError records failures, and the bus stays sealed', () => {
    const bus = sealedBus();
    const { errors, dispose } = useCommandError();
    bus.dispatch('fail', null);
    expect(errors.value).toHaveLength(1);
    expect(bus.isSealed()).toBe(true);
    expect(() => bus.register('later', () => 1)).toThrow();
    dispose();
  });

  it('useCommandHistory records commands, and the bus stays sealed', () => {
    const bus = sealedBus();
    const hist = useCommandHistory();
    bus.dispatch('inc', null);
    expect(hist.canUndo.value).toBe(true);
    expect(bus.isSealed()).toBe(true);
    hist.dispose();
  });
});

describe('controls', () => {
  it('useSharedCommandState on a sealed bus, as released', () => {
    sealedBus();
    expect(useSharedCommandState().pending('x').value).toBe(false);
  });

  it('on an unsealed bus nothing changes: still unsealed', () => {
    const bus = createCommandBus();
    setCommandBus(bus);
    const { dispose } = useCommandError();
    expect(bus.isSealed()).toBe(false);
    dispose();
  });
});
