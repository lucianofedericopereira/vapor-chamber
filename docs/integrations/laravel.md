# Laravel integration

Practical reference for wiring vapor-chamber into a Laravel backend. Covers
the minimum-viable shape (one route + one controller + action classes) and
the optional pieces (Sanctum SPA flow, Filament panels, Inertia coexistence,
Reverb / Echo realtime, queued commands).

The examples in this guide ship as runnable PHP files under
[`examples/laravel-backend/`](../../examples/laravel-backend/) — copy-paste
ready, not auto-loaded. Adapt namespaces and table names to your project.

---

## What the lib expects from your backend

The HTTP bridge POSTs every dispatch to a single endpoint. There is **one
route, not one-per-command** — the action name is in the JSON body.

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
`result.error.message`. HTTP status codes follow normal Laravel conventions
(200 for success, 422 for validation, 401 for session expired, 419 for CSRF
expired, 500 for unhandled).

---

## Minimum viable backend

### 1. Route

```php
// routes/web.php  (cookie-CSRF case — see CSRF section below)
use App\Http\Controllers\VaporChamberController;

Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
```

Or under Sanctum if you're doing SPA cookie auth:

```php
// routes/api.php
Route::post('/api/vc', VaporChamberController::class)
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
        } catch (\Throwable $e) {
            report($e);
            return response()->json(['ok' => false, 'error' => 'Internal error'], 500);
        }
    }
}
```

Don't put logic in the controller — keep it as a dispatcher. Put per-command
behavior in action classes.

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
        // …
    ],
];
```

That's the minimum. Add a route to your Blade layout's `<meta name="csrf-token">`,
drop the IIFE script tag in, and you're done.

---

## CSRF — pick one of two flows

The lib reads CSRF tokens from three DOM sources in order: meta tag, cookie,
hidden input. Match one of them on the backend.

### Flow A — `web` middleware + Blade meta tag

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

Laravel's `VerifyCsrfToken` middleware reads `X-CSRF-TOKEN` from the request
header; the lib reads it from your meta tag and attaches it. Done.

### Flow B — Sanctum SPA cookie flow

For SPA / Inertia setups using cookie-based session auth:

```bash
composer require laravel/sanctum
php artisan vendor:publish --provider="Laravel\Sanctum\SanctumServiceProvider"
php artisan migrate
```

```php
// config/sanctum.php
'stateful' => explode(',', env('SANCTUM_STATEFUL_DOMAINS', 'localhost,localhost:5173')),
```

```php
// routes/api.php
Route::post('/api/vc', VaporChamberController::class)
    ->middleware(['auth:sanctum']);
```

```js
// client — same call site, csrf still on
const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
```

The lib auto-fetches `/sanctum/csrf-cookie` on a 419 response and retries
once. No extra client config.

---

## Inertia coexistence

vapor-chamber and Inertia are complementary: Inertia owns navigation and
page props, vapor-chamber owns in-page actions. They don't overlap.

**Where the endpoint lives:** outside Inertia's middleware, so it returns
plain JSON instead of Inertia responses.

```php
// routes/web.php — Inertia routes here
Route::middleware(['web', \App\Http\Middleware\HandleInertiaRequests::class])
    ->group(function () {
        Route::get('/orders', [OrderController::class, 'index'])->name('orders.index');
    });

// vapor-chamber endpoint — same web middleware, NOT Inertia middleware
Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
```

**On the client:**

```ts
import { router } from '@inertiajs/vue3';
import { useCommand } from 'vapor-chamber';

const { dispatch } = useCommand();

async function cancelOrder(id: number) {
  const result = await dispatch('orderCancel', { id });
  if (result.ok) router.visit('/orders');  // Inertia takes the navigation
}
```

The whitepaper §11.3 mentions `csrf: 'inertia'` and `onRedirect` flags —
those are roadmap items, not shipped. Use the pattern above today.

---

## Widget ↔ Livewire / Alpine / Blade event bridging

When you embed a Vapor custom element widget (`defineWidget`) into a Blade
page, Alpine controller, or Filament/Livewire panel, the widget needs a way
to notify the surrounding code when something happens inside it — a product
added, a form submitted, a step completed. Vue's `emit(...)` goes through
Vue's component event system; it does **not** bubble out as a DOM event,
so Livewire / Alpine / vanilla `addEventListener` can't see it.

> **Tag naming — use the `vc-` prefix.** The recommended convention is
> `<vc-cart/>`, `<vc-title/>`, `<vc-search/>` etc. — clean next to Blade
> components in `.blade.php` files, instantly recognizable as
> vapor-chamber widgets, no collision with host-page elements, easy to
> grep across a codebase. If your project already has a brand prefix
> (`<acme-cart/>`), keep that. See the `defineWidget` JSDoc for the
> full rationale.

`emitDOMEvent` (shipped in the `elements` and `full` IIFE variants) bridges
that gap by dispatching a real `CustomEvent` on the host element. Bubbles
out, escapes shadow DOM (`composed: true` by default), reaches every
listener that knows how to listen for DOM events.

### Pattern 1 — Blade page + Alpine.js

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
      return () => h('button', {
        onClick: async (e) => {
          const result = await dispatch('cartAdd', { id: 1 }, { qty: 1 });
          if (result.ok) {
            // Bridge widget event → Alpine listener
            VaporChamber.emitDOMEvent(
              e.target.getRootNode().host,
              'cart-added',
              { count: result.value.count }
            );
          }
        }
      }, 'Add to cart');
    }
  });
</script>
```

