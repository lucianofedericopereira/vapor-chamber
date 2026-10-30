/**
 * v-vc-command keeps keyboard focus on the button it marks busy, and keeps what disabling it would give.
 * Why: HTML's focus fixup moves focus off a disabled element, so `disabled` would send a keyboard user to the top of the page on every press.
 * Shows: the engine does move focus; the directive keeps it with aria-disabled, blocks a second press and app clicks, submits no form, works again after; AT sees it disabled.
 * See: docs/accessibility.md.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { createAsyncCommandBus, setCommandBus } from 'vapor-chamber';
import { vcCommandVapor } from '../../src/directives';
import { matchers, tap } from '../../src/vitest-pure';

expect.extend(matchers);

// Two frames: the focus fixup runs in a rendering update, which a zero-delay timeout can precede.
const settle = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

afterEach(() => {
  document.body.innerHTML = '';
});

describe('focus and a disabled button (real Chromium)', () => {
  it('the engine: a focused button that becomes disabled', async () => {
    const button = document.createElement('button');
    button.textContent = 'Save';
    document.body.append(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    button.disabled = true;
    await settle();

    // After the rendering update, focus is on <body>.
    expect(document.hasFocus()).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  // With `disabled`, focus would go to <body> and not come back; markBusy uses aria-disabled.
  it('the directive keeps keyboard focus through an in-flight dispatch', async () => {
    let release!: () => void;
    const bus = createAsyncCommandBus();
    bus.register('saveThing', () => new Promise<boolean>((r) => { release = () => r(true); }));
    setCommandBus(bus);

    const button = document.createElement('button');
    button.textContent = 'Save';
    document.body.append(button);
    const teardown = vcCommandVapor(button, () => 'saveThing');

    button.focus();
    button.click(); // what Enter on a focused button does
    await settle();

    const during = { ariaDisabled: button.getAttribute('aria-disabled'), focused: document.activeElement === button };
    release();
    await settle();
    await settle();
    const after = { ariaDisabled: button.getAttribute('aria-disabled'), focused: document.activeElement === button };

    teardown?.();
    expect(during).toEqual({ ariaDisabled: 'true', focused: true });
    expect(after).toEqual({ ariaDisabled: null, focused: true });
  });
});

/** What disabling would give besides moving focus, kept with aria-disabled: no second press, no app click, no form submit in flight. */
describe('what the in-flight state must keep (real Chromium)', () => {
  function mountSave(type: 'button' | 'submit') {
    let release!: () => void;
    const bus = tap(createAsyncCommandBus());
    bus.register('saveThing', () => new Promise<boolean>((r) => { release = () => r(true); }));
    setCommandBus(bus);
    const form = document.createElement('form');
    let submits = 0;
    form.addEventListener('submit', (e) => { submits += 1; e.preventDefault(); });
    const button = document.createElement('button');
    button.type = type;
    button.textContent = 'Save';
    form.append(button);
    document.body.append(form);
    const teardown = vcCommandVapor(button, () => 'saveThing');
    let appClicks = 0;
    button.addEventListener('click', () => { appClicks += 1; });
    return { bus, button, teardown, release: () => release(), submits: () => submits, appClicks: () => appClicks };
  }

  it('a second press during the flight dispatches nothing and reaches no other listener', async () => {
    const t = mountSave('button');
    t.button.focus();
    t.button.click();
    await settle();
    const appClicksAfterFirst = t.appClicks();
    t.button.click();
    await settle();
    expect(t.appClicks()).toBe(appClicksAfterFirst);
    t.release();
    await settle();
    // `tap` records a dispatch when it settles, so read after the release: one.
    expect(t.bus).toHaveBeenDispatchedTimes('saveThing', 1);
    t.teardown?.();
  });

  it('the press that starts the dispatch does not submit the form', async () => {
    const t = mountSave('submit');
    t.button.focus();
    t.button.click();
    await settle();
    expect(t.submits()).toBe(0);
    t.release();
    await settle();
    expect(t.bus).toHaveBeenDispatchedTimes('saveThing', 1);
    t.teardown?.();
  });

  it('after the dispatch lands, the button works again', async () => {
    const t = mountSave('button');
    t.button.click();
    await settle();
    t.release();
    await settle();
    await settle();
    t.button.click();
    await settle();
    t.release();
    await settle();
    expect(t.bus).toHaveBeenDispatchedTimes('saveThing', 2);
    t.teardown?.();
  });
});

describe('the in-flight state as assistive technology sees it (real Chromium)', () => {
  async function inFlight(el: HTMLElement) {
    let release!: () => void;
    const bus = tap(createAsyncCommandBus());
    bus.register('saveThing', () => new Promise<boolean>((r) => { release = () => r(true); }));
    setCommandBus(bus);
    document.body.append(el);
    const teardown = vcCommandVapor(el, () => 'saveThing');
    let appClicks = 0;
    el.addEventListener('click', () => { appClicks += 1; });
    el.click();
    await settle();
    return { bus, release: () => release(), teardown, appClicks: () => appClicks };
  }

  it('a <button> keeps its name and is exposed as disabled while in flight', async () => {
    const button = document.createElement('button');
    button.textContent = 'Save';
    const t = await inFlight(button);
    await expect.element(page.getByRole('button', { name: 'Save', disabled: true })).toBeInTheDocument();
    t.release();
    await settle();
    await expect.element(page.getByRole('button', { name: 'Save', disabled: false })).toBeInTheDocument();
    t.teardown?.();
  });

  it('a role="button" element gets the same in-flight state as a <button>', async () => {
    const div = document.createElement('div');
    div.setAttribute('role', 'button');
    div.tabIndex = 0;
    div.textContent = 'Save';
    const t = await inFlight(div);
    await expect.element(page.getByRole('button', { name: 'Save', disabled: true })).toBeInTheDocument();
    const before = t.appClicks();
    div.click();
    await settle();
    expect(t.appClicks()).toBe(before);
    t.release();
    await settle();
    expect(t.bus).toHaveBeenDispatchedTimes('saveThing', 1);
    expect(div.hasAttribute('aria-disabled')).toBe(false);
    t.teardown?.();
  });
});
