<?php
/**
 * vapor-chamber - example config file.
 *
 * Save as config/vapor-chamber.php in your Laravel project.
 *
 * Maps every command name (the first arg of `bus.dispatch(...)` on the
 * client) to the action class that handles it. The controller resolves the
 * class from the container, so constructor-injected dependencies work as
 * normal.
 *
 * Naming convention: camelCase commands match the names the lib composes
 * (`useCommandGroup('cart')` and a `cart` store both give `cartAdd`). The bus
 * enforces a convention only when given a `naming` option.
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
        'checkoutProcess' => \App\Actions\Order\ProcessCheckout::class,

        // Profile
        'profileUpdate' => \App\Actions\Profile\UpdateProfile::class,

        // Add your commands here.
    ],

    /*
    |--------------------------------------------------------------------------
    | Idempotency-Key replay window
    |--------------------------------------------------------------------------
    |
    | How long, in seconds, a finished Idempotency-Key replays its answer to
    | a re-send. Set it from how long your clients stay offline: the outbox
    | re-sends a record after a reload, any time later. A re-send after the
    | window runs the action again. Default 24 hours.
    |
    */
    'idempotency_ttl' => 86400,

    /*
    |--------------------------------------------------------------------------
    | Old pages
    |--------------------------------------------------------------------------
    |
    | The build this app serves. A page sends its own build as the
    | `X-App-Version` header (httpTransport `headers`), and a command from a
    | page that differs is answered `{ redirect }` to that page, so the reload
    | brings the new build. Leave it null to check nothing. The version is
    | yours: the library carries none.
    |
    | `reload_url` is where an old page goes when its `Referer` is not this
    | host's.
    |
    */
    'app_version' => env('APP_VERSION'),
    'reload_url' => '/',
];
