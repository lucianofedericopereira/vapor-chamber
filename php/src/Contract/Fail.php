<?php

namespace VaporChamber\Contract;

/** `vcContractFail`: payload `{ status, code, retryAfter?, type?, title? }`, answered as that problem. */
class Fail
{
    public function __invoke(mixed $target, mixed $payload, mixed $user): mixed
    {
        throw new CommandFailed(
            (string) $payload['code'],
            (int) $payload['status'],
            isset($payload['retryAfter']) ? (int) $payload['retryAfter'] : null,
            isset($payload['type']) ? (string) $payload['type'] : null,
            isset($payload['title']) ? (string) $payload['title'] : null,
        );
    }
}
