# Laravel integration

How to wire vapor-chamber into a Laravel backend: the minimum-viable shape
(one route, one controller, action classes) and the optional pieces (Sanctum
SPA flow, Filament panels, Inertia coexistence, Reverb / Echo realtime,
queued commands).

The examples ship as runnable PHP files under
[`examples/laravel-backend/`](../../examples/laravel-backend/), ready to copy
but not auto-loaded. Adapt namespaces and table names to your project.

---

## What the lib expects from your backend

The HTTP bridge POSTs every dispatch to a single endpoint. There is **one
route, not one-per-command** - the action name is in the JSON body.

**Request body** (every dispatch):
```json
{ "command": "cartAdd", "target": { "id": 42 }, "payload": { "qty": 2 } }
```

**Response body** (success):
```json
{ "ok": true, "state": { "...whatever your action returns..." } }
```

**Response body** (failure):
```json
{ "ok": false, "error": "Human-readable message" }
```

`state` becomes `result.value` on the client; `error` becomes
`result.error.message`. HTTP status codes follow normal Laravel conventions:
200 for success, 422 for a validation failure, 401 for an expired session,
419 for an expired CSRF token, 500 for an unhandled exception.

---

## Minimum viable backend

### 1. Route

```php
// routes/web.php  (cookie-CSRF case - see CSRF section below)
use App\Http\Controllers\VaporChamberController;

Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
```

For Sanctum SPA cookie auth, register it in `routes/api.php` instead, and mind
the path. Laravel prefixes routes in that file with `api`, so `'/vc'` resolves
to `/api/vc`; writing `'/api/vc'` would resolve to `/api/api/vc` and 404 every
dispatch:

```php
// routes/api.php  ('/vc' -> /api/vc - the api prefix is added automatically)
Route::post('/vc', VaporChamberController::class)
    ->middleware(['auth:sanctum']);
```

### 2. Controller

A thin dispatcher that resolves the command name to an action class. See
[`examples/laravel-backend/VaporChamberController.php`](../../examples/laravel-backend/VaporChamberController.php).

```php
namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Validation\ValidationException;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;

class VaporChamberController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $command = (string) $request->input('command');
        $target  = $request->input('target');
        $payload = $request->input('payload');

        $handler = config('vapor-chamber.handlers')[$command] ?? null;
        if (!$handler) {
            return response()->json(
                ['ok' => false, 'error' => "Unknown command: {$command}"],
                404,
            );
        }

        try {
            $state = app($handler)($target, $payload, $request->user());
            return response()->json(['ok' => true, 'state' => $state]);
        } catch (ValidationException $e) {
            return response()->json(['ok' => false, 'error' => $e->getMessage()], 422);
        } catch (AuthorizationException $e) {
            return response()->json(['ok' => false, 'error' => $e->getMessage()], 403);
        } catch (ModelNotFoundException $e) {
            return response()->json(['ok' => false, 'error' => 'Resource not found'], 404);
        } catch (\Throwable $e) {
            report($e);
            return response()->json(['ok' => false, 'error' => 'Internal error'], 500);
        }
    }
}
```

Keep the controller a dispatcher with no logic of its own; per-command
behavior belongs in action classes.

### 3. Action classes

One class per command. Easy to test, easy to authorize, easy to validate.
See [`examples/laravel-backend/AddToCart.php`](../../examples/laravel-backend/AddToCart.php).

```php
namespace App\Actions\Cart;

use App\Models\Cart;
use App\Models\User;

class AddToCart
{
    public function __invoke(?array $target, ?array $payload, ?User $user): array
    {
        validator($target ?? [], ['id' => 'required|integer'])->validate();

        $cart = $user?->cart() ?? Cart::session();
        $cart->add($target['id'], $payload['qty'] ?? 1);

        return [
            'count' => $cart->count,
            'total' => $cart->total,
        ];
    }
}
```

### 4. Command-to-handler registry

