<?php
/**
 * vapor-chamber - example queued-command action.
 *
 * For commands that take more than a few hundred ms, dispatch a queued job
 * and answer 202 Accepted (RFC 9110 15.3.3): the controller sends `Location`,
 * the job's status monitor, and `Retry-After`. The client's dispatch resolves
 * at once with an `Accepted`, whose `done` polls the monitor to the job's end.
 * The monitor route: docs/integrations/laravel.md, "Queued commands".
 *
 * Register in config/vapor-chamber.php:
 *   'checkoutProcess' => \App\Actions\Order\ProcessCheckout::class,
 */

namespace App\Actions\Order;

use App\Jobs\ProcessOrderJob;
use App\Models\Order;
use App\Models\User;

class ProcessCheckout
{
    public function __invoke(?array $target, ?array $payload, ?User $user): array
    {
        // The checkout form is the PAYLOAD: its field errors reach the client
        // as `/payload/items/0/qty`-style pointers FormBus maps to fields.
        // Dispatched as `dispatch('checkoutProcess', {}, { items, shippingMethod })`.
        $input = validator($payload ?? [], [
            'items'           => 'required|array|min:1',
            'items.*.id'      => 'required|integer',
            'items.*.qty'     => 'required|integer|min:1',
            'shippingMethod'  => 'required|string',
        ])->validate();

        $order = Order::create([
            'user_id'         => $user?->id,
            'items'           => $input['items'],
            'shipping_method' => $input['shippingMethod'],
            'status'          => 'queued',
        ]);

        // Long-running work happens in the background. The answer is the 202:
        // the monitor answers 202 while the job runs, then `{ state }`.
        ProcessOrderJob::dispatch($order);

        return ['accepted' => ['location' => url("/jobs/{$order->id}"), 'retryAfter' => 2]];
    }
}
