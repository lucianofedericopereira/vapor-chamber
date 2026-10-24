<?php

namespace VaporChamber\Contract;

use Illuminate\Foundation\Http\Middleware\ConvertEmptyStringsToNull;
use Illuminate\Foundation\Http\Middleware\TrimStrings;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;

/**
 * The wire contract's Laravel side (docs/contract.md 4), found by package
 * discovery.
 *
 * In every environment: command input under `api/vc` reaches the actions as
 * the client sent it. TrimStrings and ConvertEmptyStringsToNull skip it.
 *
 * In `local` and `testing` only: the contract's test commands and its
 * fixture action join `vapor-chamber.handlers`, the registry the controller
 * dispatches from. The monitor and the state route register in the `web`
 * group under `api/vc/contract`. `pact-verifier` checks the app's own
 * command routes against contract/*.pact.json with them.
 */
class ContractServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        $commandRoute = fn (Request $request): bool => $request->is('api/vc', 'api/vc/*');
        ConvertEmptyStringsToNull::skipWhen($commandRoute);
        TrimStrings::skipWhen($commandRoute);

        if (! $this->app->environment('local', 'testing')) {
            return;
        }
        // `+`: an app's own entry of the same name wins.
        config(['vapor-chamber.handlers' => (array) config('vapor-chamber.handlers', []) + [
            'vcContractEcho' => EchoPayload::class,
            'vcContractFail' => Fail::class,
            'vcContractValidate' => Validate::class,
            'vcContractAccepted' => Accepted::class,
            'vcContractGen' => Fixture\VcContractGen::class,
            'vcContractThrottled' => Throttled::class,
        ]]);
        // One request a minute, for the throttled case (php/routes/contract.php spends it).
        RateLimiter::for('vc-contract', fn (): Limit => Limit::perMinute(1)->by('contract'));
        if (! $this->app->routesAreCached()) {
            Route::middleware('web')->prefix('api/vc/contract')->group(__DIR__.'/../../routes/contract.php');
        }
    }
}