A single config file maps command names to action classes. See
[`examples/laravel-backend/config-vapor-chamber.php`](../../examples/laravel-backend/config-vapor-chamber.php).

```php
// config/vapor-chamber.php
return [
    'handlers' => [
        'cartAdd'     => \App\Actions\Cart\AddToCart::class,
        'cartRemove'  => \App\Actions\Cart\RemoveFromCart::class,
        'orderCreate' => \App\Actions\Order\CreateOrder::class,
        // ...
    ],
];
```

That is the minimum backend. To finish, add `<meta name="csrf-token">` to your
Blade layout and include the IIFE script tag.

---

## CSRF: pick one of two flows

The lib reads CSRF tokens from three DOM sources in order: meta tag, cookie,
hidden input. Match one of them on the backend.

### Flow A: `web` middleware + Blade meta tag

For server-rendered Blade pages (no SPA, no Sanctum):

```blade
{{-- in layouts/app.blade.php --}}
<meta name="csrf-token" content="{{ csrf_token() }}">
```

```php
// routes/web.php
Route::post('/api/vc', VaporChamberController::class)
    ->middleware(['web']);
```

```js
// client
const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
// `connect()` enables csrf:true automatically.
```

The lib reads the token from your meta tag and sends it as the `X-CSRF-TOKEN`
request header, which Laravel's `VerifyCsrfToken` middleware reads.

### Flow B: Sanctum SPA cookie flow

For SPA / Inertia setups using cookie-based session auth:

```bash
composer require laravel/sanctum
php artisan vendor:publish --provider="Laravel\Sanctum\SanctumServiceProvider"
php artisan migrate
php artisan install:api   # Laravel 11+: creates routes/api.php (absent on a fresh skeleton)
```

```php
// config/sanctum.php
'stateful' => explode(',', env('SANCTUM_STATEFUL_DOMAINS', 'localhost,localhost:5173')),
```

```php
// bootstrap/app.php (Laravel 11+) - without this every request 401s:
// Sanctum only treats SPA requests as stateful when the middleware is enabled.
->withMiddleware(function (Middleware $middleware) {
    $middleware->statefulApi();
})
```

```php
// routes/api.php - auto-prefixed with `api`, so '/vc' -> /api/vc
// (writing '/api/vc' here would resolve to /api/api/vc and 404)
Route::post('/vc', VaporChamberController::class)
    ->middleware(['auth:sanctum']);
```

```js
// client - same call site, csrf still on
const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
```

On a 419 response the lib fetches `/sanctum/csrf-cookie` and retries once,
with no extra client config. A 419 on that retry fails the dispatch; it never
calls `onSessionExpired`, which is reserved for 401.

With `csrfCookieUrl: ''` the lib skips the refresh fetch, but the retry still
re-reads the token, cookie first. Laravel's CSRF middleware sets a fresh
`XSRF-TOKEN` cookie on every response it passes, GET included
(`PreventRequestForgery::handle`, Laravel 13; off under `useOriginOnly()`), so
after any request through the `web` group the re-read finds a live token.

### CORS: required when the page and the API are different origins

Flow B typically means a Vite dev server (`localhost:5173`) talking to
`localhost:8000`. Those are two origins, so the browser sends a preflight
before every dispatch. The bridge always sends `X-Requested-With: XMLHttpRequest`
(it is what makes Laravel answer 419/401 as **JSON** instead of redirecting to
a login page), and `Idempotency-Key` whenever the `idempotent()` plugin is
enabled. If the preflight does not allow a header, the whole request fails
*before it reaches Laravel*, and the browser error says little: Chrome reports
only `Failed to fetch`; Firefox at least names the header.