Alpine's `@cart-added.window` listens at the window level (the event bubbles
up). Use `@cart-added` directly on a parent element if you want scoped
listening.

### Pattern 2 — Livewire 3

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
that Livewire 3's `#[On('cart-added')]` attribute picks up. No JS plumbing
in Livewire's view; the Vapor widget is a drop-in component that emits
upward.

### Pattern 3 — Filament panel widget

Filament panels are Livewire under the hood. Same pattern — embed a Vapor
widget inside a Filament widget's view, listen via `#[On(...)]`:

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
Filament's panel re-renders without a Livewire round-trip back through
the server unless you want one.

### Pattern 4 — vanilla DOM, no framework

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

Laravel projects typically have **multiple coexisting reactive layers** —
Blade renders the page, Alpine handles small interactions, Livewire owns
big component state, Filament renders admin panels on Livewire. Vapor
Chamber's widget surface is **none** of those — it's Vue Vapor. The
`emitDOMEvent` bridge is the **interop primitive** that lets a Vapor
widget participate in any of those layers without coupling to them.

Same pattern works for Stimulus (Rails), HTMX (event listeners), Solid
islands, vanilla — anything that reads DOM events.

---

## Filament panel coexistence (mounting / lifecycle)

The event-bridging patterns above cover how widgets *talk* to Filament.
This section covers how to *mount* them inside a panel.

Filament uses Livewire for its components; Vue Vapor + vapor-chamber lives
as **reactive islands** inside a Filament panel. Each island has its own bus.

```php
// app/Filament/Widgets/AnalyticsWidget.php
class AnalyticsWidget extends Widget
{
    protected static string $view = 'filament.widgets.analytics-island';

    public function getViewData(): array
    {
        return ['endpoint' => route('api.vc')];
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
routes — no auth conflict, no middleware overlap.

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

Use the protocol-aware `createEchoBridge` — it subscribes public / private /
presence channels and routes each broadcast to the bus, with presence membership
(`here` / `joining` / `leaving`) emitted too. You pass your own Echo instance, so
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
realtime.install(bus); // OrderShipped → bus.emit('OrderShipped', payload); lobby:joining on presence

// on teardown (component unmount / SPA route change):
realtime.teardown();
```

Need to react with a *command* instead of an event? Pass `onBroadcast: ({ payload }, b)
=> b.dispatch('applyShipment', payload)`. Realtime is receive-only — outbound writes
still go through the HTTP bridge (with CSRF + the `Idempotency-Key` header above).

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

On the client, pair with the lib's `optimistic` plugin (apply UI change
immediately, roll back on failure) and/or a polling `orderStatusCheck`
command — or push final state via Reverb.

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

Inside the action class, either with `validator()` for inline rules or a
dedicated `FormRequest`:

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

- **Locally** — the `idempotent` plugin collapses duplicate dispatches of the same
  logical command, so the handler (and the request it makes) runs once. Concurrent
  duplicates share the first in-flight promise; repeats within the TTL return the
  cached result. Failures aren't cached, so a genuine retry still runs.
- **On the wire** — `idempotent` stamps `cmd.meta.idempotencyKey`, and the HTTP
  bridge forwards it as a standard `Idempotency-Key` request header. The backend
  reads that header and rejects a second write with the same key — so even a retry
  that slips past the client lands once.

```ts
import { createAsyncCommandBus, idempotent } from 'vapor-chamber';
import { createHttpBridge } from 'vapor-chamber/transports';

const bus = createAsyncCommandBus();
// idempotent OUTERMOST (higher priority) so the key is stamped before the bridge builds the request
bus.use(idempotent({ actions: ['order*', 'checkout*'] }), { priority: 100 });
bus.use(createHttpBridge({ endpoint: '/commands', csrf: true }));

// two rapid clicks → one handler run, one backend write
bus.dispatch('checkoutSubmit', { cartId });
bus.dispatch('checkoutSubmit', { cartId });
```

For commands that must also never *interleave* (two writes to the same account),
add `serialize({ key })` — it orders same-key commands locally while `idempotent`
collapses identical ones. Together they give exactly-once semantics on the client.
The only backend contract is the standard one: honor the `Idempotency-Key` header
(persist the key with its result; return the stored result on a repeat).

> Deeply-reactive command state two-way bound with `v-model`? The opt-in
> `vapor-chamber/reactive` companion (`useDeepCommandState` / `deepSignal`) adds
> nested-mutation reactivity; the core stays shallow + fast by default.

---

## Smoke test

```bash
# Server
php artisan serve

# In your Blade layout
<meta name="csrf-token" content="{{ csrf_token() }}">
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber/dist/vapor-chamber-core.iife.min.js"></script>
<script>
  const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
  dispatch('cartAdd', { id: 1 }, { qty: 2 }).then(r => console.log(r));
</script>
```

Server log should show one `POST /api/vc`. Browser console should show
`{ ok: true, value: { count: 1, total: ... } }`.

If that round-trips, every other command on your bus uses identical
plumbing — register the action class, add a line to `config/vapor-chamber.php`,
done.

---

## What you don't need

- **No middleware specific to vapor-chamber.** It rides on existing
  `VerifyCsrfToken` + `Authenticate`.
- **No PHP package / Composer dependency.** vapor-chamber is JS-only.
- **No Echo / Reverb** unless you want push-based realtime. HTTP is enough
  for command dispatch.
- **No Livewire dependency or replacement target.** They coexist on
  separate routes / scopes.
