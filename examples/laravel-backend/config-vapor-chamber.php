<?php
/**
 * vapor-chamber — example config file.
 *
 * Save as config/vapor-chamber.php in your Laravel project.
 *
 * Maps every command name (the first arg of `bus.dispatch(...)` on the
 * client) to the action class that handles it. The controller resolves the
 * class from the container, so constructor-injected dependencies work as
 * normal.
 *
 * Naming convention: camelCase commands match the lib's default; switch to
 * dot.notation or snake_case if you set a `naming` option on the bus.
 */

return [
    /*
    |--------------------------------------------------------------------------
    | Command handler registry
    |--------------------------------------------------------------------------
    |
    | Each entry maps a command name to a fully-qualified action class.
    | Action classes implement a single __invoke($target, $payload, $user)
    | method and return any JSON-serializable shape (the client receives it
    | as `result.value`).
    |
    */
    'handlers' => [
        // Cart
        'cartAdd'    => \App\Actions\Cart\AddToCart::class,
        'cartRemove' => \App\Actions\Cart\RemoveFromCart::class,
        'cartClear'  => \App\Actions\Cart\ClearCart::class,

        // Orders
        'orderCreate' => \App\Actions\Order\CreateOrder::class,
        'orderCancel' => \App\Actions\Order\CancelOrder::class,

        // Profile
        'profileUpdate' => \App\Actions\Profile\UpdateProfile::class,

        // Add your commands here.
    ],

    /*
    |--------------------------------------------------------------------------
    | Optional: per-command rate limits
    |--------------------------------------------------------------------------
    |
    | If your VaporChamberController consults this map (you'll need to wire
    | it in the controller — not done by default), each command can declare
    | per-user rate limits. Useful for high-frequency commands (search,
    | telemetry) where you don't want one client to overwhelm the bus.
    |
    */
    'rate_limits' => [
        // 'searchExecute' => ['max' => 30, 'per_seconds' => 60],
    ],
];
