<?php

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;

// The contract's development routes, under api/vc/contract in the web group
// (VaporChamber\Contract\ContractServiceProvider).

// The monitor: a job still running, and a job done (an `Accepted`'s `done` reads both).
Route::get('/jobs/running', fn () => response()->json((object) [], 202, ['Retry-After' => '2']));
Route::get('/jobs/done', fn () => response()->json(['state' => ['n' => 1]]));

/**
 * The state route `pact-verifier` posts `{ state, params, action }` to,
 * before (`setup`) and after (`teardown`) each interaction. An interaction
 * with no state posts the empty name, which needs nothing.
 *
 * It asks the app's controller for the key's scope, slot, storage and lock,
 * so a state lands where the controller reads it. The app names its
 * controller in `vapor-chamber.controller`.
 *
 * Every state it cannot set answers 400 with the reason. pact-verifier
 * retries a 5xx, 408 or 429 state post 8 times with doubling waits
 * (pact_verifier v1.3.5), so a 500 here would stall a run for minutes.
 */
Route::post('/state', function (Request $request): JsonResponse {
    $state = (string) $request->input('state');
    if ($state === '') {
        return response()->json((object) []);
    }
    if ($state === 'limit spent') {
        // `vc-contract` keys by md5(name . key) (ThrottleRequests, named limiter).
        $key = md5('vc-contract'.'contract');
        $request->input('action') !== 'teardown' ? RateLimiter::hit($key, 60) : RateLimiter::clear($key);

        return response()->json((object) []);
    }
    try {
        $controller = config('vapor-chamber.controller', \App\Http\Controllers\VaporChamberController::class);
        $params = (array) $request->input('params', []);
        $slot = $controller::slot($controller::idempotencyScope($request, $request->user()), $params['command'], $params['key']);
        $setup = $request->input('action') !== 'teardown';
        if ($state === 'key answered') {
            $setup
                ? $controller::remember($slot, ['body' => ['state' => $params['answer']], 'status' => 200], $controller::fingerprint($params['target'] ?? null, $params['payload'] ?? null))
                : Cache::forget($controller::cacheKey($slot));

            return response()->json((object) []);
        }
        if ($state === 'key in progress') {
            if (! $setup) {
                // The lock was taken by an earlier request: only a forced release frees it.
                $controller::lock($slot)->forceRelease();
            } elseif (! $controller::lock($slot)->get()) {
                return response()->json(['error' => 'state not set: the key is already locked'], 400);
            }

            return response()->json((object) []);
        }

        return response()->json(['error' => "state not set: unknown state \"{$state}\""], 400);
    } catch (\Throwable $e) {
        return response()->json(['error' => 'state not set: '.$e->getMessage()], 400);
    }
});
