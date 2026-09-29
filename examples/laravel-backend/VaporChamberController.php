<?php
/**
 * vapor-chamber - Laravel controller companion.
 *
 * Drop into app/Http/Controllers/. Adapt the namespace to your project.
 *
 * The controller is intentionally thin - it dispatches to action classes
 * registered in config/vapor-chamber.php and converts exceptions into an
 * RFC 9457 problem ({ status, code, detail, errors? }), answered as
 * `application/problem+json`. A success is { state } (or { redirect }). The
 * wire contract is docs/plan-failures-and-contract.md 4.4. Laravel's own
 * ValidationException/AuthorizationException/ModelNotFoundException are
 * recognized by type; anything else that declares its own render() (any
 * RFC 9457-shaped exception from a package or the host app) has its
 * status/detail read from there instead of collapsing onto a generic
 * 500 - the controller never needs to know a package-specific exception
 * type exists.
 *
 * Wire it up:
 *   // routes/web.php  (cookie-CSRF case)
 *   Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
 *   Route::post('/api/vc/batch', [VaporChamberController::class, 'batch'])->middleware(['web']);
 *
 *   // OR routes/api.php  (Sanctum SPA case) - api.php routes are auto-prefixed
 *   // with `api`, so use '/vc' (NOT '/api/vc', which would become /api/api/vc):
 *   Route::post('/vc', VaporChamberController::class)->middleware(['auth:sanctum']);
 *   Route::post('/vc/batch', [VaporChamberController::class, 'batch'])->middleware(['auth:sanctum']);
 *
 * See docs/integrations/laravel.md for the full integration guide.
 */

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Cache;
use Illuminate\Validation\ValidationException;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;

class VaporChamberController extends Controller
{
    /**
     * How long a processed Idempotency-Key replays its cached response.
     * Matches the JS `idempotent()` plugin's default ttl (60s).
     */
    private const IDEMPOTENCY_TTL_SECONDS = 60;

    public function __invoke(Request $request): JsonResponse
    {
        $result = $this->dispatchOne(
            $request,
            (string) $request->input('command', ''),
            $request->input('target'),
            $request->input('payload'),
            $this->idempotencyKey($request->header('Idempotency-Key')),
            $request->user(),
        );

        if ($result['status'] < 400) {
            return response()->json($result['body'], $result['status']);
        }
        $headers = ['Content-Type' => 'application/problem+json'];
        // A key still running: the client's re-send waits a second and comes
        // back for the finished answer (the cache below), instead of settling
        // as a conflict while the first attempt succeeds.
        if (($result['body']['code'] ?? null) === 'in_progress') {
            $headers['Retry-After'] = '1';
        }

        return response()->json($result['body'], $result['status'], $headers);
    }

    /**
     * Batch endpoint for `createBatchingHttpBridge` - the JS side coalesces
     * every command dispatched in one microtask into a single POST here:
     *
     *   { commands: [{ id, command, target, payload, idempotencyKey? }, ...] }
     *
     * Each command runs through the exact same dispatch path as __invoke()
     * (same handler resolution, same idempotency replay, same exception
     * mapping) - only the request/response envelope differs. One command's
     * failure never aborts its siblings; each result is reported by `id`.
     *
     *   { results: [{ id, state }, { id, redirect }, { id, problem }, ...] }
     *
     * A failed command's problem is the RESULT, not the response: the batch
     * answers 200 because the request succeeded, and RFC 9457 has no shape for
     * several failures in one response. The problem carries the command's own
     * `status`, which the client reads the failure's condition from.
     */
    public function batch(Request $request): JsonResponse
    {
        $commands = $request->input('commands', []);
        if (!is_array($commands)) {
            $result = $this->problem('Missing "commands" array', 400, 'missing_commands');
            return response()->json($result['body'], 400, ['Content-Type' => 'application/problem+json']);
        }

        $results = [];
        foreach ($commands as $entry) {
            $id = (string) ($entry['id'] ?? '');
            $result = $this->dispatchOne(
                $request,
                (string) ($entry['command'] ?? ''),
                $entry['target'] ?? null,
                $entry['payload'] ?? null,
                $entry['idempotencyKey'] ?? null,
                $request->user(),
            );
            $results[] = $result['status'] >= 400
                ? ['id' => $id, 'problem' => $result['body']]
                : ['id' => $id, ...$result['body']];
        }

        return response()->json(['results' => $results]);
    }

