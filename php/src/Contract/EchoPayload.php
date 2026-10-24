<?php

namespace VaporChamber\Contract;

/**
 * `vcContractEcho`: answers its payload. The controller sends a payload of
 * exactly `{ redirect }`, `{ state, stores }` or `{ stores }` as that answer,
 * and any other as `{ state: <payload> }`.
 */
class EchoPayload
{
    public function __invoke(mixed $target, mixed $payload, mixed $user): mixed
    {
        return $payload;
    }
}
