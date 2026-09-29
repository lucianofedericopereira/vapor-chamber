<?php
/**
 * vapor-chamber - example action class with authorization.
 *
 * Demonstrates Gate-based authorization, ModelNotFoundException handling,
 * and a return shape that signals state transitions to the client.
 *
 * Register in config/vapor-chamber.php:
 *   'orderCancel' => \App\Actions\Order\CancelOrder::class,
 */

namespace App\Actions\Order;

use App\Models\Order;
use App\Models\User;
use Illuminate\Support\Facades\Gate;

class CancelOrder
{
    public function __invoke(?array $target, ?array $payload, ?User $user): array
    {
        // The target is identity: findOrFail throws ModelNotFoundException,
        // which the controller answers 404 not_found.
        $order = Order::findOrFail((int) ($target['id'] ?? 0));

        // Policy-based authorization. The 'cancel' ability lives in
        // App\Policies\OrderPolicy. Throws AuthorizationException -> 403.
        Gate::forUser($user)->authorize('cancel', $order);

        $order->cancel();

        return [
            'orderId' => $order->id,
            'status'  => $order->status,
            'cancelledAt' => $order->cancelled_at?->toIso8601String(),
        ];
    }
}
