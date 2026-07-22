/**
 * Tests for transitions.ts — createTransitionBridge + useTransitionCommand
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createCommandBus,
  createAsyncCommandBus,
  setCommandBus,
  resetCommandBus,
} from '../src';
import { createTransitionBridge, useTransitionCommand } from '../src/transitions';

// Minimal mock element
function mockEl(): Element {
  return { tagName: 'DIV' } as unknown as Element;
}

describe('createTransitionBridge', () => {
  let bus: ReturnType<typeof createCommandBus>;

  beforeEach(() => {
    bus = createCommandBus({ onMissing: 'ignore' });
    setCommandBus(bus);
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('dispatches namespaced actions for all 8 hooks', () => {
    const dispatched: string[] = [];
    bus.onAfter((cmd) => dispatched.push(cmd.action));

    const t = createTransitionBridge({ bus, namespace: 'modal' });
    const el = mockEl();
    const done = vi.fn();

    t.onBeforeEnter(el);
    t.onEnter(el, done);
    t.onAfterEnter(el);
    t.onEnterCancelled(el);
    t.onBeforeLeave(el);
    t.onLeave(el, done);
    t.onAfterLeave(el);
    t.onLeaveCancelled(el);

    expect(dispatched).toEqual([
      'modalBeforeEnter',
      'modalEnter',
      'modalAfterEnter',
      'modalEnterCancelled',
      'modalBeforeLeave',
      'modalLeave',
      'modalAfterLeave',
      'modalLeaveCancelled',
    ]);
  });

  it('dispatches un-namespaced actions when no namespace given', () => {
    const dispatched: string[] = [];
    bus.onAfter((cmd) => dispatched.push(cmd.action));

    const t = createTransitionBridge({ bus });
    const el = mockEl();
    const done = vi.fn();

    t.onBeforeEnter(el);
    t.onEnter(el, done);
    t.onAfterEnter(el);

    expect(dispatched).toEqual(['beforeEnter', 'enter', 'afterEnter']);
  });

  it('target carries the DOM element', () => {
    let receivedTarget: any;
    bus.register('modalBeforeEnter', (cmd) => { receivedTarget = cmd.target; });

    const t = createTransitionBridge({ bus, namespace: 'modal' });
    const el = mockEl();

    t.onBeforeEnter(el);

    expect(receivedTarget).toBe(el);
  });

  it('phase transitions: idle → entering → idle', () => {
    const t = createTransitionBridge({ bus });
    const el = mockEl();

    expect(t.phase.value).toBe('idle');

    t.onBeforeEnter(el);
    expect(t.phase.value).toBe('entering');

    t.onAfterEnter(el);
    expect(t.phase.value).toBe('idle');
  });

  it('phase transitions: idle → leaving → idle', () => {
    const t = createTransitionBridge({ bus });
    const el = mockEl();

    t.onBeforeLeave(el);
    expect(t.phase.value).toBe('leaving');

    t.onAfterLeave(el);
    expect(t.phase.value).toBe('idle');
  });

  it('onEnterCancelled resets phase to idle', () => {
    const t = createTransitionBridge({ bus });
    const el = mockEl();

    t.onBeforeEnter(el);
    expect(t.phase.value).toBe('entering');

    t.onEnterCancelled(el);
    expect(t.phase.value).toBe('idle');
  });

  it('onLeaveCancelled resets phase to idle', () => {
    const t = createTransitionBridge({ bus });
    const el = mockEl();

    t.onBeforeLeave(el);
    expect(t.phase.value).toBe('leaving');

    t.onLeaveCancelled(el);
    expect(t.phase.value).toBe('idle');
  });

  it('done() called synchronously when handler is sync', () => {
    bus.register('enter', () => 'animated');
    const t = createTransitionBridge({ bus });
    const done = vi.fn();

    t.onEnter(mockEl(), done);

    expect(done).toHaveBeenCalledTimes(1);
  });

  it('done() called even when handler throws', () => {
    bus.register('enter', () => { throw new Error('animation failed'); });
    const t = createTransitionBridge({ bus });
    const done = vi.fn();

    t.onEnter(mockEl(), done);

    expect(done).toHaveBeenCalledTimes(1);
  });

  it('done() called after promise resolves for async handler', async () => {
    const asyncBus = createAsyncCommandBus({ onMissing: 'ignore' });
    asyncBus.register('enter', async () => {
      await new Promise(r => setTimeout(r, 10));
      return 'done';
    });

    const t = createTransitionBridge({ bus: asyncBus });
    const done = vi.fn();

    t.onEnter(mockEl(), done);

    // done() should NOT be called synchronously since the handler is async
    expect(done).not.toHaveBeenCalled();

    // Wait for the async handler to complete
    await new Promise(r => setTimeout(r, 50));

    expect(done).toHaveBeenCalledTimes(1);
  });

  it('done() called even when async handler rejects', async () => {
    const asyncBus = createAsyncCommandBus({ onMissing: 'ignore' });
    asyncBus.register('leave', async () => {
      throw new Error('async animation failed');
    });

    const t = createTransitionBridge({ bus: asyncBus });
    const done = vi.fn();

    t.onLeave(mockEl(), done);

    await new Promise(r => setTimeout(r, 50));

    expect(done).toHaveBeenCalledTimes(1);
  });

  it('done() called when no handler is registered (onMissing: ignore)', () => {
    const t = createTransitionBridge({ bus });
    const done = vi.fn();

    t.onEnter(mockEl(), done);

    expect(done).toHaveBeenCalledTimes(1);
  });

  it('dispose is callable', () => {
    const t = createTransitionBridge({ bus });
    expect(() => t.dispose()).not.toThrow();
  });

  it('onMove dispatches namespaced move action (TransitionGroup)', () => {
    const dispatched: string[] = [];
    bus.onAfter((cmd) => dispatched.push(cmd.action));

    const t = createTransitionBridge({ bus, namespace: 'list' });
    t.onMove(mockEl());

    expect(dispatched).toEqual(['listMove']);
  });

  it('onMove dispatches un-namespaced move action', () => {
    const dispatched: string[] = [];
    bus.onAfter((cmd) => dispatched.push(cmd.action));

    const t = createTransitionBridge({ bus });
    t.onMove(mockEl());

    expect(dispatched).toEqual(['move']);
  });

  it('swallows a synchronous dispatch throw (naming:throw) — transitions never break', () => {
    // A strict naming bus throws synchronously in dispatch() when the action
    // violates the pattern. dispatchSafe's catch must absorb it for both the
    // direct path (onMove) and the done() path (onEnter), and done() still fires.
    const strictBus = createCommandBus({
      naming: { pattern: /^app:/, onViolation: 'throw' },
      onMissing: 'ignore',
    });
    const t = createTransitionBridge({ bus: strictBus, namespace: 'list' });
    const done = vi.fn();

    expect(() => t.onMove(mockEl())).not.toThrow();       // 'listMove' → throws → swallowed
    expect(() => t.onEnter(mockEl(), done)).not.toThrow(); // 'listEnter' → throws → swallowed
    expect(done).toHaveBeenCalledTimes(1);                 // dispatchWithDone still calls done()
  });
});

describe('useTransitionCommand', () => {
  beforeEach(() => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    setCommandBus(bus);
  });

  afterEach(() => {
    resetCommandBus();
  });

  it('uses shared bus from getCommandBus()', () => {
    const dispatched: string[] = [];
    const bus = createCommandBus({ onMissing: 'ignore' });
    setCommandBus(bus);
    bus.onAfter((cmd) => dispatched.push(cmd.action));

    const t = useTransitionCommand({ namespace: 'drawer' });
    t.onBeforeEnter(mockEl());

    expect(dispatched).toEqual(['drawerBeforeEnter']);
  });

  it('returns same hook shape as createTransitionBridge', () => {
    const t = useTransitionCommand();

    expect(typeof t.onBeforeEnter).toBe('function');
    expect(typeof t.onEnter).toBe('function');
    expect(typeof t.onAfterEnter).toBe('function');
    expect(typeof t.onEnterCancelled).toBe('function');
    expect(typeof t.onBeforeLeave).toBe('function');
    expect(typeof t.onLeave).toBe('function');
    expect(typeof t.onAfterLeave).toBe('function');
    expect(typeof t.onLeaveCancelled).toBe('function');
    expect(t.phase).toBeDefined();
    expect(t.phase.value).toBe('idle');
    expect(typeof t.dispose).toBe('function');
  });

  it('phase signal is reactive', () => {
    const t = useTransitionCommand({ namespace: 'sidebar' });
    const el = mockEl();

    expect(t.phase.value).toBe('idle');
    t.onBeforeEnter(el);
    expect(t.phase.value).toBe('entering');
    t.onAfterEnter(el);
    expect(t.phase.value).toBe('idle');
  });

  it('dispose resets phase to idle', () => {
    const t = useTransitionCommand();
    t.onBeforeEnter(mockEl());
    expect(t.phase.value).toBe('entering');

    t.dispose();
    expect(t.phase.value).toBe('idle');
  });

  it('accepts explicit bus via options', () => {
    const customBus = createCommandBus({ onMissing: 'ignore' });
    const dispatched: string[] = [];
    customBus.onAfter((cmd) => dispatched.push(cmd.action));

    const t = useTransitionCommand({ bus: customBus, namespace: 'toast' });
    t.onBeforeEnter(mockEl());

    expect(dispatched).toEqual(['toastBeforeEnter']);
  });
});
