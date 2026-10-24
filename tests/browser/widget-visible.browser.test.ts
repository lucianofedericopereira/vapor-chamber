// defineWidget({ when: 'visible' }) in Chromium: defined when its first element scrolls in, one observer for every widget; rationale at the end.
import { describe, expect, it } from 'vitest';
// The default `vue` entry re-exports the Vapor runtime too (tests/vue-bundler-vapor-exports.test.ts).
import * as Vue from 'vue';
import { configureVue } from '../../src/chamber';
import { defineWidget } from '../../src/widget';

const frames = (n: number) => new Promise<void>((r) => {
  const step = (left: number) => (left === 0 ? r() : requestAnimationFrame(() => step(left - 1)));
  step(n);
});

const widget = (label: string) => ({
  setup() {
    const span = document.createElement('span');
    span.textContent = label;
    return span;
  },
});

describe('a visible widget', () => {
  it('is defined when its element enters the viewport, not before', async () => {
    configureVue(Vue);
    const spacer = document.createElement('div');
    spacer.style.height = '3000px';
    const far = document.createElement('vc-wv-far');
    const near = document.createElement('vc-wv-near');
    document.body.append(near, spacer, far);
    expect(defineWidget('vc-wv-near', widget('near'), { when: 'visible' })).toBe(true);
    expect(defineWidget('vc-wv-far', widget('far'), { when: 'visible' })).toBe(true);
    await frames(4);
    const before = { near: customElements.get('vc-wv-near') !== undefined, far: customElements.get('vc-wv-far') !== undefined };
    far.scrollIntoView();
    await frames(4);
    const after = customElements.get('vc-wv-far') !== undefined;
    document.body.innerHTML = '';
    expect({ before, after }).toEqual({ before: { near: true, far: false }, after: true });
  });
});

// Plan 1.32 4.5 and record H (840-841): the `visible` strategy shares one
// IntersectionObserver for every widget, not one per element. A real engine: happy-dom's
// observer never reports an intersection. The near widget, in view at once, is the
// positive control; the far one stays undefined until it is scrolled to.
