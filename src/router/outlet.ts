/**
 * vapor-chamber-router — <RouterOutlet>: one render path.
 *
 * Reads `snapshot.render[depth]` — precomputed upstream (groups excluded at
 * table build, components resolved at navigation, blade rows pre-wrapped).
 * Keyless on purpose: the same record at a depth keeps its instance across
 * param/query changes; a different record swaps it. Default slot renders
 * when nothing matches at this depth.
 */

import { defineComponent, h, inject, provide } from 'vue';
import { OUTLET_DEPTH_KEY, ROUTER_KEY } from './keys';
import type { Router } from './router-type';

export const RouterOutlet = defineComponent({
  name: 'RouterOutlet',
  setup(_, { slots }) {
    const router = inject<Router>(ROUTER_KEY);
    if (!router) throw new Error('[vapor-chamber-router] <RouterOutlet> used without an installed router');

    const depth = inject<number>(OUTLET_DEPTH_KEY, 0);
    provide(OUTLET_DEPTH_KEY, depth + 1);

    return () => {
      const entry = router.currentRoute.value.render[depth];
      return entry ? h(entry.component as never) : (slots.default?.() ?? null);
    };
  },
});
