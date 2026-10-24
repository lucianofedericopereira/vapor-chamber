<?php

namespace VaporChamber\Contract;

use Illuminate\Support\Facades\Validator;

/** `vcContractValidate`: needs a string `name` in its payload, validated as a hand-written action does. */
class Validate
{
    public function __invoke(mixed $target, mixed $payload, mixed $user): mixed
    {
        Validator::make(is_array($payload) ? $payload : [], ['name' => 'required|string'])->validate();

        return [];
    }
}
