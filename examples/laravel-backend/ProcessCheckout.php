<?php
/**
 * vapor-chamber - example queued-command action.
 *
 * For commands that take more than a few hundred ms, dispatch a queued job
 * and return optimistic state. The client gets an immediate response with
 * `status: 'queued'` and receives a Reverb push when the job completes. To
 * follow the job instead, return `['accepted' => [...]]` (a 202 the client's
 * `pollWith` follows): docs/integrations/laravel.md, "Queued commands".
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

        // Long-running work happens in the background. The HTTP response
        // returns immediately; the client sees `status: 'queued'`.
        ProcessOrderJob::dispatch($order);

        return [
            'orderId' => $order->id,
            'status'  => 'queued',
        ];
    }
}
