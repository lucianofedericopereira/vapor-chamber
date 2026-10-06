# Laravel integration

How to wire vapor-chamber into a Laravel backend. First the minimum-viable
shape: one route, one controller, action classes. Then the optional pieces:
Sanctum SPA flow, Filament panels, Inertia coexistence, Reverb / Echo realtime,
queued commands.

The examples ship as runnable PHP files under
[`examples/laravel-backend/`](../../examples/laravel-backend/), ready to copy
but not auto-loaded. Adapt namespaces and table names to your project.

---

## What the lib expects from your backend

The HTTP bridge POSTs every dispatch to a single endpoint. There is **one
route, not one-per-command**: the action name is in the JSON body.

**Request body** (every dispatch):
```json
{ "command": "cartAdd", "target": { "id": 42 }, "payload": { "qty": 2 } }
```

**Response body** (success):
```json
{ "state": { "...whatever your action returns..." } }
```
or `{ "redirect": "/login" }` for a navigation (see `onRedirect`).

**Response body** (failure): an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457)
problem, sent with the status and `Content-Type: application/problem+json`. It
carries the members the contract uses and nothing else. Some backends cannot
set the HTTP status. For them, a 2xx whose body is `{ "problem": { ... } }` is
read as the same failure, by the problem's own `status`:
```json
{
  "status": 422,
  "code": "validation_failed",
  "detail": "The given data was invalid.",
  "errors": [{ "pointer": "/payload/email", "detail": "The email has already been taken." }]
}
```

`state` becomes `result.value`. A failure becomes a `BusError` whose code is
`remote:<condition>:<your code>`. The owner is the client's fact: the backend
answered. The condition is what your `status` declares, read through one table
that says only what RFC 9110 says of a status. `detail` is the message.
`code`, `status`, `errors` and any other member are in `error.context`.

`errors` points into the envelope the client sent (`/payload/<field>`, RFC
6901), which is what `FormBus` puts on its fields. There is no `ok` flag, no
`error` or `message`, no `type` or `title`: one member per fact.

| Status | Condition |
|---|---|
| 404, 410 | `missing` |
| 409, 412 | `conflict` |
| 401, 419 | `unauthenticated` |
| 403 | `refused` |
| 429, 503 | `limited` |
| 408, 504 | `timeout` |
| 501, 502, 505 | `unexpected` |
| any other 5xx | `failed` |
| any other 4xx | `invalid` |

So the status you send IS the declaration of what the failure is:

- 409 for a conflict with the current state.
- 401 or 419 for "sign in, then try again".
- 403 for "not allowed".
- 429 or 503 for "come back later".
- 422 for input that broke a rule.

A `Retry-After` header (RFC 9110) goes to `error.context.retryIn`.

**On the batch endpoint** the response is a 200. Each command's answer rides on
its own result, the problem carrying the command's own `status`:
```json
{ "results": [
  { "id": "1", "state": { "count": 3 } },
  { "id": "2", "problem": { "status": 404, "code": "not_found", "detail": "No such cart" } }
] }
```
A batched failure reads exactly as the same failure sent alone.

Branch on the code:

```js
const result = await bus.dispatch('cartAdd', product, { qty: 2 })
if (!result.ok && result.error.code === 'remote:limited:stock_depleted') showRestockNotice()
```

**Retries follow the condition.** The async bus re-sends through the bridge, on
by default:

- A 429, 503 or 408 is re-sent, after the `Retry-After` it declares.
- A 4xx verdict (422, 404, 403, 409) is not re-sent.
- No reply (`transport:timeout:reply`, `transport:lost:reply`), a 502, 504 or
  500 may have landed. It is re-sent only for an identified command: an action
  declared idempotent, or a command carrying a key.
- A verdict that carries `Retry-After` follows the same rule. The header sets
  the wait, never whether.