```php
// config/cors.php  - `php artisan config:publish cors` to create it
'paths' => ['api/*', 'sanctum/csrf-cookie'],
'allowed_origins' => [env('FRONTEND_URL', 'http://localhost:5173')],
'allowed_headers' => [
    'Content-Type',
    'Accept',
    'X-Requested-With',    // <- always sent; omit it and every dispatch fails
    'X-CSRF-TOKEN',        // <- Flow A (Blade meta tag)
    'X-XSRF-TOKEN',        // <- Flow B (Sanctum cookie)
    'Idempotency-Key',     // <- only with the idempotent() plugin
],
'supports_credentials' => true,   // required for the cookie flows
```

`'allowed_headers' => ['*']` also works and is common in dev, but it does
**not** cover credentials in every proxy setup, so listing the headers is the
safer default. Same-origin deployments (Blade serves both the page and the
endpoint, as in Flow A) send no preflight and need none of this.

---

## With vapor-chamber/router (the family stack)

For Blade apps the first-choice navigation layer is the in-box
`vapor-chamber/router` subpath. Laravel keeps ONE catch-all
(`Route::view('/admin/{any?}', 'admin.shell')->where('any', '.*')`), the
Blade shell inlines the permission-filtered route table as JSON, and the
router owns everything inside. Reads go through route-declared loaders
(`load: "/api/vc/products?page={page}"`), aborted on supersede; the in-box
`vapor-chamber/router-fetch` preset covers plain JSON, or supply your own
preset to unwrap a house envelope. Writes go through this package's commands.
The split is CQRS across the two subpaths:
**bus = C (writes), router = R + URL state (reads)**. See
`examples/pattern-6-vapor-router.ts`.

---

## Inertia coexistence

vapor-chamber and Inertia are complementary and do not overlap: Inertia owns
navigation and page props, vapor-chamber owns in-page actions.

**Where the endpoint lives:** outside Inertia's middleware, so it returns
plain JSON instead of Inertia responses.

```php
// routes/web.php - Inertia routes here
Route::middleware(['web', \App\Http\Middleware\HandleInertiaRequests::class])
    ->group(function () {
        Route::get('/orders', [OrderController::class, 'index'])->name('orders.index');
    });

// vapor-chamber endpoint - same web middleware, NOT Inertia middleware
Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
```

**On the client:**

```ts
import { router } from '@inertiajs/vue3';
// Composables come from the Vue entry, which wires Vue at build time. From the
// package root they would lose reactivity and cleanup in a production build.
import { useCommand } from 'vapor-chamber/vue';

const { dispatch } = useCommand();

async function cancelOrder(id: number) {
  const result = await dispatch('orderCancel', { id });
  if (result.ok) router.visit('/orders');  // Inertia takes the navigation
}
```

`createHttpBridge` **ships** both `csrf: 'inertia'` and `onRedirect`.
`csrf: 'inertia'` defers token management to Inertia's Axios instance instead
of reading the meta tag. `onRedirect(url)` is called when the backend returns a
`{ redirect: '/path' }` field **in the JSON body**; wire it to
`router.visit(url)` so Inertia takes the navigation.

The contract is a body field, not a 302: `fetch` follows redirects itself, so
the bridge receives only the final response and never sees the 3xx. Your action
returns the redirect instead of issuing one:

```php
// in an action class - hand the navigation back to the client
return ['redirect' => route('login')];
```

```ts
const bridge = createHttpBridge({
  endpoint: '/api/vc',
  csrf: 'inertia',
  onRedirect: (url) => router.visit(url),
});
```

---

## Widget <-> Livewire / Alpine / Blade event bridging

A Vapor custom element widget (`defineWidget`) embedded in a Blade page,
Alpine controller, or Filament/Livewire panel must tell the surrounding code
when something happens inside it: a product added, a form submitted, a step
completed. Vue's `emit(...)` cannot do this. It goes through Vue's component
event system and does **not** bubble out as a DOM event, so Livewire, Alpine
and vanilla `addEventListener` never see it.

