<?php
/**
 * vapor-chamber — Laravel controller companion.
 *
 * Drop into app/Http/Controllers/. Adapt the namespace to your project.
 *
 * The controller is intentionally thin — it dispatches to action classes
 * registered in config/vapor-chamber.php and converts framework exceptions
 * into the lib's response shape ({ ok, state | error, code? }).
 *
 * Wire it up:
 *   // routes/web.php  (cookie-CSRF case)
 *   Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
 *
 *   // OR routes/api.php  (Sanctum SPA case) — api.php routes are auto-prefixed
 *   // with `api`, so use '/vc' (NOT '/api/vc', which would become /api/api/vc):
 *   Route::post('/vc', VaporChamberController::class)->middleware(['auth:sanctum']);
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
        $command = (string) $request->input('command', '');
        $target  = $request->input('target');
        $payload = $request->input('payload');

        if ($command === '') {
            return $this->fail('Missing "command" field', 400, 'missing_command');
        }

        $handler = config('vapor-chamber.handlers')[$command] ?? null;
        if (!$handler) {
            return $this->fail("Unknown command: {$command}", 404, 'unknown_command');
        }

        // Wire half of exactly-once: the JS `idempotent()` plugin stamps an
        // Idempotency-Key header on retried/replayed commands. Replay the
        // cached response for a key we've already processed so a network
        // retry can't double-write (e.g. duplicate orders).
        $idempotencyKey = $request->header('Idempotency-Key');
        $cacheKey = $idempotencyKey ? "vc:idem:{$command}:{$idempotencyKey}" : null;
        if ($cacheKey && ($cached = Cache::get($cacheKey)) !== null) {
            return response()->json($cached);
        }

        try {
            $state = app($handler)($target, $payload, $request->user());
            $body = ['ok' => true, 'state' => $state];
            if ($cacheKey) {
                Cache::put($cacheKey, $body, self::IDEMPOTENCY_TTL_SECONDS);
            }
            return response()->json($body);
        } catch (ValidationException $e) {
            return $this->fail($e->getMessage(), 422, 'validation_failed');
        } catch (AuthorizationException $e) {
            return $this->fail($e->getMessage(), 403, 'forbidden');
        } catch (ModelNotFoundException $e) {
            return $this->fail('Resource not found', 404, 'not_found');
        } catch (\Throwable $e) {
            report($e);
            return $this->fail('Internal error', 500, 'internal_error');
        }
    }

    /**
     * Failure shape: `error` becomes `result.error.message` on the JS side;
     * `code` is exposed as the machine-readable `HttpError.code`.
     */
    private function fail(string $message, int $status, ?string $code = null): JsonResponse
    {
        $body = ['ok' => false, 'error' => $message];
        if ($code !== null) {
            $body['code'] = $code;
        }
        return response()->json($body, $status);
    }
}
