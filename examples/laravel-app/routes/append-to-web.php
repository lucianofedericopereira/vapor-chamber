<?php
// vapor-chamber demo routes — appended to routes/web.php by setup.sh.
// Fully-qualified on purpose: the skeleton's web.php already `use`s the
// Route facade, so an appended `use` line would be a PHP fatal.

// Server-rendered Blade page with the sprinkled bus. No Vue anywhere: the
// `core` IIFE plus plain DOM.
Illuminate\Support\Facades\Route::get('/cart', fn () => view('cart'));

// The other half of the story: a Vapor custom element whose events cross the
// shadow boundary into the host page (Alpine + plain DOM listeners). Needs Vue,
// which the page loads as a module because Vapor ships no global build.
Illuminate\Support\Facades\Route::get('/widget', fn () => view('widget'));

// ONE endpoint for every command — the action name travels in the JSON body.
// 'web' middleware = session + VerifyCsrfToken (the IIFE sends X-CSRF-TOKEN
// from the Blade meta tag).
Illuminate\Support\Facades\Route::post('/api/vc', App\Http\Controllers\VaporChamberController::class)
    ->middleware(['web'])
    ->name('api.vc');
