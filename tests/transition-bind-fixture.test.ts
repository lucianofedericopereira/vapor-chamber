// @vitest-environment happy-dom
/**
 * The transition bridge bound to a real mounted <Transition> via v-bind.
 * Why: v-bind spreads own enumerable keys as props, so an enumerable phase or dispose would fall through
 * onto the transitioned element as stringified DOM attributes for every consumer of `<Transition v-bind="t">`.
 * Shows: the element carries only its class, Vue still receives the hooks, phase and dispose stay reachable
 * by direct access and destructuring, onMove is not spread, and useTransitionCommand behaves the same.
 * See: assembleBridge in src/transitions.ts
 */

import { describe, expect, it, vi } from 'vitest';
import { createApp, h, ref, Transition } from 'vue';
import { createCommandBus } from '../src/command-bus';
import { createTransitionBridge, useTransitionCommand } from '../src/transitions';

function mountWithBridge(bridge: object, show: { value: boolean }) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp({
    render: () =>
      h(Transition, bridge as any, {
        default: () => (show.value ? h('div', { class: 'panel' }, 'hi') : null),
      }),
  });
  app.mount(host);
  return { host, app };
}

describe('transition bridge bound to a real <Transition>', () => {
  it('puts NO bridge internals on the transitioned element', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const bridge = createTransitionBridge({ bus, namespace: 'modal' });
    const show = ref(true);

    const { host, app } = mountWithBridge(bridge, show);
    const el = host.querySelector('.panel') as HTMLElement;

    expect(el).toBeTruthy();
    expect(el.hasAttribute('phase')).toBe(false);
    expect(el.hasAttribute('dispose')).toBe(false);
    expect(Array.from(el.attributes).map((a) => a.name)).toEqual(['class']);

    app.unmount();
  });

  it('still delivers the hooks to Vue - the binding must keep working', async () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const dispatched: string[] = [];
    bus.onAfter((cmd) => dispatched.push(cmd.action));

    const bridge = createTransitionBridge({ bus, namespace: 'modal' });
    const show = ref(true);
    const { app } = mountWithBridge(bridge, show);

    show.value = false;
    await new Promise((r) => setTimeout(r, 0));

    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched).toContain('modalBeforeLeave');

    app.unmount();
  });

  it('keeps phase/dispose reachable by direct access and destructuring', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const bridge = createTransitionBridge({ bus, namespace: 'modal' });

    expect(bridge.phase.value).toBe('idle');
    expect(typeof bridge.dispose).toBe('function');

    const { phase, dispose } = bridge;
    expect(phase.value).toBe('idle');
    expect(() => dispose()).not.toThrow();

    // Spreading must not carry phase or dispose.
    expect(Object.keys({ ...bridge })).not.toContain('phase');
    expect(Object.keys(bridge)).toEqual([
      'onBeforeEnter', 'onEnter', 'onAfterEnter', 'onEnterCancelled',
      'onBeforeLeave', 'onLeave', 'onAfterLeave', 'onLeaveCancelled',
    ]);
  });

  // No Vue hook is named onMove: a spread onMove would only become a `move` DOM listener.
  it('spreads no onMove: the child gets no `move` listener, and t.onMove still dispatches', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const dispatched: string[] = [];
    bus.onAfter((cmd) => dispatched.push(cmd.action));
    const bridge = createTransitionBridge({ bus, namespace: 'list' });

    const add = vi.spyOn(Element.prototype, 'addEventListener');
    const { host, app } = mountWithBridge(bridge, ref(true));
    const moves = add.mock.calls.filter((c) => c[0] === 'move').length;
    // Positive control: proves the spy counts `move` listeners.
    (host.querySelector('.panel') as HTMLElement).addEventListener('move', () => {});
    expect([moves, add.mock.calls.filter((c) => c[0] === 'move').length]).toEqual([0, 1]);
    add.mockRestore();

    bridge.onMove(host.querySelector('.panel') as Element);
    expect(dispatched).toEqual(['listMove']);
    app.unmount();
  });

  it('applies to useTransitionCommand too, not just the factory', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const bridge = useTransitionCommand({ bus, namespace: 'drawer' });
    const show = ref(true);

    const { host, app } = mountWithBridge(bridge, show);
    const el = host.querySelector('.panel') as HTMLElement;

    expect(Array.from(el.attributes).map((a) => a.name)).toEqual(['class']);
    expect(bridge.phase.value).toBe('idle');

    app.unmount();
  });
});
