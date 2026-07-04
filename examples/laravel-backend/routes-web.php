<?php
/**
 * vapor-chamber — example routes.
 *
 * Snippet for routes/web.php (cookie-CSRF case) or routes/api.php (Sanctum
 * SPA case). Pick one of the two flows below.
 *
 * The lib expects ONE endpoint that accepts every command. The action name
 * is in the JSON body, not the URL.
 */

use Illuminate\Support\Facades\Route;
use App\Http\Controllers\VaporChamberController;

// ─────────────────────────────────────────────────────────────────────────────
// Flow A — Web/Blade with cookie CSRF (sprinkled JS, server-rendered pages)
// ─────────────────────────────────────────────────────────────────────────────
//
// Use when:
//   - You serve Blade views and sprinkle Vue / vapor-chamber on top
//   - You're NOT using Sanctum
//   - The page already includes <meta name="csrf-token" content="{{ csrf_token() }}">
//
// Place this in routes/web.php so the 'web' middleware group applies
// (session, VerifyCsrfToken, etc.).
//
// Client tip: without Sanctum there is no /sanctum/csrf-cookie endpoint, so
// pass `csrfCookieUrl: ''` to createHttpBridge/postCommand — the default 419
// auto-refresh would otherwise re-read the (stale) meta tag and retry with
// the same expired token.

Route::post('/api/vc', VaporChamberController::class)
    ->middleware(['web'])
    ->name('api.vc');


// ─────────────────────────────────────────────────────────────────────────────
// Flow B — Sanctum SPA cookie auth (full SPA / Inertia)
// ─────────────────────────────────────────────────────────────────────────────
//
// Use when:
//   - You're running a SPA (e.g. Inertia, custom Vue/Vapor)
//   - You've installed laravel/sanctum and configured stateful domains
//   - Auth happens via the cookie session (not API tokens)
//
// Place this in routes/api.php — Sanctum's stateful guard hooks the cookie
// session. The lib auto-fetches /sanctum/csrf-cookie on 419 and retries.
//
// NOTE the path: routes/api.php routes are automatically prefixed with `api`,
// so '/vc' here resolves to '/api/vc' — writing '/api/vc' would resolve to
// '/api/api/vc' and 404 every dispatch. On Laravel 11+ also run
// `php artisan install:api` (creates routes/api.php) and enable
// `$middleware->statefulApi()` in bootstrap/app.php so Sanctum treats the SPA
// as stateful.

/*
Route::post('/vc', VaporChamberController::class)   // → /api/vc
    ->middleware(['auth:sanctum'])
    ->name('api.vc');
*/


// ─────────────────────────────────────────────────────────────────────────────
// Inertia coexistence
// ─────────────────────────────────────────────────────────────────────────────
//
// If your app uses Inertia, do NOT apply HandleInertiaRequests middleware to
// the vapor-chamber endpoint — you want plain JSON responses, not Inertia
// envelope responses.
//
// Inertia routes can stay in their own group with HandleInertiaRequests; the
// vapor-chamber route uses just 'web' (or 'auth:sanctum').
