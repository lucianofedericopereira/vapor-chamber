<?php
/**
 * vapor-chamber — example queued-command action.
 *
 * For commands that take more than a few hundred ms, dispatch a queued job
 * and return optimistic state. The client gets an immediate response with
 * `status: 'queued'` and can poll a separate command (e.g.
 * `orderStatusCheck`) or receive a Reverb push when the job completes.
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
        validator($target ?? [], [
            'items'           => 'required|array|min:1',
            'items.*.id'      => 'required|integer',
            'items.*.qty'     => 'required|integer|min:1',
            'shippingMethod'  => 'required|string',
        ])->validate();

        $order = Order::create([
            'user_id'         => $user?->id,
            'items'           => $target['items'],
            'shipping_method' => $target['shippingMethod'],
            'status'          => 'queued',
        ]);

        // Long-running work happens in the background. The HTTP response
        // returns immediately; the client sees `status: 'queued'`.
        ProcessOrderJob::dispatch($order);

        return [
            'orderId' => $order->id,
            'status'  => 'queued',
            // Optional: hint at how the client should track progress.
            'pollWith' => [
                'command' => 'orderStatusCheck',
                'target'  => ['id' => $order->id],
            ],
        ];
    }
}