    /**
     * The single-command dispatch path, shared by __invoke() and batch() so
     * a batched command behaves identically to a solo one: same handler
     * resolution, same Idempotency-Key replay/caching, same exception ->
     * response-shape mapping.
     *
     * @return array{body: array<string, mixed>, status: int}
     */
    private function dispatchOne(Request $request, string $command, mixed $target, mixed $payload, ?string $idempotencyKey, mixed $user): array
    {
        if ($command === '') {
            return $this->problem('Missing "command" field', 400, 'missing_command');
        }

        $handler = config('vapor-chamber.handlers')[$command] ?? null;
        if (!$handler) {
            return $this->problem("Unknown command: {$command}", 404, 'unknown_command');
        }

        // Wire half of exactly-once: an action declared idempotent on the JS bus
        // (`retry: { actions: { cartSet: 'idempotent' } }`, one key for all its
        // attempts) or the `idempotent()` plugin stamps an Idempotency-Key; the
        // single bridge sends it as a header, the batching bridge per command.
        // Replay the cached response for a key we've already processed so a
        // network retry can't double-write (e.g. duplicate orders).
        $cacheKey = $idempotencyKey ? "vc:idem:{$command}:{$idempotencyKey}" : null;

        // The cache alone does not make a key land once: nothing is stored
        // until the action SUCCEEDS, so a retry arriving while the first
        // attempt is still running (a client timeout on a slow write) misses
        // the cache and runs the action a second time, concurrently. The lock
        // is taken BEFORE the cache read and held for the whole run; a request
        // that cannot get it is answered 409 with Retry-After (see __invoke), so
        // the client's re-send returns for the one outcome. 30s bounds a crashed
        // holder.
        $lock = $cacheKey ? Cache::lock("vc:idem:lock:{$command}:{$idempotencyKey}", 30) : null;
        if ($lock && !$lock->get()) {
            return $this->problem('A request with this Idempotency-Key is still running', 409, 'in_progress');
        }

        try {
            if ($cacheKey && ($cached = Cache::get($cacheKey)) !== null) {
                return ['body' => $cached, 'status' => 200];
            }

            $state = app($handler)($target, $payload, $user);
            // An action hands a navigation back by returning exactly
            // ['redirect' => url] (docs/integrations/laravel.md). Both bridges
            // read `redirect` at the top of the envelope - per result on a
            // batch - so it is lifted there; wrapped as `state` it would be a
            // success whose value is a URL. Only that exact shape is lifted: a
            // state that merely HAS a `redirect` key among others is data.
            $body = is_array($state) && array_keys($state) === ['redirect']
                ? ['redirect' => $state['redirect']]
                : ['state' => $state];
            if ($cacheKey) {
                Cache::put($cacheKey, $body, self::IDEMPOTENCY_TTL_SECONDS);
            }
            return ['body' => $body, 'status' => 200];
        } catch (ValidationException $e) {
            return $this->problem($e->getMessage(), 422, 'validation_failed', $this->pointers($e->errors()));
        } catch (AuthorizationException $e) {
            return $this->problem($e->getMessage(), 403, 'forbidden');
        } catch (ModelNotFoundException $e) {
            return $this->problem('Resource not found', 404, 'not_found');
        } catch (\Throwable $e) {
            // Any exception that declares its own render() (a package's own
            // domain exception, or the host app's) gets its status/detail
            // read from there instead
            // of collapsing onto a generic 500 - the controller stays
            // ignorant of specific exception types by design, the same way
            // Laravel's own handler would dispatch to render() if this
            // exception weren't already caught here first.
            if (method_exists($e, 'render')) {
                $rendered = $e->render($request);
                if ($rendered instanceof JsonResponse) {
                    $data = $rendered->getData(true);
                    // Its own `code` extension member; without one it has no
                    // identity to send, and none is made up from `type`.
                    $code = is_string($data['code'] ?? null) ? $data['code'] : 'error';
                    return $this->problem($data['detail'] ?? $e->getMessage(), $rendered->getStatusCode(), $code);
                }
            }

            report($e);
            return $this->problem('Internal error', 500, 'internal_error');
        } finally {
            $lock?->release();
        }
    }

    /**
     * The key from an Idempotency-Key header. The draft makes the value a
     * Structured Field String (RFC 9651); the bridge sends the key
     * percent-encoded and quoted, which needs no escaping, so unquoting and
     * `rawurldecode` give back the exact key - the same one the batching
     * bridge sends in the JSON body. A value that is not a String fails to
     * parse, and RFC 9651 ignores a field that fails to parse: no key.
     */
    private function idempotencyKey(?string $header): ?string
    {
        if ($header !== null && strlen($header) >= 2 && $header[0] === '"' && str_ends_with($header, '"')) {
            return rawurldecode(substr($header, 1, -1));
        }

        return null;
    }

    /**
     * The failure, as the contract's RFC 9457 problem: `status`, `code` (its
     * identity), `detail` (the sentence, `result.error.message` on the JS
     * side), `errors` when there are field errors. `type` and `title` are not
     * sent: `code` is the identity and `title` repeated the status.
     *
     * The client reads the failure's condition from `status`, by the status
     * table (`conditionOfStatus` in http-errors.ts): send the status that says
     * what the failure is - 409 for a state conflict, 429 or 503 for "come back
     * later", 422 for input that broke a rule. For __invoke() it is the
     * response, sent with that status; for batch() it is one result's
     * `problem`, inside a 200.
     *
     * @param list<array{pointer: string, detail: string}> $errors
     * @return array{body: array<string, mixed>, status: int}
     */
    private function problem(string $detail, int $status, string $code, array $errors = []): array
    {
        $body = ['status' => $status, 'code' => $code, 'detail' => $detail];
        if ($errors !== []) {
            $body['errors'] = $errors;
        }

        return ['body' => $body, 'status' => $status];
    }

    /**
     * Laravel's field map as the contract's `errors`: one `{ pointer, detail }`
     * per field, the pointer into the envelope the client sent
     * (`/payload/<field>`, RFC 6901; a dotted key is a nested path), the
     * field's first message.
     *
     * @param array<string, array<int, string>> $fields
     * @return list<array{pointer: string, detail: string}>
     */
    private function pointers(array $fields): array
    {
        $errors = [];
        foreach ($fields as $field => $messages) {
            $segments = array_map(
                static fn (string $s): string => str_replace(['~', '/'], ['~0', '~1'], $s),
                explode('.', (string) $field),
            );
            $errors[] = ['pointer' => '/payload/'.implode('/', $segments), 'detail' => (string) ($messages[0] ?? '')];
        }

        return $errors;
    }
}