Declare an action idempotent with
`createAsyncCommandBus({ retry: { actionPolicies: { cartSet: 'idempotent' } } })`,
or with `retry: 'idempotent'` on the schema action. A declared action sends one
`Idempotency-Key` on every attempt. An unkeyed command that got no reply fails
with `context.outcome: 'unknown'`: check its status on the server.

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
to `/api/vc`. Writing `'/api/vc'` would resolve to `/api/api/vc` and 404 every
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
            return $this->problem("Unknown command: {$command}", 404, 'unknown_command');
        }

        try {
            $state = app($handler)($target, $payload, $request->user());
            return response()->json(['state' => $state]);
        } catch (ValidationException $e) {
            // Laravel's field map as the contract's errors: /payload/<field>,
            // each segment escaped per RFC 6901 (~ -> ~0, / -> ~1).
            $errors = [];
            foreach ($e->errors() as $field => $messages) {
                $segments = array_map(fn ($s) => str_replace(['~', '/'], ['~0', '~1'], $s), explode('.', $field));
                $errors[] = ['pointer' => '/payload/'.implode('/', $segments), 'detail' => $messages[0]];
            }
            return $this->problem($e->getMessage(), 422, 'validation_failed', $errors);
        } catch (AuthorizationException $e) {
            return $this->problem($e->getMessage(), 403, 'forbidden');
        } catch (ModelNotFoundException $e) {
            return $this->problem('Resource not found', 404, 'not_found');
        } catch (\Throwable $e) {
            report($e);
            return $this->problem('Internal error', 500, 'internal_error');
        }
    }

    private function problem(string $detail, int $status, string $code, array $errors = []): JsonResponse
    {
        $body = ['status' => $status, 'code' => $code, 'detail' => $detail];
        if ($errors !== []) {
            $body['errors'] = $errors;
        }
        return response()->json($body, $status, ['Content-Type' => 'application/problem+json']);
    }
}
```

Keep the controller a dispatcher with no logic of its own. Per-command
behavior belongs in action classes. The example controller adds what this
minimal one leaves out: the batch endpoint, `Idempotency-Key` replay, and the
redirect, stores and 202 shapes below.

### 3. Action classes

One class per command. Easy to test, easy to authorize, easy to validate.
See [`examples/laravel-backend/AddToCart.php`](../../examples/laravel-backend/AddToCart.php).

```php
namespace App\Actions\Cart;

use App\Models\Cart;
use App\Models\Product;
use App\Models\User;

