/**
 * Pattern 2: Laravel + Vite + SFC (full build, no Livewire)
 * ==========================================================
 * Full build pipeline. Command bus replaces Livewire's component model.
 * The backend is a standard Laravel controller - no Livewire dependency.
 *
 * resources/js/app.ts
 */

// One entry for a Vue app: `vapor-chamber/vue` carries the bus, transports
// and directive plugin too, and App.vue below imports from it.
import { createAsyncCommandBus, setCommandBus, httpTransport, createSseBridge, createDirectivePlugin } from 'vapor-chamber/vue'
import { defineChamberStore } from 'vapor-chamber/store'
import { createApp } from 'vue'
import App from './App.vue'

// 1. Create the bus with its HTTP transport: with no pattern, every command
//    goes to the server, and a handler registered on this bus never runs.
//    The bus re-sends through it a transient failure for any action (a 429,
//    503 or 408, after any Retry-After wait). A declared wait sets when, never
//    whether. A verdict (422, 404, 403, 409) or a redirect is never re-sent. A
//    lost request or a 500 is re-sent only for an action declared idempotent
//    (createAsyncCommandBus({ retry: { actionPolicies } })). The plugins
//    outside see one dispatch.
// The page sends the build it was made from. The server compares it with its
// `APP_VERSION` and answers a command from an old page `{ redirect }`, which
// `onRedirect` loads. The server's `.env` carries `APP_VERSION=...` and
// `VITE_APP_VERSION="${APP_VERSION}"`, so one value serves both sides (Laravel
// exposes `VITE_` keys to the build, as its `VITE_APP_NAME="${APP_NAME}"` does).
// With no `VITE_APP_VERSION` the page sends no header and nothing is checked.
const version = import.meta.env.VITE_APP_VERSION
const bus = createAsyncCommandBus({
  transport: httpTransport({
    endpoint: '/api/vc',
    csrf: true,
    headers: version ? { 'X-App-Version': version } : {},
    onRedirect: (url) => location.assign(url),
    timeout: 15_000,
  }),
})

// 2. Log via onAfter - it observes settled results on the async bus.
bus.onAfter((cmd, result) => {
  console.log(`⚡ ${cmd.action}`, result.ok ? result.value : result.error)
})

// 3. The cart is a store the server writes. Its two actions are the server's
//    (`null`: no local change), and `answer` turns each reply into the store's
//    next state, so a component reads `cart.state` and keeps no copy by hand.
type Cart = { count: number; total: number; lastAdded: string }
const useCart = defineChamberStore('cart', {
  state: (): Cart => ({ count: 0, total: 0, lastAdded: '' }),
  reducers: { add: null, clear: null },
  answer: (_s, value) => value as Cart,
})
const cart = useCart(bus)

// 4. Install SSE for server push (real-time notifications). Laravel's
//    eventStream() names each event: `cartChanged` below. Its data's `stores`
//    member writes the cart store, then the event is emitted on the bus. A
//    push is never dispatched, so the transport above never sends it back.
const sse = createSseBridge({
  url: '/api/vc/events',
  withCredentials: true,
  events: ['cartChanged'],
})
sse.install(bus)

// 5. Make this bus the shared one. useCommand(), the directives, and every
//    other composable dispatch on getCommandBus() - a provide()'d bus would
//    never be seen by them.
setCommandBus(bus)

// 6. Create Vue app + install directive plugin (opt-in). The store is provided
//    to the components, which read it with inject('cart').
const app = createApp(App)
app.use(createDirectivePlugin())
app.provide('cart', cart)

app.mount('#app')

// Cleanup on page unload
window.addEventListener('beforeunload', () => sse.dispose())

/*
 * resources/js/App.vue
 * ---------------------
 * <script setup lang="ts">
 * // Composables from the Vue entry: it wires Vue at build time. From the
 * // package root they would lose reactivity and cleanup once built.
 * import { inject } from 'vue'
 * import { useCommand, useCommandError } from 'vapor-chamber/vue'
 *
 * // Kept as objects: a template unwraps top-level refs, so the nested
 * // `cmd.pending(...).value` reads the same at runtime and for vue-tsc.
 * const cmd = useCommand()
 * const errs = useCommandError({ actions: ['cartAdd'] })
 * const cart = inject<{ state: { value: { count: number; total: number; lastAdded: string } } }>('cart')!
 * </script>
 *
 * <template>
 *   <!-- With composable -->
 *   <!-- aria-disabled, not :disabled - disabling the focused button would
 *        send a keyboard user's focus to <body>. -->
 *   <!-- pending is this item's key: another item's add leaves it alone -->
 *   <button type="button" @click="!cmd.pending('cartAdd', { id: 1 }).value && cmd.dispatch('cartAdd', { id: 1 }, { qty: 1 })" :aria-disabled="cmd.pending('cartAdd', { id: 1 }).value">
 *     {{ cmd.pending('cartAdd', { id: 1 }).value ? '...' : 'Add coffee' }}
 *   </button>
 *
 *   <!-- Or declaratively with the directive: the target is an attribute, the
 *        payload the directive's value -->
 *   <button type="button" v-vc-command="'cartAdd'" data-vc-target='{"id":2}' v-vc-payload="{ qty: 1 }">
 *     Add tea
 *   </button>
 *
 *   <p>{{ cart.state.value.count }} items, ${{ cart.state.value.total }}, last: {{ cart.state.value.lastAdded }}</p>
 *   <p role="status" class="error">{{ errs.latestError.value?.message }}</p>
 * </template>
 */

/*
 * Laravel backend (no Livewire): the reference controller,
 * examples/laravel-backend/VaporChamberController.php - `{ state }` on success,
 * an RFC 9457 problem on failure.
 *
 * // routes/web.php - the `web` group checks the CSRF token the bridge sends
 * Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
 * // Laravel's own event stream, one StreamedEvent per push (a real one loops):
 * Route::get('/api/vc/events', fn () => response()->eventStream(function () {
 *     yield new StreamedEvent(event: 'cartChanged', data: ['stores' => ['cart' => Cart::current()]]);
 * }))->middleware(['web']);
 */
