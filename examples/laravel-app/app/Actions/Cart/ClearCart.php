<?php
/**
 * vapor-chamber — runnable demo action (session cart).
 *
 * Registered in config/vapor-chamber.php as:
 *   'cartClear' => \App\Actions\Cart\ClearCart::class,
 */

namespace App\Actions\Cart;

class ClearCart
{
    public function __invoke(?array $target, ?array $payload, $user): array
    {
        session()->forget('vc.cart');

        return ['count' => 0, 'total' => 0, 'lastAdded' => ''];
    }
}
