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
      // The two `!el.value` guards below are TYPE narrowing, not runtime
      // defence, and they are unreachable through this component's own
      // lifecycle: the render function returns the ref'd div unconditionally,
      // Vue binds template refs before `onMounted`, and nulls them only after
      // `onBeforeUnmount`. Measured — both took the false path 4/4 times and
      // the true path 0, which is what held this file at 50% branch coverage.
      // They stay because `el.value` is `HTMLElement | null` and dropping them
      // would mean a non-null assertion, which is worse. Ignored rather than
      // faked with a test that reaches in and nulls the ref.
      onMounted(() => {
        /* v8 ignore next */
        if (!el.value) return;
        el.value.innerHTML = html;
        hooks.hydrate?.(el.value);
      });
      onBeforeUnmount(() => {
        /* v8 ignore next */
        if (!el.value) return;
        hooks.dehydrate?.(el.value);
        el.value.innerHTML = '';
      });
      return () => h('div', { 'data-vcr-blade': '', ref: el });
    },
  });
}
