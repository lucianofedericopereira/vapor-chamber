<?php
/**
 * vapor-chamber - demo command registry.
 *
 * Maps every command name (the first arg of `bus.dispatch(...)` on the
 * client) to the action class that handles it. The controller resolves the
 * class from the container, so constructor injection works as normal.
 */

return [
    'handlers' => [
        'cartAdd'   => \App\Actions\Cart\AddToCart::class,
        'cartClear' => \App\Actions\Cart\ClearCart::class,
    ],
    // How long a finished Idempotency-Key replays its answer, in seconds.
    'idempotency_ttl' => 86400,
    // The build this app serves. The pages send theirs as X-App-Version, and a
    // command from a page that differs is answered { redirect } to that page.
    // Set APP_VERSION in .env to "deploy" a new build. Null checks nothing.
    'app_version' => env('APP_VERSION', '1'),
    'reload_url' => '/cart',
];
