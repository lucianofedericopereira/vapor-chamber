<?php
/**
 * vapor-chamber — Laravel controller companion.
 *
 * Drop into app/Http/Controllers/. Adapt the namespace to your project.
 *
 * The controller is intentionally thin — it dispatches to action classes
 * registered in config/vapor-chamber.php and converts framework exceptions
 * into the lib's response shape ({ ok, state | error }).
 *
 * Wire it up:
 *   // routes/web.php  (cookie-CSRF case)
 *   Route::post('/api/vc', VaporChamberController::class)->middleware(['web']);
 *
 *   // OR routes/api.php  (Sanctum SPA case)
 *   Route::post('/api/vc', VaporChamberController::class)->middleware(['auth:sanctum']);
 *
 * See docs/integrations/laravel.md for the full integration guide.
 */

namespace App\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Validation\ValidationException;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;

class VaporChamberController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        $command = (string) $request->input('command', '');
        $target  = $request->input('target');
        $payload = $request->input('payload');

        if ($command === '') {
            return $this->fail('Missing "command" field', 400);
        }

        $handler = config('vapor-chamber.handlers')[$command] ?? null;
        if (!$handler) {
            return $this->fail("Unknown command: {$command}", 404);
        }

        try {
            $state = app($handler)($target, $payload, $request->user());
            return response()->json(['ok' => true, 'state' => $state]);
        } catch (ValidationException $e) {
            return $this->fail($e->getMessage(), 422);
        } catch (AuthorizationException $e) {
            return $this->fail($e->getMessage(), 403);
        } catch (ModelNotFoundException $e) {
            return $this->fail('Resource not found', 404);
        } catch (\Throwable $e) {
            report($e);
            return $this->fail('Internal error', 500);
        }
    }

    private function fail(string $message, int $status): JsonResponse
    {
        return response()->json(['ok' => false, 'error' => $message], $status);
    }
}
