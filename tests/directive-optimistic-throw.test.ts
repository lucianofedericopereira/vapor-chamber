// @vitest-environment happy-dom
/**
 * v-vc-command: an optimistic function that throws is the press's failure.
 * It ran before the `try` whose `finally` releases the control, so the control
 * stayed busy for good - `vc-loading`, `aria-disabled` and the in-flight
 * capture guard stayed, and every later press was swallowed.
 */
import { describe, expect, it } from 'vitest';
import { createDirectivePlugin } from '../src/directives';
import { createCommandBus } from '../src/command-bus';
import { setCommandBus, resetCommandBus } from '../src/chamber';

describe('v-vc-command - optimistic throws', () => {
  it('does not leave the button busy', async () => {
    const bus = createCommandBus();
    let runs = 0;
    bus.register('save', () => { runs++; return 1; });
    setCommandBus(bus);
    const dirs = new Map<string, any>();
    createDirectivePlugin().install({ directive: (n: string, d: any) => dirs.set(n, d) });
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    let throwIt = true;
    dirs.get('vc-optimistic').mounted(btn, { value: () => { if (throwIt) throw new Error('bad optimistic'); return null; } });
    dirs.get('vc-command').mounted(btn, { value: 'save', modifiers: {} });
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    throwIt = false;
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    const state = { loading: btn.classList.contains('vc-loading'), aria: btn.getAttribute('aria-disabled'), runs };
    resetCommandBus();
    expect(state).toEqual({ loading: false, aria: null, runs: 1 });
  });
});
