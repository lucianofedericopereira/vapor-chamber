/**
 * Slot props on a Vapor `<slot>` outlet, alone and as the content of `VcTransition`.
 * Why: a wrapper that passes `class`, `style` and `key` to its slot hands a consumer a value it binds or reads; the shape must be what the same template gives under vDOM, and a transition around that outlet must still find the element the consumer rendered.
 * Shows: `class` and `style` arrive normalized, `key` arrives as a slot prop and `$` is not one; `VcTransition` dispatches its leave commands on the consumer's element, with that class and key on it.
 * See: vuejs/core#16045, vuejs/core#16059, tests/vapor/vc-transition.test.ts
 */

import * as vue from 'vue';
import { describe, expect, it } from 'vitest';
import { createCommandBus } from '../../src/command-bus';
import { VcTransition } from '../../src/transitions/vapor';
import { bindVapor } from '../bind-vapor';
import { compileVaporSource } from '../compile-vapor';

const v = vue as any;
const settle = () => new Promise((r) => setTimeout(r, 0));
const compile = async (source: string) => bindVapor(v, await compileVaporSource(source));

describe('slot props on a Vapor outlet', () => {
  it('arrive as vDOM gives them', async () => {
    const child = await compile('<slot :class="[\'a\', { b: on }]" :style="{ color: \'red\' }" :key="k" n="1" />');
    const Child = v.defineVaporComponent({ setup: () => child(v.reactive({ on: true, k: 'K' })) });
    const parent = await compile('<Child v-slot="p"><pre>{{ JSON.stringify(p) }}|{{ p.$ === undefined }}</pre></Child>');

    const host = document.createElement('div');
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => parent({}) }));
    app.component('Child', Child);
    app.mount(host);

    const [json, noDollar] = (host.textContent as string).split('|');
    expect(JSON.parse(json)).toEqual({ class: 'a b', style: { color: 'red' }, key: 'K', n: '1' });
    expect(noDollar).toBe('true');
    app.unmount();
  });

  it('reach the element VcTransition hands its commands', async () => {
    const seen: string[] = [];
    const bus = createCommandBus({ onMissing: 'ignore' });
    bus.onAfter((cmd) => {
      const el = cmd.target as Element;
      seen.push(`${cmd.action}:${el.tagName}.${el.className}:${el.getAttribute('data-key')}`);
    });
    const wrap = await compile('<VcTransition :show="s.open" namespace="m" :bus="bus"><slot :class="s.cls" :key="s.k" /></VcTransition>');
    const s = v.reactive({ open: true, cls: ['x', { y: true }], k: 'K' });
    const Wrap = v.defineVaporComponent({ setup: () => wrap({ s, bus }) });
    const top = await compile('<Wrap v-slot="p"><section :class="p.class" :data-key="p.key">z</section></Wrap>');

    const host = document.createElement('div');
    const app = v.createVaporApp(v.defineVaporComponent({ setup: () => top({}) }));
    app.component('Wrap', Wrap);
    app.component('VcTransition', VcTransition);
    app.mount(host);
    await settle();
    expect(host.querySelector('section')?.getAttribute('data-key')).toBe('K');

    s.open = false;
    await settle();
    await settle();
    expect(seen).toEqual(['mBeforeLeave:SECTION.x y:K', 'mLeave:SECTION.x y:K', 'mAfterLeave:SECTION.x y:K']);
    expect(host.querySelector('section')).toBeNull();
    app.unmount();
  });
});
