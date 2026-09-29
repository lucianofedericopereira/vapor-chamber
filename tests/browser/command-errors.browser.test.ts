/**
 * vc-error made semantic. The class is for styling and a screen reader cannot
 * see it; a failed command is a status message (WCAG 4.1.3): announced, focus
 * left where it is. The words are the failure's own (since v1.24 a backend
 * problem's `detail`, already localized) through the document's shared live
 * region (src/a11y.ts); an app that took the announcing over gets them instead.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createAsyncCommandBus, setCommandBus } from 'vapor-chamber';
import { setAnnouncer } from '../../src/a11y';
import { vcCommandVapor } from '../../src/directives';

const frames = (n: number) => new Promise<void>((r) => {
  const step = (left: number) => (left === 0 ? r() : requestAnimationFrame(() => step(left - 1)));
  step(n);
});
const assertive = () => document.querySelector('[data-vc-announcer="assertive"]')?.textContent ?? '';

function mount(handler: () => Promise<unknown>) {
  const bus = createAsyncCommandBus();
  bus.register('pay', handler);
  setCommandBus(bus);
  const button = document.createElement('button');
  button.textContent = 'Pay';
  document.body.append(button);
  const teardown = vcCommandVapor(button, () => 'pay');
  return { button, teardown };
}

afterEach(() => {
  setAnnouncer(null);
  document.body.innerHTML = '';
});

describe('a failed command is announced (real Chromium)', () => {
  it('says the failure in its own words, and keeps vc-error for styling', async () => {
    const t = mount(async () => { throw new Error('The card was declined.'); });
    t.button.focus();
    t.button.click();
    await frames(3);
    expect(t.button.classList.contains('vc-error')).toBe(true);
    expect(assertive()).toBe('The card was declined.');
    expect(document.activeElement).toBe(t.button); // announced, focus not moved
    t.teardown?.();
  });

  it('a success says nothing', async () => {
    const t = mount(async () => 'paid');
    t.button.click();
    await frames(3);
    expect(t.button.classList.contains('vc-error')).toBe(false);
    expect(assertive()).toBe('');
    t.teardown?.();
  });

  it('an app that took the announcing over gets the message instead', async () => {
    const heard: string[] = [];
    setAnnouncer((message) => { heard.push(message); });
    const t = mount(async () => { throw new Error('The card was declined.'); });
    t.button.click();
    await frames(3);
    expect(heard).toEqual(['The card was declined.']);
    t.teardown?.();
  });
});
