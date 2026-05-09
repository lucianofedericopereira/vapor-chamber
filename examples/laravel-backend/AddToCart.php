<?php
/**
 * vapor-chamber — example action class.
 *
 * Drop into app/Actions/Cart/. One class per command keeps the controller
 * thin, makes commands testable in isolation, and gives validation /
 * authorization a natural home.
 *
 * Action classes have a single `__invoke($target, $payload, $user)` shape:
 *   $target  — first argument from `bus.dispatch(action, target, payload)`
 *   $payload — second (optional) argument
 *   $user    — Request::user(), or null for guests
 *
 * Return value becomes the client's `result.value`.
 *
 * Register in config/vapor-chamber.php:
 *   'cartAdd' => \App\Actions\Cart\AddToCart::class,
 */

namespace App\Actions\Cart;

use App\Models\Cart;
use App\Models\User;

class AddToCart
{
    public function __invoke(?array $target, ?array $payload, ?User $user): array
    {
        // Inline validation. Use a FormRequest if rules grow beyond a few lines.
        validator($target ?? [], [
            'id' => 'required|integer|exists:products,id',
        ])->validate();

        $qty = max(1, (int) ($payload['qty'] ?? 1));

        // Guest carts use a session-backed model; authenticated users get the
        // persisted user cart. Adapt to your data model.
        $cart = $user ? $user->cart() : Cart::session();
        $cart->add($target['id'], $qty);

        // Return shape your client UI consumes.
        return [
            'count' => $cart->count,
            'total' => $cart->total,
            'lastAddedId' => $target['id'],
        ];
    }
}