class AddToCart
{
    public function __invoke(?array $target, ?array $payload, ?User $user): array
    {
        // The target is identity: a missing product is a 404 (findOrFail).
        $product = Product::findOrFail((int) ($target['id'] ?? 0));
        // The payload is input: its field errors point at /payload/<field>.
        $input = validator($payload ?? [], ['qty' => 'sometimes|integer|min:1'])->validate();

        $cart = $user?->cart() ?? Cart::session();
        $cart->add($product->id, $input['qty'] ?? 1);

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
with no extra client config. A 419 on that retry fails the dispatch. It never
calls `onSessionExpired`, which is reserved for 401.

With `csrfCookieUrl: ''` the lib skips the refresh fetch, but the retry still
re-reads the token, cookie first. Laravel's CSRF middleware sets a fresh
`XSRF-TOKEN` cookie on every response it passes, GET included. That is
`PreventRequestForgery::handle` in Laravel 13, off under `useOriginOnly()`. So
after any request through the `web` group the re-read finds a live token.

### CORS: needed when the page and the API are different origins

Flow B typically means a Vite dev server (`localhost:5173`) talking to
`localhost:8000`. Those are two origins, so the browser sends a preflight
before every dispatch.

The bridge always sends `X-Requested-With: XMLHttpRequest`. It is what makes
Laravel answer 419/401 as **JSON** instead of redirecting to a login page. It
also sends `Idempotency-Key` whenever the command carries one. The
`idempotent()` plugin stamps it, and so does `vapor-chamber/outbox` on every
delivery attempt of a queued command.

If the preflight does not allow a header, the whole request fails *before it
reaches Laravel*, and the browser error says little. Chrome reports only
`Failed to fetch`. Firefox at least names the header.

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
    'Idempotency-Key',     // <- with idempotent() or the outbox
],
'exposed_headers' => ['Location', 'Retry-After'],   // <- pollWith reads them
'supports_credentials' => true,   // needed for the cookie flows
```

`'allowed_headers' => ['*']` also works and is common in dev. But it does
**not** cover credentials in every proxy setup, so listing the headers is the
safer default. Same-origin deployments (Blade serves both the page and the
endpoint, as in Flow A) send no preflight and need none of this.

---

## With vapor-chamber/router (the family stack)

For Blade apps the first-choice navigation layer is the in-box
`vapor-chamber/router` subpath. Laravel keeps ONE catch-all
(`Route::view('/admin/{any?}', 'admin.shell')->where('any', '.*')`). The Blade
shell inlines the permission-filtered route table as JSON, and the router owns
everything inside.

Reads go through route-declared loaders
(`load: "/api/vc/products?page={page}"`), aborted on supersede. The in-box
`vapor-chamber/router-fetch` preset covers plain JSON, or supply your own preset
to unwrap a house envelope. Writes go through this package's commands. The
split is CQRS across the two subpaths:
**bus = C (writes), router = R + URL state (reads)**. See
`examples/pattern-6-vapor-router.ts`.

---

## Inertia coexistence

vapor-chamber and Inertia are complementary and do not overlap. Inertia owns
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

`createHttpBridge` takes `csrf: true` and `onRedirect` in an Inertia app.
`csrf: true` reads the token from the page. With no meta tag it reads the
`XSRF-TOKEN` cookie Laravel sets and sends it as `X-XSRF-TOKEN`. The bridge
makes its own requests, so an Axios interceptor of the app does not reach them.

`onRedirect(url)` is called when the backend returns a `{ redirect: '/path' }`
field **in the JSON body**. Wire it to `router.visit(url)` so Inertia takes the
navigation.

The contract is a body field, not a 302. `fetch` follows redirects itself, so
the bridge receives only the final response and never sees the 3xx. Your action
returns the redirect instead of issuing one:

```php
// in an action class - hand the navigation back to the client
return ['redirect' => route('login')];
```

The example controller lifts exactly that shape, an array whose only key is
`redirect`, to the top of the envelope (`{ redirect }`). On the batch endpoint
it does so per result. That is where the bridges read it. A state that merely
contains a `redirect` key among others is returned as data.

`createBatchingHttpBridge` honours `onRedirect` too. It navigates once per
batch, with the first URL. Every redirected command still fails with its own
`error.context.url`.

An action can also tell the client which stores changed. It returns the
states by store id, beside its own `state` or alone:

```php
// in a checkout action - the cart and the stock both changed
return ['state' => ['order' => $order->id], 'stores' => [
    'cart'  => ['rev' => $cart->rev, 'items' => []],
    'stock' => ['left' => $product->stock],
]];
```

The example controller lifts exactly that key set (`state` and `stores`, or
`stores` alone) to the top of the envelope. On the batch endpoint it does so
per result. Each store with that id on the client's bus takes its state, whatever the
command was (docs/store.md, A store behind a bridge). A state that merely
contains a `stores` key among others is returned as data.

```ts
const bridge = createHttpBridge({
  endpoint: '/api/vc',
  csrf: true,
  onRedirect: (url) => router.visit(url),
});
```

**A redirect is a FAILED dispatch, handler or no handler.** `onRedirect` fires
and the dispatch still resolves `{ ok: false }`. There is no state to return, so
there is nothing for `result.value` to be. Do not write `if (result.ok)` after a
command the backend may redirect. Branch on the code instead:

```ts
const result = await dispatch('orderCancel', { id })
if (!result.ok && result.error.code === 'transport:refused:redirect') return  // Inertia is navigating
```

That error carries `code: 'transport:refused:redirect'` and `error.context.url`,
so you can read the target without parsing the message. Its condition is
`refused`, so the bus does not re-send it. A backend that redirects will
redirect again, and `onRedirect` fires once. With no `onRedirect` configured the
same code arrives, and in development its message says no handler is
configured. That is how a missing handler surfaces instead of a silent no-op.

---

## Widget <-> Livewire / Alpine / Blade event bridging

A Vapor custom element widget (`defineWidget`) can sit in a Blade page, an
Alpine controller, or a Filament/Livewire panel. It must tell the surrounding
code when something happens inside it: a product added, a form submitted, a
step completed.

Vue's `emit(...)` cannot do this. It goes through Vue's component event system
and does **not** bubble out as a DOM event, so Livewire, Alpine and vanilla
`addEventListener` never see it.

`emitDOMEvent` (shipped in the `elements` and `full` IIFE variants) bridges
that gap by dispatching a real `CustomEvent` on the host element. The event
bubbles, escapes shadow DOM (`composed: true` by default), and reaches every
listener that listens for DOM events.

> **What is verified here, and what is illustration.** The primitive is tested.
> `tests/vapor/widget-shape.test.ts` mounts a real Vapor custom element. It
> asserts the event leaves the shadow root and arrives at the host, at
> `document`, and at `window`. The last is what Alpine's `.window` modifier and
> Livewire's `#[On(...)]` both rely on.
>
> The four host-framework patterns below are **illustrative**. Alpine, Livewire
> and Filament are not dependencies of this repo and nothing here executes
> them. So treat the snippets as the shape to follow rather than as tested
> code. The runnable Blade example that does ship,
> [`examples/laravel-app`](../../examples/laravel-app/), uses plain DOM and no
> framework at all.

> **Tag naming: use the `vc-` prefix.** The recommended names are
> `<vc-cart/>`, `<vc-title/>`, `<vc-search/>` and so on. The prefix reads
> cleanly next to Blade components in `.blade.php` files, and marks the tag as a
> vapor-chamber widget at a glance. It avoids collisions with host-page
> elements, and is easy to grep across a codebase. If your project already has
> a brand prefix (`<acme-cart/>`), keep that. The `defineWidget` JSDoc gives
> the full rationale.

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

<!-- Vue, as a MODULE, and then configureVue(). Not optional on this variant:
     Vue ships Vapor as esm-browser ONLY - there is no
     vue.runtime-with-vapor.global.js - so a classic <script src> page cannot
     obtain Vapor, and the library's runtime probe cannot resolve a bare
     specifier in a browser. Without this, defineWidget() returns false and the
     widget never mounts, with nothing thrown. -->
<script type="module">
  const Vue = await import(
    'https://cdn.jsdelivr.net/npm/vue@<version>/dist/vue.runtime-with-vapor.esm-browser.prod.js'
  );
  VaporChamber.configureVue(Vue);

