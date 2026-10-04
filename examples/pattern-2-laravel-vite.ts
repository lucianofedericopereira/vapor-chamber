/**
 * Pattern 2: Laravel + Vite + SFC (full build, no Livewire)
 * ==========================================================
 * Full build pipeline. Command bus replaces Livewire's component model.
 * The backend is a standard Laravel controller - no Livewire dependency.
 *
 * resources/js/app.ts
 */

import { createAsyncCommandBus, setCommandBus } from 'vapor-chamber'
import { createHttpBridge, createSseBridge } from 'vapor-chamber/transports'
import { createDirectivePlugin } from 'vapor-chamber/directives'
import { createApp } from 'vue'
import App from './App.vue'

// 1. Create the bus. ASYNC bus - createHttpBridge is an async plugin; on a
//    sync createCommandBus() it would return a Promise where a result is
//    expected and every dispatch would silently fail.
const bus = createAsyncCommandBus()

// 2. Install plugins (before transport so they run before forwarding).
//    Log via onAfter - it observes settled results on the async bus.
bus.onAfter((cmd, result) => {
  if (!cmd.action.startsWith('analytics')) {
    console.log(`⚡ ${cmd.action}`, result.ok ? result.value : result.error)
  }
})

// 3. Install HTTP transport - all unhandled commands go to the server.
//    The bus re-sends through it what re-sending can change (a 429, 503 or
//    408; any Retry-After, after its wait) and never a verdict (422, 404, 403,
//    409) or a redirect; a lost request or a 500 only for an action declared
//    idempotent (createAsyncCommandBus({ retry: { actions } })). The plugins
//    outside see one dispatch.
bus.use(createHttpBridge({
  endpoint: '/api/vc',
  csrf: true,
  headers: { 'X-App-Version': '2.0.0' },
  timeout: 15_000,
}))

// 4. Install SSE for server push (real-time notifications)
const sse = createSseBridge({
  url: '/api/vc/events',
  withCredentials: true,
  onEvent: (event, b) => {
    const data = JSON.parse(event.data) as { command: string; target: any }
    b.dispatch(data.command, data.target)
  },
})
sse.install(bus)

// 5. Make this bus the shared one. useCommand(), the directives, and every
//    other composable dispatch on getCommandBus() - a provide()'d bus would
//    never be seen by them.
setCommandBus(bus)

// 6. Create Vue app + install directive plugin (opt-in)
const app = createApp(App)
app.use(createDirectivePlugin())

app.mount('#app')

// Cleanup on page unload
window.addEventListener('beforeunload', () => sse.teardown())

/*
 * resources/js/components/ProductCard.vue
 * ----------------------------------------
 * <script setup lang="ts">
 * // Composables from the Vue entry: it wires Vue at build time. From the
 * // package root they would lose reactivity and cleanup once built.
 * import { useCommand } from 'vapor-chamber/vue'
 *
 * const props = defineProps<{ product: Product }>()
 * // Kept as an object: a template unwraps top-level refs, so `cmd.loading.value`
 * // (nested) reads the same at runtime and for vue-tsc.
 * const cmd = useCommand()
 * </script>
 *
 * <template>
 *   <!-- With composable -->
 *   <!-- aria-disabled, not :disabled - disabling the focused button would
 *        send a keyboard user's focus to <body>. -->
 *   <button @click="!cmd.loading.value && cmd.dispatch('productFavorite', { id: product.id })" :aria-disabled="cmd.loading.value">
 *     {{ cmd.loading.value ? '...' : '♥ Save' }}
 *   </button>
 *
 *   <!-- Or declaratively with directive -->
 *   <button v-vc-command="'productFavorite'"
 *           v-vc-payload="{ id: product.id }">
 *     ♥ Save
 *   </button>
 *
 *   <p role="status" class="error">{{ cmd.lastError.value?.message }}</p>
 * </template>
 */

/*
 * Laravel backend (no Livewire): the reference controller,
 * examples/laravel-backend/VaporChamberController.php - `{ state }` on success,
 * an RFC 9457 problem on failure.
 *
 * // routes/web.php - the `web` group checks the CSRF token the bridge sends
 * Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
 * Route::get('/api/vc/events', VaporChamberSseController::class)->middleware(['web']);
 */
