<?php
/**
 * vapor-chamber - Laravel controller companion.
 *
 * Drop into app/Http/Controllers/. Adapt the namespace to your project.
 *
 * The controller is intentionally thin - it dispatches to action classes
 * registered in config/vapor-chamber.php and converts exceptions into an
 * RFC 9457 problem ({ type, title, status, detail, code }), answered as
 * `application/problem+json`. A success stays { ok: true, state }. Laravel's own
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
use Symfony\Component\HttpFoundation\Response;

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

        return $result['status'] >= 400
            ? response()->json($result['body'], $result['status'], ['Content-Type' => 'application/problem+json'])
            : response()->json($result['body'], $result['status']);
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
     *   { results: [{ id, ok: true, state }, { id, ok: false, problem }, ...] }
     *
     * A failed command's problem is the RESULT, not the response: the batch
     * answers 200 because the request succeeded, and RFC 9457 has no shape for
     * several failures in one response. `ok: false` rides beside `problem` for
     * clients older than v1.24.0, which read only `ok` and would otherwise take
     * the result for a success.
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
                ? ['id' => $id, 'ok' => false, 'problem' => $result['body']]
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

        // Wire half of exactly-once: the JS `idempotent()` plugin (and the
        // batching bridge, per queued command) stamps an Idempotency-Key.
        // Replay the cached response for a key we've already processed so a
        // network retry can't double-write (e.g. duplicate orders).
        $cacheKey = $idempotencyKey ? "vc:idem:{$command}:{$idempotencyKey}" : null;

        // The cache alone does not make a key land once: nothing is stored
        // until the action SUCCEEDS, so a retry arriving while the first
        // attempt is still running (a client timeout on a slow write) misses
        // the cache and runs the action a second time, concurrently. The lock
        // is taken BEFORE the cache read and held for the whole run; a request
        // that cannot get it is answered 409, a 4xx the bridge never retries,
        // so the client sees one outcome. 30s bounds a crashed holder.
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
            // batch - so it is lifted there. Wrapped as `state` it was a
            // success whose value happened to be a URL, and `onRedirect` never
            // fired. Only that exact shape is lifted: a state that merely HAS
            // a `redirect` key among others is data, not a navigation.
            $body = is_array($state) && array_keys($state) === ['redirect']
                ? ['redirect' => $state['redirect']]
                : ['ok' => true, 'state' => $state];
            if ($cacheKey) {
                Cache::put($cacheKey, $body, self::IDEMPOTENCY_TTL_SECONDS);
            }
            return ['body' => $body, 'status' => 200];
        } catch (ValidationException $e) {
            return $this->problem($e->getMessage(), 422, 'validation_failed');
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
                    // Its own `code` extension member when it has one; the
                    // last segment of `type` otherwise, which is this
                    // controller's convention, not the RFC's.
                    $code = is_string($data['code'] ?? null) ? $data['code']
                        : (is_string($data['type'] ?? null) ? basename($data['type']) : 'error');
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
     * Failure shape: an RFC 9457 problem. `detail` becomes `result.error.message`
     * on the JS side and `code` (an extension member) becomes `error.code`.
     *
     * For __invoke() it is the response, sent with the given status and
     * `application/problem+json`; the client throws an HttpError carrying both.
     * For batch() it is one result's `problem`, inside a 200 - one command's
     * failure can't fail its siblings, and nothing throws on that path.
     *
     * `type` is absolute, as RFC 9457 recommends: this app's `/problems/<code>`.
     * The URI does not have to resolve to a page. `title` is the status's reason
     * phrase; an app with a registry of its codes can send its own titles, or
     * leave `title` and `status` out entirely - every member is optional, and
     * the library reads only `detail` and `code`.
     *
     * One consequence worth knowing: a refusal delivered inside a batch's 200 is
     * treated as PERMANENT by `retry()`, because the request succeeded and you
     * refused in the body. Do not send one of the library's own retryable codes
     * there (`VC_CORE_THROTTLED` and five others) unless you mean the client to
     * try again - use your own namespace and the refusal stays permanent.
     *
     * @return array{body: array<string, mixed>, status: int}
     */
    private function problem(string $detail, int $status, string $code): array
    {
        return ['body' => [
            'type' => url("/problems/{$code}"),
            'title' => Response::$statusTexts[$status] ?? 'Error',
            'status' => $status,
            'detail' => $detail,
            'code' => $code,
        ], 'status' => $status];
    }
}
