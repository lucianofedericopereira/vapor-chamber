// @vitest-environment happy-dom
/**
 * announce(): status messages without moving focus (WCAG 4.1.3), through ONE
 * shared pair of live regions per document - the pattern of Angular CDK's
 * LiveAnnouncer and React Aria's announce(), so no feature creates a region of
 * its own. The app can take the announcing over (its own status bar, its own
 * words): setAnnouncer. docs/plan-failures-and-contract.md, section 8e.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { announce, setAnnouncer } from '../src/a11y';

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const regions = () => [...document.querySelectorAll('[data-vc-announcer]')];

afterEach(() => {
  setAnnouncer(null);
  document.body.innerHTML = '';
});

describe('announce()', () => {
  it('speaks through a polite region by default, created on first use', async () => {
    expect(regions()).toHaveLength(0);
    announce('Saved');
    await frame();
    const polite = document.querySelector('[data-vc-announcer="polite"]')!;
    expect(polite.getAttribute('aria-live')).toBe('polite');
    expect(polite.getAttribute('aria-atomic')).toBe('true');
    expect(polite.textContent).toBe('Saved');
  });

  it('speaks through an assertive region when asked', async () => {
    announce('Could not save: the card was declined', { assertive: true });
    await frame();
    expect(document.querySelector('[data-vc-announcer="assertive"]')!.textContent)
      .toBe('Could not save: the card was declined');
  });

  it('reuses its regions: one pair per document, whoever announces', async () => {
    announce('one');
    announce('two', { assertive: true });
    announce('three');
    await frame();
    expect(regions()).toHaveLength(2);
  });

  it('says the same message again when it repeats', async () => {
    announce('Saved');
    await frame();
    const polite = document.querySelector('[data-vc-announcer="polite"]')!;
    polite.textContent = ''; // what a screen reader has consumed
    announce('Saved');
    await frame();
    expect(polite.textContent).toBe('Saved');
  });

  it('is hidden visually but not from the accessibility tree', async () => {
    announce('x');
    await frame();
    const el = document.querySelector('[data-vc-announcer]') as HTMLElement;
    expect(el.style.display).not.toBe('none');
    expect(el.getAttribute('aria-hidden')).toBeNull();
  });

  it('an app can take it over, and hand it back', async () => {
    const heard: Array<[string, boolean]> = [];
    setAnnouncer((message, { assertive }) => { heard.push([message, assertive]); });
    announce('Saved');
    announce('Failed', { assertive: true });
    await frame();
    expect(heard).toEqual([['Saved', false], ['Failed', true]]);
    expect(regions()).toHaveLength(0);

    setAnnouncer(null);
    announce('back');
    await frame();
    expect(regions()).toHaveLength(1);
  });

  it('ignores an empty message', async () => {
    announce('');
    await frame();
    expect(regions()).toHaveLength(0);
  });
});
