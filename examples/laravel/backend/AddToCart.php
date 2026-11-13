<?php
/**
 * vapor-chamber - example action class.
 *
 * Drop into app/Actions/Cart/. One class per command keeps the controller
 * thin, makes commands testable in isolation, and gives validation /
 * authorization a natural home.
 *
 * Action classes have a single `__invoke($target, $payload, $user)` shape:
 *   $target  - first argument from `bus.dispatch(action, target, payload)`
 *   $payload - second (optional) argument
 *   $user    - Request::user(), or null for guests
 *
 * Return value becomes the client's `result.value`.
 *
 * Register in config/vapor-chamber.php:
 *   'cartAdd' => \App\Actions\Cart\AddToCart::class,
 */

namespace App\Actions\Cart;

use App\Models\Cart;
use App\Models\Product;
use App\Models\User;
use Illuminate\Routing\Attributes\Controllers\Middleware;

/**
 * Rate limited per user (or address) by the named limiter `cart`, which the
 * app defines in AppServiceProvider::boot():
 *
 *   RateLimiter::for('cart', fn (Request $request) =>
 *       Limit::perMinute(30)->by($request->user()?->id ?: $request->ip()));
 *
 * The controller runs an action's declared middleware as a route runs a
 * controller's. A spent limit answers 429 with `Retry-After`.
 */
#[Middleware('throttle:cart')]
class AddToCart
{
    /**
     * The reads this command makes stale (RFC 9875): the controller answers
     * `Cache-Group-Invalidation: "cart"`, and a client sharing one client with
     * its router refreshes the cart on screen (routes-web.php, the cart read).
     */
    public const CACHE_GROUP_INVALIDATION = ['cart'];

    public function __invoke(?array $target, ?array $payload, ?User $user): array
    {
        // The TARGET is identity: a product that does not exist is a missing
        // resource (findOrFail -> 404 not_found), not a form-field error.
        $product = Product::findOrFail((int) ($target['id'] ?? 0));

        // The PAYLOAD is the input: its field errors reach the client as
        // `/payload/<field>` pointers. Use a FormRequest if rules grow.
        $input = validator($payload ?? [], [
            'qty' => 'sometimes|integer|min:1|max:99',
        ])->validate();
        $qty = (int) ($input['qty'] ?? 1);

        // Guest carts use a session-backed model; authenticated users get the
        // persisted user cart. Adapt to your data model.
        $cart = $user ? $user->cart() : Cart::session();
        $cart->add($product->id, $qty);

        // Return shape your client UI consumes.
        return [
            'count' => $cart->count,
            'total' => $cart->total,
            'lastAddedId' => $product->id,
        ];
    }
}