`emitDOMEvent` (shipped in the `elements` and `full` IIFE variants) bridges
that gap by dispatching a real `CustomEvent` on the host element. The event
bubbles, escapes shadow DOM (`composed: true` by default), and reaches every
listener that listens for DOM events.

> **What is verified here, and what is illustration.** The primitive is tested:
> `tests/vapor/widget-shape.test.ts` mounts a real Vapor custom element and
> asserts the event leaves the shadow root and arrives at the host, at
> `document`, and at `window` - the last being what Alpine's `.window` modifier
> and Livewire's `#[On(...)]` both rely on. The four host-framework patterns
> below are **illustrative**: Alpine, Livewire and Filament are not dependencies
> of this repo and nothing here executes them, so treat the snippets as the
> shape to follow rather than as tested code. The runnable Blade example that
> does ship - [`examples/laravel-app`](../../examples/laravel-app/) - uses plain
> DOM and no framework at all.

> **Tag naming - use the `vc-` prefix.** The recommended names are
> `<vc-cart/>`, `<vc-title/>`, `<vc-search/>` and so on. The prefix reads
> cleanly next to Blade components in `.blade.php` files, marks the tag as a
> vapor-chamber widget at a glance, avoids collisions with host-page
> elements, and is easy to grep across a codebase. If your project already
> has a brand prefix (`<acme-cart/>`), keep that. The `defineWidget` JSDoc
> gives the full rationale.

### Pattern 1: Blade page + Alpine.js

```html
<!-- resources/views/cart.blade.php -->
<meta name="csrf-token" content="{{ csrf_token() }}">

<div x-data="{ cartCount: 0 }"
     @cart-added.window="cartCount = $event.detail.count">

  <vc-cart></vc-cart>

  <span>Items: <span x-text="cartCount"></span></span>
</div>

<script src=".../vapor-chamber-elements.iife.min.js"></script>
<script>
  const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });

  VaporChamber.defineWidget('vc-cart', {
    setup() {
      // A Vapor setup() returns a BLOCK - real DOM nodes. With no build step
      // there is no compiler to turn a template into one, and `h` is not on
      // the VaporChamber global in any variant, so build the node directly.
      const button = document.createElement('button');
      button.textContent = 'Add to cart';
      button.addEventListener('click', async (e) => {
        const result = await dispatch('cartAdd', { id: 1 }, { qty: 1 });
        if (result.ok) {
          // Bridge widget event -> Alpine listener
          VaporChamber.emitDOMEvent(
            e.target.getRootNode().host,
            'cart-added',
            { count: result.value.count }
          );
        }
      });
      return button;
    }
  });
</script>
```

Alpine's `@cart-added.window` listens at the window level, which the event
reaches by bubbling. For scoped listening, put `@cart-added` directly on a
parent element.

### Pattern 2: Livewire 3

Livewire 3 components subscribe to DOM events declaratively:

```php
// app/Livewire/CartSidebar.php
class CartSidebar extends Component
{
    public int $count = 0;

    #[On('cart-added')]
    public function onCartAdded(array $detail): void
    {
        $this->count = $detail['count'];
        // Optionally re-fetch cart data, dispatch sub-events, etc.
    }

    public function render()
    {
        return view('livewire.cart-sidebar');
    }
}
```

```blade
{{-- resources/views/livewire/cart-sidebar.blade.php --}}
<div>
  <vc-cart></vc-cart>
  <p>Items: {{ $count }}</p>
</div>
```

The widget's `emitDOMEvent('cart-added', { count })` dispatches a DOM event
that Livewire 3's `#[On('cart-added')]` attribute picks up. Livewire's view
needs no JS plumbing; the Vapor widget is a drop-in component that emits
upward.

### Pattern 3: Filament panel widget

Filament panels are Livewire under the hood, so the pattern is the same:
embed a Vapor widget in a Filament widget's view and listen with `#[On(...)]`:

