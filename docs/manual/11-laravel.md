# 11. Laravel

This chapter connects a Laravel backend in four steps. Every detail (Sanctum, CORS, Inertia,
Filament, Reverb, queued commands, idempotency, the contract check) is in
[integrations/laravel.md](../integrations/laravel.md). Runnable files are in
[`examples/laravel-backend/`](../../examples/laravel-backend), and a runnable app in
[`examples/laravel-app/`](../../examples/laravel-app).

## 1. Add one route

```php
// routes/web.php  (cookie-CSRF case - integrations/laravel.md, CSRF, has both flows)
use App\Http\Controllers\VaporChamberController;

Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
```

Every command comes to this one route. The action name is in the JSON body.

## 2. Copy the controller

Copy [`VaporChamberController.php`](../../examples/laravel-backend/VaporChamberController.php)
into `app/Http/Controllers/`. It resolves each command name to an action class, and answers a
failure as an RFC 9457 problem with the status that names its condition.

## 3. Write one action class per command

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

Register it in `config/vapor-chamber.php`:

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

## 4. Dispatch from the page

Put the CSRF meta tag in the layout, and connect:

```html
<meta name="csrf-token" content="{{ csrf_token() }}">
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber@<version>/dist/vapor-chamber-core.iife.min.js"></script>
<script>
  const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
  dispatch('cartAdd', { id: 1 }, { qty: 2 }).then(r => console.log(r));
</script>
```

The server log shows one `POST /api/vc` answered `{ "state": { ... } }`. The browser console
shows `{ ok: true, value: { count: 2, total: ... } }`. Every other command uses the same
plumbing: an action class and a line in the config.

## Check your backend against the contract

The wire contract's cases ship as Pact files. With `pact-verifier` installed and the app
served, run from vapor-chamber's package folder:

```bash
node scripts/verify-contract.mjs --base http://127.0.0.1:8000
```

[integrations/laravel.md](../integrations/laravel.md), "Check your backend", sets it up.

Next: [12. Sizes and tuning](./12-sizes-and-tuning.md).
