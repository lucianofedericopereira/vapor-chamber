<?php
/**
 * vapor-chamber - runnable demo action (session cart, zero migrations).
 *
 * Unlike the drop-in companions in ../laravel-backend (which assume your
 * own Cart/Product models), this action is fully self-contained: a static
 * catalog + the session. It runs on a fresh `laravel new` skeleton.
 *
 * Registered in config/vapor-chamber.php as:
 *   'cartAdd' => \App\Actions\Cart\AddToCart::class,
 */

namespace App\Actions\Cart;

use Illuminate\Database\Eloquent\ModelNotFoundException;

class AddToCart
{
    /** Demo catalog - id => [name, price in cents]. */
    public const CATALOG = [
        1 => ['name' => 'Coffee',   'cents' => 400],
        2 => ['name' => 'Tea',      'cents' => 300],
        3 => ['name' => 'Espresso', 'cents' => 500],
    ];

    public function __invoke(?array $target, ?array $payload, $user): array
    {
        // A field error is the payload's (`/payload/qty`); an item that does
        // not exist is a missing target, answered 404 `not_found`.
        validator($payload ?? [], [
            'qty' => ['sometimes', 'integer', 'min:1', 'max:99'],
        ])->validate();

        $item = self::CATALOG[(int) ($target['id'] ?? 0)] ?? throw new ModelNotFoundException();
        $qty  = (int) ($payload['qty'] ?? 1);

        $cart = session('vc.cart', ['count' => 0, 'cents' => 0, 'last' => '']);
        $cart['count'] += $qty;
        $cart['cents'] += $item['cents'] * $qty;
        $cart['last']   = $item['name'];
        session(['vc.cart' => $cart]);

        // Return shape becomes the client's `result.value`.
        return [
            'count' => $cart['count'],
            'total' => $cart['cents'] / 100,
            'lastAdded' => $cart['last'],
        ];
    }
}
