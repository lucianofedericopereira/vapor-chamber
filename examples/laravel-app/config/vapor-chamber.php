<?php
/**
 * vapor-chamber — demo command registry.
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
];
