<?php

namespace VaporChamber\Contract;

/** `vcContractAccepted`: payload `{ location, retryAfter }`, answered 202 with those headers. */
class Accepted
{
    public function __invoke(mixed $target, mixed $payload, mixed $user): mixed
    {
        return ['accepted' => ['location' => $payload['location'], 'retryAfter' => $payload['retryAfter']]];
    }
}
