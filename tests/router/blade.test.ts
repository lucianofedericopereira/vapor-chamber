// @vitest-environment happy-dom
/**
 * Tests for router/blade.ts — makeBladeComponent wraps fetched HTML into a
 * throwaway component whose lifecycle owns the swap.
 */

import { describe, expect, it, vi } from 'vitest';
import { createApp } from 'vue';
import { makeBladeComponent } from '../../src/router/blade';

describe('makeBladeComponent', () => {
  it('injects HTML + hydrates on mount, dehydrates + clears on unmount', () => {
    const hydrate = vi.fn();
    const dehydrate = vi.fn();
    const Comp = makeBladeComponent('<p>hi</p>', { hydrate, dehydrate });

    const host = document.createElement('div');
    const app = createApp(Comp);
    app.mount(host);

    const bladeEl = host.querySelector('[data-vcr-blade]') as HTMLElement;
    expect(bladeEl).not.toBeNull();
    expect(bladeEl.innerHTML).toBe('<p>hi</p>');
    expect(hydrate).toHaveBeenCalledWith(bladeEl);
    expect(dehydrate).not.toHaveBeenCalled();

    app.unmount();
    expect(dehydrate).toHaveBeenCalledWith(bladeEl);
    expect(bladeEl.innerHTML).toBe('');
  });

  it('no hooks provided — mount/unmount are safe no-ops', () => {
    const Comp = makeBladeComponent('<span>x</span>', {});
    const host = document.createElement('div');
    const app = createApp(Comp);
    expect(() => {
      app.mount(host);
      app.unmount();
    }).not.toThrow();
  });
});

describe('makeBladeComponent — hook branches', () => {
  it('swaps HTML in and calls hydrate on mount, dehydrate + clears on unmount', async () => {
    const seen: string[] = [];
    const Comp = makeBladeComponent('<p id="blade-inner">server html</p>', {
      hydrate: (el) => seen.push(`hydrate:${el.querySelector('#blade-inner')?.textContent}`),
      dehydrate: (el) => seen.push(`dehydrate:${el.querySelector('#blade-inner')?.textContent}`),
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(Comp);
    app.mount(host);

    const wrapper = host.querySelector('[data-vcr-blade]') as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.innerHTML).toContain('server html');
    expect(seen).toEqual(['hydrate:server html']);

    app.unmount();
    // dehydrate sees the DOM while it is still there, then it is cleared.
    expect(seen).toEqual(['hydrate:server html', 'dehydrate:server html']);
    host.remove();
  });

  it('works with NO hooks at all — they are optional app conventions', () => {
    const Comp = makeBladeComponent('<span>plain</span>', {});
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(Comp);

    expect(() => app.mount(host)).not.toThrow();
    expect(host.querySelector('[data-vcr-blade]')?.innerHTML).toContain('plain');
    expect(() => app.unmount()).not.toThrow();
    host.remove();
  });
});
