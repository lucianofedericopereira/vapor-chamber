/**
 * Pattern 2: Laravel + Vite + SFC (full build, no Livewire)
 * ==========================================================
 * Full build pipeline. Command bus replaces Livewire's component model.
 * The backend is a standard Laravel controller — no Livewire dependency.
 *
 * resources/js/app.ts
 */

import { createAsyncCommandBus, setCommandBus, retry } from 'vapor-chamber'
import { createHttpBridge, createSseBridge } from 'vapor-chamber/transports'
import { createDirectivePlugin } from 'vapor-chamber/directives'
import { createApp } from 'vue'
import App from './App.vue'

// 1. Create the bus. ASYNC bus — retry and createHttpBridge are async plugins;
//    on a sync createCommandBus() they'd return a Promise where a result is
//    expected and every dispatch would silently fail.
const bus = createAsyncCommandBus()

// 2. Install plugins (before transport so they run before forwarding).
//    Log via onAfter — it observes settled results on the async bus.
bus.onAfter((cmd, result) => {
  if (!cmd.action.startsWith('analytics')) {
    console.log(`⚡ ${cmd.action}`, result.ok ? result.value : result.error)
  }
})
bus.use(retry({ maxAttempts: 3, baseDelay: 300, actions: ['api*', 'order*'] }))

// 3. Install HTTP transport — all unhandled commands go to the server
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
//    other composable dispatch on getCommandBus() — a provide()'d bus would
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
 * import { useCommand } from 'vapor-chamber'
 *
 * const props = defineProps<{ product: Product }>()
 * const { dispatch, loading, lastError } = useCommand()
 * </script>
 *
 * <template>
 *   <!-- With composable -->
 *   <button @click="dispatch('productFavorite', { id: product.id })" :disabled="loading.value">
 *     {{ loading.value ? '…' : '♥ Save' }}
 *   </button>
 *
 *   <!-- Or declaratively with directive -->
 *   <button v-vc:command="'productFavorite'"
 *           v-vc-payload="{ id: product.id }">
 *     ♥ Save
 *   </button>
 *
 *   <p v-if="lastError.value" class="error">{{ lastError.value.message }}</p>
 * </template>
 */

/*
 * Laravel controller (no Livewire):
 *
 * // routes/api.php
 * Route::post('/vc', VaporChamberController::class);
 * Route::get('/vc/events', VaporChamberSseController::class);
 *
 * // app/Http/Controllers/VaporChamberController.php
 * public function __invoke(Request $request): JsonResponse
 * {
 *     return response()->json([
 *         'state' => $this->router->handle(
 *             $request->input('command'),
 *             $request->input('target'),
 *             $request->input('payload'),
 *         )
 *     ]);
 * }
 */