  const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });

  const defined = VaporChamber.defineWidget('vc-cart', {
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

  // The sharp edge, made visible rather than silent.
  if (!defined) console.warn('Vapor was not detected - the widget did not mount.');
</script>
```

[`examples/laravel-app`](../../examples/laravel-app/) runs this page for real.
It pins the Vue version it loads to the one this library is tested against,
instead of leaving a placeholder in the URL.

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
needs no JS plumbing. The Vapor widget is a drop-in component that emits
upward.

### Pattern 3: Filament panel widget

Filament panels are Livewire under the hood, so the pattern is the same. Embed
a Vapor widget in a Filament widget's view and listen with `#[On(...)]`:

```php
// app/Filament/Widgets/AnalyticsIsland.php
class AnalyticsIsland extends Widget
{
    protected string $view = 'filament.widgets.analytics-island'; // Filament 4+: an instance property

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
The `#[On]` listener runs on the server, as every Livewire listener does. Each
event costs one Livewire request, and the panel re-renders with its answer. For
an update that needs no server, listen in Alpine instead (Pattern 1).

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

Laravel projects typically have **multiple coexisting reactive layers**. Blade
renders the page, Alpine handles small interactions, Livewire owns big
component state, and Filament renders admin panels on Livewire.

vapor-chamber's widget surface is **none** of those: it is Vue Vapor. The
`emitDOMEvent` bridge is the **interop primitive** that lets a Vapor widget
take part in any of those layers without coupling to them. The same pattern
works for anything that reads DOM events: Stimulus (Rails), HTMX (event
listeners), Solid islands, vanilla.

---

## Filament panel coexistence (mounting / lifecycle)

The event-bridging patterns above cover how widgets *talk* to Filament. This
section covers how to *mount* them inside a panel.

Filament uses Livewire for its components. Vue Vapor + vapor-chamber lives
inside a Filament panel as **reactive islands**, each with its own bus.

```php
// app/Filament/Widgets/AnalyticsWidget.php
class AnalyticsWidget extends Widget
{
    protected string $view = 'filament.widgets.analytics-island'; // Filament 4+: an instance property

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
presence channels, and routes each broadcast to the bus. It also emits presence
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
realtime.dispose();
```

To react with a *command* instead of an event, pass `onBroadcast: ({ payload }, b)
=> b.dispatch('applyShipment', payload)`. Realtime is receive-only. Outbound
writes still go through the HTTP bridge, with CSRF and the `Idempotency-Key`
header above.

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
            'items'   => $payload['items'] ?? [],   // input rides in the payload
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

On the client, pair it with the lib's `optimistic` plugin, which applies the UI
change at once and rolls back on failure. Or push the final state through
Reverb.

To follow the job instead, answer **202 Accepted** (RFC 9110 15.3.3):

- The action returns exactly
  `['accepted' => ['location' => $url, 'retryAfter' => 2]]`.
- The example controller answers 202 with `Location` and `Retry-After`.
- The status monitor at that URL answers 202 while the job runs, then
  `{ state }` or a problem.

On the client, `pollWith` follows it. The dispatch resolves at once, and the end
arrives as `<action>$done`:

```ts
import { pollWith } from 'vapor-chamber';

bus.use(pollWith({ bus, actions: ['orderProcess'] }));
bus.on('orderProcess$done', (e) => {
  const { result } = e.target;   // { ok, value } or { ok: false, error }
});
```

```php
// routes/api.php - the status monitor
Route::get('/jobs/{order}', fn (Order $order) => $order->status === 'queued'
    ? response()->json((object) [], 202, ['Retry-After' => '2'])
    : response()->json(['state' => $order->only(['id', 'status'])]));
```

A batch result has no status of its own, so `accepted` works on the single
endpoint. Cross-origin, list `Location` and `Retry-After` in `exposed_headers`
(CORS, above). The browser hides any other response header from JS.

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

The controller's `AuthorizationException` catch maps it to a 403 problem,
`code: 'forbidden'`, which the client reads as `remote:refused:forbidden`.

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

The controller's `ValidationException` catch maps it to a 422 problem,
`code: 'validation_failed'`, with the validator's message as `detail`. Each
field's first message goes in `errors` as
`{ pointer: '/payload/<field>', detail }`, which is what `FormBus.setErrors`
puts on its fields.

---

## Idempotency & double-submit protection

The classic "user clicks Checkout twice" race has two halves, and vapor-chamber
covers the client side of both:

- **Locally**: the `idempotent` plugin collapses duplicate dispatches of the
  same logical command, so the handler (and the request it makes) runs once.
  Concurrent duplicates share the first in-flight promise. Repeats within the
  TTL return the cached result. Failures aren't cached, so a genuine retry
  still runs.
- **On the wire**: `idempotent` stamps `cmd.meta.idempotencyKey`. So does the
  bus, for an action declared `'idempotent'` in its `retry` option: the
  dispatch's id, one key for every attempt.
  - Every bridge sends it in the envelope, `meta.idempotencyKey`, on a single
    request, a batch and a WebSocket alike. That is where the backend reads it
    (the example controller's `idempotencyKey()`).
  - A single request also carries the standard `Idempotency-Key` header, for
    gateways and middleware that read it. It is a Structured Field String: the
    key percent-encoded and quoted.
  - The backend replays the stored result for a key it has finished. A second
    request while the first with the same key is still running gets **409**
    with `Retry-After: 1`. So a re-send lands once, and the bus waits and comes
    back for the finished answer instead of settling as a conflict.
  - A 409 without `Retry-After` is `conflict` and is not re-sent.

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

Some commands must also never *interleave*, such as two writes to the same
account. Add `serialize({ key: (cmd) => cmd.target.accountId })`: it orders
same-key commands locally while `idempotent` collapses identical ones. `key` is
a function of the command and defaults to `cmd.action`, which serializes each
action against itself. Together they give exactly-once semantics on the client.

The only backend contract has two parts. Honor `meta.idempotencyKey`: persist
the key with its result, and return the stored result on a repeat. And never
run the same key twice at once.

A cache alone cannot guarantee the second part. It stores the result only after
the action succeeds. A retry can arrive while the first attempt is still
running, after a client timeout on a slow write. It would miss the cache and run
the action again, concurrently. The example controller therefore takes a lock
on the key before the cache read and holds it for the whole run. From
`dispatchOne()` in
[`examples/laravel-backend/VaporChamberController.php`](../../examples/laravel-backend/VaporChamberController.php),
abridged:

```php
        $cacheKey = $idempotencyKey ? "vc:idem:{$command}:{$idempotencyKey}" : null;

        // The cache alone does not make a key land once: nothing is stored
        // until the action SUCCEEDS, so a retry arriving while the first
        // attempt is still running (a client timeout on a slow write) misses
        // the cache and runs the action a second time, concurrently. The lock
        // is taken BEFORE the cache read and held for the whole run; a request
        // that cannot get it is answered 409 with Retry-After (see __invoke), so
        // the client's re-send returns for the one outcome. 30s bounds a crashed
        // holder.
        $lock = $cacheKey ? Cache::lock("vc:idem:lock:{$command}:{$idempotencyKey}", 30) : null;
        if ($lock && !$lock->get()) {
            return $this->problem('A request with this Idempotency-Key is still running', 409, 'in_progress');
        }

        try {
            if ($cacheKey && ($cached = Cache::get($cacheKey)) !== null) {
                return $cached;
            }

            $state = app($handler)($target, $payload, $user);
            // ... the 202 `accepted` shape, else:
            $result = ['body' => $this->body($state), 'status' => 200];
            if ($cacheKey) {
                Cache::put($cacheKey, $result, self::IDEMPOTENCY_TTL_SECONDS);
            }
            return $result;
        } catch (ValidationException $e) {
            // ... exception mapping, unchanged
        } finally {
            $lock?->release();
        }
```

`__invoke()` adds `Retry-After: 1` to an `in_progress` problem. `Cache::lock`
needs a cache store that supports atomic locks (redis, memcached, database,
dynamodb, file, array). The batch endpoint runs every command through the same
`dispatchOne()`, so it gets the same guard.

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

The server log should show one `POST /api/vc` answered `{ "state": { ... } }`.
The browser console should show the command's result,
`{ ok: true, value: { count: 2, total: ... } }`.

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