```php
// app/Filament/Widgets/AnalyticsIsland.php
class AnalyticsIsland extends Widget
{
    protected static string $view = 'filament.widgets.analytics-island';

    public ?string $latestQuery = null;

    #[On('search-executed')]
    public function onSearchExecuted(array $detail): void
    {
        $this->latestQuery = $detail['query'];
    }
}
```

```blade
{{-- resources/views/filament/widgets/analytics-island.blade.php --}}
<x-filament-widgets::widget>
  <x-filament::section>
    <vc-search-bar></vc-search-bar>
    @if($latestQuery)
      <p>Last search: <strong>{{ $latestQuery }}</strong></p>
    @endif
  </x-filament::section>
</x-filament-widgets::widget>
```

Inside `vc-search-bar`, the widget calls `emitDOMEvent(host, 'search-executed', { query })`.
Filament's panel re-renders without a Livewire round-trip to the server
unless you want one.

### Pattern 4: vanilla DOM, no framework

The same `emitDOMEvent` works without Alpine/Livewire:

```html
<vc-cart></vc-cart>
<script>
  document.querySelector('vc-cart')
    .addEventListener('cart-added', (e) => {
      console.log('Item added, count is now', e.detail.count);
    });
</script>
```

### Why this matters for Laravel specifically

Laravel projects typically have **multiple coexisting reactive layers**:
Blade renders the page, Alpine handles small interactions, Livewire owns
big component state, and Filament renders admin panels on Livewire.
vapor-chamber's widget surface is **none** of those; it is Vue Vapor. The
`emitDOMEvent` bridge is the **interop primitive** that lets a Vapor widget
participate in any of those layers without coupling to them. The same
pattern works for anything that reads DOM events: Stimulus (Rails), HTMX
(event listeners), Solid islands, vanilla.

---

## Filament panel coexistence (mounting / lifecycle)

The event-bridging patterns above cover how widgets *talk* to Filament; this
section covers how to *mount* them inside a panel.

Filament uses Livewire for its components; Vue Vapor + vapor-chamber lives
inside a Filament panel as **reactive islands**, each with its own bus.

```php
// app/Filament/Widgets/AnalyticsWidget.php
class AnalyticsWidget extends Widget
{
    protected static string $view = 'filament.widgets.analytics-island';

    public function getViewData(): array
    {
        return ['endpoint' => url('/api/vc')];
    }
}
```

```blade
{{-- resources/views/filament/widgets/analytics-island.blade.php --}}
<x-filament-widgets::widget>
  <x-filament::section>
    <div id="analytics-island" data-endpoint="{{ $endpoint }}">
      {{-- Vue Vapor mounts here; Livewire runs the rest of the panel --}}
    </div>
  </x-filament::section>
</x-filament-widgets::widget>

<script type="module" src="{{ Vite::asset('resources/js/islands/analytics.ts') }}"></script>
```

The vapor-chamber controller and Filament's panel guard sit on different
routes, so there is no auth conflict and no middleware overlap.

See [`examples/pattern-5-filament.ts`](../../examples/pattern-5-filament.ts)
for the full client-side island.

---

## Realtime (Reverb / Echo / WebSocket)

The lib's generic `createWsBridge` works with any WebSocket server. For
Laravel Reverb / Echo, wire the Echo client to the bus's `emit()` and let
your handlers react to events:

```bash
composer require laravel/reverb
php artisan reverb:install
```

Use the protocol-aware `createEchoBridge`. It subscribes to public, private and
presence channels, routes each broadcast to the bus, and also emits presence
membership (`here` / `joining` / `leaving`). You pass your own Echo instance, so
vapor-chamber never imports `laravel-echo`:

