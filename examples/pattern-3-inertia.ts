/**
 * Pattern 3: Laravel + Inertia.js (complementary, not competing)
 * ==============================================================
 * Inertia handles routing and page props.
 * Vapor Chamber handles in-page actions.
 * They solve different problems and compose naturally.
 *
 * resources/js/app.ts
 */

import { createCommandBus, useCommand, useCommandGroup } from 'vapor-chamber'
import { createHttpBridge } from 'vapor-chamber/transports'
import { createDirectivePlugin } from 'vapor-chamber/directives'
import { createApp, h } from 'vue'
import { createInertiaApp } from '@inertiajs/vue3'

// Shared bus — lives outside the Inertia page lifecycle
const bus = createCommandBus()
bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }))

createInertiaApp({
  resolve: (name) => {
    const pages = import.meta.glob('./pages/**/*.vue', { eager: true })
    return pages[`./pages/${name}.vue`]
  },
  setup({ el, App, props, plugin }) {
    const app = createApp({ render: () => h(App, props) })

    app.use(plugin)
    app.use(createDirectivePlugin())
    app.provide('bus', bus)

    app.mount(el)
  },
})

/*
 * resources/js/pages/Orders.vue
 * ——————————————————————————————
 * Inertia handles the route, vapor-chamber handles the action.
 * No conflict, no duplication.
 *
 * <script setup lang="ts">
 * import { useCommand } from 'vapor-chamber'
 * import { router } from '@inertiajs/vue3'
 *
 * const props = defineProps<{ orders: Order[] }>()
 * const { dispatch, loading, lastError } = useCommand()
 *
 * // Cancel with page transition after success
 * async function cancelOrder(id: number) {
 *   const result = await dispatch('order.cancel', { id })
 *   if (result.ok) router.visit('/orders') // Inertia router
 * }
 * </script>
 *
 * <template>
 *   <div v-for="order in orders" :key="order.id">
 *     <span>{{ order.reference }}</span>
 *     <button @click="cancelOrder(order.id)" :disabled="loading.value">
 *       {{ loading.value ? 'Cancelling…' : 'Cancel' }}
 *     </button>
 *   </div>
 * </template>
 */

/*
 * When to use Inertia vs Vapor Chamber:
 *
 * Inertia router.visit()  → full page transitions, URL changes, back/forward
 * Vapor Chamber dispatch() → in-page actions, reactive microinteractions,
 *                            optimistic updates, live search, field validation
 *
 * Inertia page props      → server-rendered initial state
 * useCommandState()       → reactive state that updates from commands
 *
 * Both share the same Laravel controller layer. No duplication.
 */
