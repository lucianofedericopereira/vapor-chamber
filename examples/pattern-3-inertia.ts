/**
 * Pattern 3: Laravel + Inertia.js (complementary, not competing)
 * ==============================================================
 * Inertia handles routing and page props.
 * Vapor Chamber handles in-page actions.
 * They solve different problems and compose naturally.
 *
 * resources/js/app.ts
 */

// One entry for a Vue app: `vapor-chamber/vue` carries the bus, transports
// and directive plugin too, and Orders.vue below imports from it.
import { createAsyncCommandBus, setCommandBus, httpTransport, createDirectivePlugin } from 'vapor-chamber/vue'
import { createApp, h } from 'vue'
import { createInertiaApp, router } from '@inertiajs/vue3'

// The bus lives outside the Inertia page lifecycle. `csrf: true`: with no
// meta tag the transport reads the XSRF-TOKEN cookie Laravel sets; its own
// requests never pass through Axios.
const bus = createAsyncCommandBus({
  transport: httpTransport({
    endpoint: '/api/vc',
    csrf: true,
    // A backend `{ redirect }` hands the navigation to Inertia; the dispatch
    // still fails as transport:refused:redirect (there is no state to return).
    onRedirect: (url) => router.visit(url),
  }),
})

// Make it the shared bus - useCommand() in page components dispatches on
// getCommandBus(), not on a provide()'d instance.
setCommandBus(bus)

createInertiaApp({
  resolve: (name) => {
    const pages = import.meta.glob('./pages/**/*.vue', { eager: true })
    return pages[`./pages/${name}.vue`]
  },
  setup({ el, App, props, plugin }) {
    const app = createApp({ render: () => h(App, props) })

    app.use(plugin)
    app.use(createDirectivePlugin())

    app.mount(el)
  },
})

/*
 * resources/js/pages/Orders.vue
 * ------------------------------
 * Inertia handles the route and the props, vapor-chamber handles the action.
 * No conflict, no duplication.
 *
 * <script setup lang="ts">
 * // Composables from the Vue entry: it wires Vue at build time. From the
 * // package root they would lose reactivity and cleanup once built.
 * import { useCommand, useCommandError } from 'vapor-chamber/vue'
 * import { router } from '@inertiajs/vue3'
 *
 * defineProps<{ orders: Order[]; refunded: boolean }>()
 * // Kept as objects: a template unwraps top-level refs, so the nested
 * // `cmd.pending(...).value` reads the same at runtime and for vue-tsc.
 * const cmd = useCommand()
 * const errs = useCommandError({ actions: ['orderCancel'] })
 *
 * // The command changed the server, the page's props did not: ask Inertia for
 * // the `orders` prop alone. No page transition, the scroll and focus stay.
 * async function cancelOrder(id: number) {
 *   const result = await cmd.dispatch('orderCancel', { id })
 *   if (result.ok) router.reload({ only: ['orders'] })
 * }
 *
 * // A command can also answer with a page to go to: `{ redirect }` reaches
 * // `onRedirect` above, which hands the visit to Inertia.
 * const refund = (id: number) => cmd.dispatch('orderRefund', { id })
 * </script>
 *
 * <template>
 *   <p v-if="refunded">Refund opened</p>
 *   <div v-for="order in orders" :key="order.id">
 *     <span>{{ order.reference }}</span>
 *     <!-- aria-disabled, not :disabled: keyboard focus stays on the button.
 *          pending is this order's key: cancelling one leaves the others alone. -->
 *     <button type="button" @click="!cmd.pending('orderCancel', { id: order.id }).value && cancelOrder(order.id)" :aria-disabled="cmd.pending('orderCancel', { id: order.id }).value">
 *       {{ cmd.pending('orderCancel', { id: order.id }).value ? 'Cancelling...' : 'Cancel' }}
 *     </button>
 *   </div>
 *   <button type="button" @click="refund(1)">Refund</button>
 *   <p role="status">{{ errs.latestError.value?.message }}</p>
 * </template>
 */

/*
 * When to use Inertia vs Vapor Chamber:
 *
 * Inertia router.visit()  -> full page transitions, URL changes, back/forward
 * Vapor Chamber dispatch() -> in-page actions, reactive microinteractions,
 *                            optimistic updates, live search, field validation
 *
 * Inertia page props      -> server-rendered state of the page
 * router.reload({ only }) -> read a prop again after a command changed it
 *
 * Both share the same Laravel controller layer. No duplication.
 */
