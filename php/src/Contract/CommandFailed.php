<?php

namespace VaporChamber\Contract;

use Exception;
use Illuminate\Http\JsonResponse;

/**
 * A failure with its own problem code and status. render() gives
 * `{ code, detail }`, its own `type` and `title` when set, and `Retry-After`
 * when set, which the controller reads into the problem.
 */
class CommandFailed extends Exception
{
    public function __construct(public readonly string $problemCode, public readonly int $status, public readonly ?int $retryAfter = null, public readonly ?string $type = null, public readonly ?string $title = null)
    {
        parent::__construct($problemCode);
    }

    public function render(mixed $request): JsonResponse
    {
        return response()->json(
            array_filter(['type' => $this->type, 'title' => $this->title, 'code' => $this->problemCode, 'detail' => "{$this->problemCode} happened"], static fn (?string $v): bool => $v !== null),
            $this->status,
            $this->retryAfter === null ? [] : ['Retry-After' => (string) $this->retryAfter],
        );
    }
}
