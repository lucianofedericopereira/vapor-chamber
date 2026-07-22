<?php
/**
 * vapor-chamber — Laravel controller companion.
 *
 * Drop into app/Http/Controllers/. Adapt the namespace to your project.
 *
 * The controller is intentionally thin — it dispatches to action classes
 * registered in config/vapor-chamber.php and converts exceptions into the
 * lib's response shape ({ ok, state | error, code? }). Laravel's own
 * ValidationException/AuthorizationException/ModelNotFoundException are
 * recognized by type; anything else that declares its own render() (any
 * RFC 9457-shaped exception from a package or the host app) has its
 * status/detail read from there instead of collapsing onto a generic
 * 500 — the controller never needs to know a package-specific exception
 * type exists.
 *
 * Wire it up:
 *   // routes/web.php  (cookie-CSRF case)
 *   Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
 *   Route::post('/api/vc/batch', [VaporChamberController::class, 'batch'])->middleware(['web']);
 *
 *   // OR routes/api.php  (Sanctum SPA case) — api.php routes are auto-prefixed
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
            $request->header('Idempotency-Key'),
            $request->user(),
        );

        return response()->json($result['body'], $result['status']);
    }

    /**
     * Batch endpoint for `createBatchingHttpBridge` — the JS side coalesces
     * every command dispatched in one microtask into a single POST here:
     *
     *   { commands: [{ id, command, target, payload, idempotencyKey? }, ...] }
     *
     * Each command runs through the exact same dispatch path as __invoke()
     * (same handler resolution, same idempotency replay, same exception
     * mapping) — only the request/response envelope differs. One command's
     * failure never aborts its siblings; each result is reported by `id`.
     *
     *   { results: [{ id, ok, state?, error?, code? }, ...] }
     */
    public function batch(Request $request): JsonResponse
    {
        $commands = $request->input('commands', []);
        if (!is_array($commands)) {
            return response()->json(['ok' => false, 'error' => 'Missing "commands" array'], 400);
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
            $results[] = ['id' => $id, ...$result['body']];
        }

        return response()->json(['results' => $results]);
    }

    /**
     * The single-command dispatch path, shared by __invoke() and batch() so
     * a batched command behaves identically to a solo one: same handler
     * resolution, same Idempotency-Key replay/caching, same exception →
     * response-shape mapping.
     *
     * @return array{body: array<string, mixed>, status: int}
     */
    private function dispatchOne(Request $request, string $command, mixed $target, mixed $payload, ?string $idempotencyKey, mixed $user): array
    {
        if ($command === '') {
            return $this->fail('Missing "command" field', 400, 'missing_command');
        }

        $handler = config('vapor-chamber.handlers')[$command] ?? null;
        if (!$handler) {
            return $this->fail("Unknown command: {$command}", 404, 'unknown_command');
        }

        // Wire half of exactly-once: the JS `idempotent()` plugin (and the
        // batching bridge, per queued command) stamps an Idempotency-Key.
        // Replay the cached response for a key we've already processed so a
        // network retry can't double-write (e.g. duplicate orders).
        $cacheKey = $idempotencyKey ? "vc:idem:{$command}:{$idempotencyKey}" : null;
        if ($cacheKey && ($cached = Cache::get($cacheKey)) !== null) {
            return ['body' => $cached, 'status' => 200];
        }

        try {
            $state = app($handler)($target, $payload, $user);
            $body = ['ok' => true, 'state' => $state];
            if ($cacheKey) {
                Cache::put($cacheKey, $body, self::IDEMPOTENCY_TTL_SECONDS);
            }
            return ['body' => $body, 'status' => 200];
        } catch (ValidationException $e) {
            return $this->fail($e->getMessage(), 422, 'validation_failed');
        } catch (AuthorizationException $e) {
            return $this->fail($e->getMessage(), 403, 'forbidden');
        } catch (ModelNotFoundException $e) {
            return $this->fail('Resource not found', 404, 'not_found');
        } catch (\Throwable $e) {
            // Any exception that declares its own render() (a package's own
            // domain exception, or the host app's) gets its status/detail
            // read from there instead
            // of collapsing onto a generic 500 — the controller stays
            // ignorant of specific exception types by design, the same way
            // Laravel's own handler would dispatch to render() if this
            // exception weren't already caught here first.
            if (method_exists($e, 'render')) {
                $rendered = $e->render($request);
                if ($rendered instanceof JsonResponse) {
                    $data = $rendered->getData(true);
                    $code = is_string($data['type'] ?? null) ? basename($data['type']) : null;
                    return $this->fail($data['detail'] ?? $e->getMessage(), $rendered->getStatusCode(), $code);
                }
            }

            report($e);
            return $this->fail('Internal error', 500, 'internal_error');
        }
    }

    /**
     * Failure shape: `error` becomes `result.error.message` on the JS side;
     * `code` is exposed as the machine-readable `HttpError.code`. For
     * __invoke() this is sent with the given HTTP status; for batch() every
     * result rides in a 200 response body (status is per-command, not
     * per-HTTP-response) so one command's failure can't fail its siblings.
     *
     * @return array{body: array<string, mixed>, status: int}
     */
    private function fail(string $message, int $status, ?string $code = null): array
    {
        $body = ['ok' => false, 'error' => $message];
        if ($code !== null) {
            $body['code'] = $code;
        }
        return ['body' => $body, 'status' => $status];
    }
}
