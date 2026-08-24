// @vitest-environment happy-dom
/**
 * FIXTURE — the transition bridge bound to a REAL mounted `<Transition>`.
 *
 * WHY THIS FILE EXISTS. `tests/transitions.test.ts` covers all nine hooks, the
 * phase signal and the done() paths — but every one of those tests calls the
 * hooks directly on a mock element (`{ tagName: 'DIV' }`). Nothing in the suite
 * ever handed the bridge to Vue. So the one thing this module's own docs tell
 * you to write — `<Transition v-bind="t">` — had no coverage at all, and a
 * defect living exactly there survived 1750 passing tests.
 *
 * The defect: `v-bind="obj"` spreads an object's own ENUMERABLE keys as props.
 * The nine `on*` hooks match `<Transition>`'s declared props; `phase` and
 * `dispose` match nothing, so they fell through as ATTRIBUTES and were
 * stringified into the DOM —
 *
 *     <div class="panel" phase="[object Object]" dispose="() => {}">hi</div>
 *
 * — on every consumer following the documented usage since v1.1.0. Fixed by
 * defining both as non-enumerable (see `assembleBridge` in src/transitions.ts).
 *
 * This is the same lesson the rc.4 KeepAlive bug taught, applied preemptively:
 * a fixture that substitutes a mock for the integration it is reasoning about
 * can only ever check the half you already understood. So this one mounts.
 */

import { describe, expect, it } from 'vitest';
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
    // The assertion that fails against the pre-fix code.
    expect(el.hasAttribute('phase')).toBe(false);
    expect(el.hasAttribute('dispose')).toBe(false);
    expect(Array.from(el.attributes).map((a) => a.name)).toEqual(['class']);

    app.unmount();
  });

  it('still delivers the hooks to Vue — the binding must keep working', async () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const dispatched: string[] = [];
    bus.onAfter((cmd) => dispatched.push(cmd.action));

    const bridge = createTransitionBridge({ bus, namespace: 'modal' });
    const show = ref(true);
    const { app } = mountWithBridge(bridge, show);

    // Hiding the child drives the leave hooks through Vue's own machinery.
    show.value = false;
    await new Promise((r) => setTimeout(r, 0));

    // Hooks reached Vue and dispatched: hiding them from SPREADS must not hide
    // them from the props they are actually for.
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched).toContain('modalBeforeLeave');

    app.unmount();
  });

  it('keeps phase/dispose reachable by direct access and destructuring', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    const bridge = createTransitionBridge({ bus, namespace: 'modal' });

    // Direct access — the documented `modal.phase.value` template read.
    expect(bridge.phase.value).toBe('idle');
    expect(typeof bridge.dispose).toBe('function');

    // Destructuring reads the property directly; enumerability is irrelevant.
    const { phase, dispose } = bridge;
    expect(phase.value).toBe('idle');
    expect(() => dispose()).not.toThrow();

    // The intentional casualty, pinned so it is a decision and not a surprise:
    // spreading no longer carries them — which is the whole fix.
    expect(Object.keys({ ...bridge })).not.toContain('phase');
    expect(Object.keys(bridge)).toEqual([
      'onBeforeEnter', 'onEnter', 'onAfterEnter', 'onEnterCancelled',
      'onBeforeLeave', 'onLeave', 'onAfterLeave', 'onLeaveCancelled', 'onMove',
    ]);
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