```js
import Echo from 'laravel-echo';
import { createCommandBus } from 'vapor-chamber';
import { createEchoBridge } from 'vapor-chamber/transports';

const bus = createCommandBus();
const echo = new Echo({
  broadcaster: 'reverb',
  key: import.meta.env.VITE_REVERB_APP_KEY,
  wsHost: import.meta.env.VITE_REVERB_HOST,
  wsPort: import.meta.env.VITE_REVERB_PORT,
});

const realtime = createEchoBridge({
  echo,
  channels: [
    { name: `user.${userId}`, type: 'private',  events: ['OrderShipped', 'OrderCancelled'] },
    { name: 'lobby',          type: 'presence', events: ['MessagePosted'] },
  ],
});
realtime.install(bus); // OrderShipped -> bus.emit('OrderShipped', payload); lobby:joining on presence

// on teardown (component unmount / SPA route change):
realtime.teardown();
```

To react with a *command* instead of an event, pass `onBroadcast: ({ payload }, b)
=> b.dispatch('applyShipment', payload)`. Realtime is receive-only: outbound writes
still go through the HTTP bridge, with CSRF and the `Idempotency-Key` header above.

---

## Queued / long-running commands

Commands that take more than a few hundred ms shouldn't block the HTTP
request. The action dispatches a queued job and returns optimistic state:

```php
// app/Actions/Order/ProcessCheckout.php
class ProcessCheckout
{
    public function __invoke(?array $target, ?array $payload, ?User $user): array
    {
        $order = \App\Models\Order::create([
            'user_id' => $user?->id,
            'items'   => $target['items'] ?? [],
            'status'  => 'queued',
        ]);

        \App\Jobs\ProcessOrderJob::dispatch($order);

        return [
            'orderId' => $order->id,
            'status'  => 'queued',
        ];
    }
}
```

On the client, pair it with the lib's `optimistic` plugin (apply the UI change
immediately, roll back on failure), a polling `orderStatusCheck` command, or
both; or push the final state via Reverb.

---

## Authorization per command

Authorize inside the action class using policies or `Gate::authorize()`:

```php
namespace App\Actions\Order;

use App\Models\Order;
use App\Models\User;
use Illuminate\Support\Facades\Gate;

class CancelOrder
{
    public function __invoke(?array $target, ?array $payload, ?User $user): array
    {
        $order = Order::findOrFail($target['id'] ?? null);
        Gate::forUser($user)->authorize('cancel', $order);

        $order->cancel();

        return ['orderId' => $order->id, 'status' => $order->status];
    }
}
```

The controller's `AuthorizationException` catch maps it to `403 + { ok:
false, error: ... }`.

---

## Validation per command

Validate inside the action class, with `validator()` for inline rules or with
a dedicated `FormRequest`:

```php
class UpdateProfile
{
    public function __invoke(?array $target, ?array $payload, ?User $user): array
    {
        $data = validator($payload ?? [], [
            'name'   => 'required|string|max:255',
            'email'  => 'required|email',
            'phone'  => 'nullable|string',
        ])->validate();

        $user->update($data);
        return ['profile' => $user->only(['name', 'email', 'phone'])];
    }
}
```

The controller's `ValidationException` catch maps it to `422 + { ok: false,
error: ... }`.

---

## Idempotency & double-submit protection

The classic "user clicks Checkout twice" race has two halves, and vapor-chamber
covers the client side of both:

- **Locally** - the `idempotent` plugin collapses duplicate dispatches of the same
  logical command, so the handler (and the request it makes) runs once. Concurrent
  duplicates share the first in-flight promise; repeats within the TTL return the
  cached result. Failures aren't cached, so a genuine retry still runs.
- **On the wire** - `idempotent` stamps `cmd.meta.idempotencyKey`, and the HTTP
  bridge forwards it as a standard `Idempotency-Key` request header. The backend
  reads that header, replays the stored result for a key it has finished, and
  answers **409** to a second request while the first with the same key is still
  running - so even a retry that slips past the client lands once. 409 is a 4xx,
  which the bridge never retries, so the client sees one outcome.

```ts
import { createAsyncCommandBus, idempotent } from 'vapor-chamber';
import { createHttpBridge } from 'vapor-chamber/transports';

