/**
 * vapor-chamber-router — blade rows as ordinary components.
 *
 * A blade record's fetched HTML is wrapped into a throwaway component whose
 * lifecycle owns the swap: mounted → innerHTML + hydrate(el); before unmount
 * → dehydrate(el) + clear. The outlet renders it like any other component.
 * Hooks are the app's island conventions, injected via router options.
 */

import { defineComponent, h, onBeforeUnmount, onMounted, shallowRef } from 'vue';

export type BladeHooks = {
  hydrate?: (el: Element) => unknown;
  dehydrate?: (el: Element) => unknown;
};

export function makeBladeComponent(html: string, hooks: BladeHooks) {
  return defineComponent({
    name: 'VcrBlade',
    setup() {
      // shallowRef, like every other reactive cell in this package: the value
      // is replaced wholesale and never mutated field-by-field, so there is
      // nothing for a deep proxy to earn. It matters more than usual here —
      // the value is a DOM element, which has no business being reactive at
      // all. (`ref()` would leave it unproxied anyway, since elements are not
      // an observable type, but relying on that is an accident, not a rule.)
      const el = shallowRef<HTMLElement | null>(null);
      onMounted(() => {
        if (!el.value) return;
        el.value.innerHTML = html;
        hooks.hydrate?.(el.value);
      });
      onBeforeUnmount(() => {
        if (!el.value) return;
        hooks.dehydrate?.(el.value);
        el.value.innerHTML = '';
      });
      return () => h('div', { 'data-vcr-blade': '', ref: el });
    },
  });
}
