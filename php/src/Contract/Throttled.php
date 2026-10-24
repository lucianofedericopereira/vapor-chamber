<?php

namespace VaporChamber\Contract;

use Illuminate\Routing\Attributes\Controllers\Middleware;

/**
 * `vcContractThrottled`: answers `{ ok: true }` inside the middleware it
 * declares, the named limiter `vc-contract` (one request a minute,
 * ContractServiceProvider). The controller runs an action's declared
 * middleware as a route runs a controller's: with the limit spent, the
 * answer is 429 with `Retry-After`.
 */
#[Middleware('throttle:vc-contract')]
class Throttled
{
    public function __invoke(mixed $target, mixed $payload, mixed $user): array
    {
        return ['ok' => true];
    }
}