const bus = createAsyncCommandBus();
// idempotent OUTERMOST (higher priority) so the key is stamped before the bridge builds the request
bus.use(idempotent({ actions: ['order*', 'checkout*'] }), { priority: 100 });
bus.use(createHttpBridge({ endpoint: '/api/vc', csrf: true }));

// two rapid clicks -> one handler run, one backend write
bus.dispatch('checkoutSubmit', { cartId });
bus.dispatch('checkoutSubmit', { cartId });
```

For commands that must also never *interleave* (two writes to the same account),
add `serialize({ key })`: it orders same-key commands locally while `idempotent`
collapses identical ones. Together they give exactly-once semantics on the client.

The only backend contract is the standard one: honor the `Idempotency-Key` header
(persist the key with its result; return the stored result on a repeat), and
never run the same key twice at once. A cache alone cannot guarantee the second
part. It stores the result only after the action succeeds, so a retry that
arrives while the first attempt is still running (a client timeout on a slow
write) would miss the cache and run the action again, concurrently. The example
controller therefore takes a lock on the key before the cache read and holds it
for the whole run. From `dispatchOne()` in
[`examples/laravel-backend/VaporChamberController.php`](../../examples/laravel-backend/VaporChamberController.php),
line for line:

```php
        $cacheKey = $idempotencyKey ? "vc:idem:{$command}:{$idempotencyKey}" : null;

        // The cache alone does not make a key land once: nothing is stored
        // until the action SUCCEEDS, so a retry arriving while the first
        // attempt is still running (a client timeout on a slow write) misses
        // the cache and runs the action a second time, concurrently. The lock
        // is taken BEFORE the cache read and held for the whole run; a request
        // that cannot get it is answered 409, a 4xx the bridge never retries,
        // so the client sees one outcome. 30s bounds a crashed holder.
        $lock = $cacheKey ? Cache::lock("vc:idem:lock:{$command}:{$idempotencyKey}", 30) : null;
        if ($lock && !$lock->get()) {
            return $this->fail('A request with this Idempotency-Key is still running', 409, 'in_progress');
        }

        try {
            if ($cacheKey && ($cached = Cache::get($cacheKey)) !== null) {
                return ['body' => $cached, 'status' => 200];
            }

            $state = app($handler)($target, $payload, $user);
            $body = ['ok' => true, 'state' => $state];
            if ($cacheKey) {
                Cache::put($cacheKey, $body, self::IDEMPOTENCY_TTL_SECONDS);
            }
            return ['body' => $body, 'status' => 200];
        } catch (ValidationException $e) {
            // ... exception mapping, unchanged
        } finally {
            $lock?->release();
        }
```

`Cache::lock` needs a cache store that supports atomic locks (redis, memcached,
database, dynamodb, file, array). The batch endpoint runs every command through
the same `dispatchOne()`, so it gets the same guard.

---

## Smoke test

```bash
# Server
php artisan serve

# In your Blade layout
<meta name="csrf-token" content="{{ csrf_token() }}">
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber@<version>/dist/vapor-chamber-core.iife.min.js"></script>
<script>
  const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
  dispatch('cartAdd', { id: 1 }, { qty: 2 }).then(r => console.log(r));
</script>
```

The server log should show one `POST /api/vc`, and the browser console
`{ ok: true, value: { count: 1, total: ... } }`.

Once that round-trips, every other command on your bus uses identical
plumbing: register the action class and add a line to
`config/vapor-chamber.php`.

---

## What you don't need

- **No middleware specific to vapor-chamber.** It rides on existing
  `VerifyCsrfToken` + `Authenticate`.
- **No PHP package / Composer dependency.** vapor-chamber is JS-only.
- **No Echo / Reverb** unless you want push-based realtime. HTTP is enough
  for command dispatch.
- **No Livewire dependency or replacement target.** They coexist on
  separate routes / scopes.
