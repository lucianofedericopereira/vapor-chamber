/**
 * WCAG 2.1.1 (keyboard): an element with role="button" carrying v-vc-command
 * must work from the keyboard, as a native <button> does.
 *
 * ARIA Authoring Practices, button pattern: focusable; Enter activates on key
 * down; Space activates on key UP, with its page scroll prevented. A native
 * <button> does all of it; a <div role="button"> does none of it unless code
 * does, and the directive owns the element's interaction. Guards pinned here:
 * a native button still dispatches once, and a key the app already handled
 * (defaultPrevented) is not handled twice. docs/plan-failures-and-contract.md 8e.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createAsyncCommandBus, setCommandBus } from 'vapor-chamber';
import { vcCommandVapor } from '../../src/directives';
import { matchers, tap } from '../../src/vitest-pure';

expect.extend(matchers);

const settle = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

function mount(el: HTMLElement) {
  const bus = tap(createAsyncCommandBus());
  bus.register('saveThing', async () => true);
  setCommandBus(bus);
  document.body.append(el);
  const teardown = vcCommandVapor(el, () => 'saveThing');
  return { bus, teardown };
}

function roleButton(): HTMLDivElement {
  const div = document.createElement('div');
  div.setAttribute('role', 'button');
  div.textContent = 'Save';
  return div;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('v-vc-command from the keyboard (real Chromium)', () => {
  it('a role="button" element becomes focusable', () => {
    const div = roleButton();
    const t = mount(div);
    expect(div.tabIndex).toBe(0);
    t.teardown?.();
    expect(div.hasAttribute('tabindex')).toBe(false); // only what the directive added comes off
  });

  it('keeps a tabindex the app set', () => {
    const div = roleButton();
    div.tabIndex = -1;
    const t = mount(div);
    expect(div.getAttribute('tabindex')).toBe('-1');
    t.teardown?.();
    expect(div.getAttribute('tabindex')).toBe('-1');
  });

  it('Enter activates a role="button" element', async () => {
    const div = roleButton();
    const t = mount(div);
    div.focus();
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(t.bus).toHaveBeenDispatchedTimes('saveThing', 1);
    t.teardown?.();
  });

  it('Space activates on key up, and does not scroll the page', async () => {
    const div = roleButton();
    const t = mount(div);
    let spaceDefaultPrevented = false;
    document.addEventListener('keydown', (e) => { if (e.key === ' ') spaceDefaultPrevented = e.defaultPrevented; }, { once: true });
    div.focus();
    await userEvent.keyboard('{ }');
    await settle();
    expect(t.bus).toHaveBeenDispatchedTimes('saveThing', 1);
    expect(spaceDefaultPrevented).toBe(true);
    t.teardown?.();
  });

  it('a native <button> still dispatches exactly once per key', async () => {
    const button = document.createElement('button');
    button.textContent = 'Save';
    const t = mount(button);
    button.focus();
    await userEvent.keyboard('{Enter}');
    await settle();
    await userEvent.keyboard('{ }');
    await settle();
    expect(t.bus).toHaveBeenDispatchedTimes('saveThing', 2);
    t.teardown?.();
  });

  it('a key the app already handled is not handled again', async () => {
    const div = roleButton();
    div.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    const t = mount(div);
    div.focus();
    await userEvent.keyboard('{Enter}');
    await settle();
    expect(t.bus).not.toHaveBeenDispatched('saveThing');
    t.teardown?.();
  });
});
