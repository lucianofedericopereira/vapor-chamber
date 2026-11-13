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
 * wire contract is docs/contract.md 4. Laravel's own
 * ValidationException/AuthorizationException/AuthenticationException/
 * ModelNotFoundException and HTTP exceptions (`abort()`) are recognized by
 * type, with the status Laravel's own handler would answer; anything else
 * that declares its own render() (any
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
use Illuminate\Auth\AuthenticationException;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Contracts\Cache\Lock;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Pipeline\Pipeline;
use Illuminate\Routing\Attributes\Controllers\Middleware as MiddlewareAttribute;
use Illuminate\Routing\Controllers\HasMiddleware;
use Illuminate\Routing\Controllers\Middleware;
use Illuminate\Routing\Router;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

class VaporChamberController extends Controller
{
    /**
     * How long a finished Idempotency-Key replays its answer, in seconds:
     * `vapor-chamber.idempotency_ttl`, default 24 hours. It must cover how
     * long a client may re-send: the outbox keeps a record with no age
     * limit, across reloads. A re-send after the window runs the action
     * again. The backend holds the cache, so it sets the window
     * (Idempotency-Key draft-07 2.3).
     */
    public static function idempotencyTtl(): int
    {
        return (int) config('vapor-chamber.idempotency_ttl', 86400);
    }

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
            return response()->json($result['body'], $result['status'], $result['headers'] ?? []);
        }

        return response()->json($result['body'], $result['status'], ['Content-Type' => 'application/problem+json'] + ($result['headers'] ?? []));
    }

    /**
     * Batch endpoint for `httpTransport({ batch })` - the JS side coalesces
     * every command dispatched in one microtask into a single POST here:
     *
     *   { commands: [{ id, command, target, payload?, meta?, headers? }, ...] }
     *
     * Each command runs through the exact same dispatch path as __invoke()
     * (same handler resolution, same idempotency replay, same exception
     * mapping) - only the request/response envelope differs. One command's
     * failure never aborts its siblings; each result is reported by `id`. A
     * command's `headers` member stands for its own request headers (OData
     * JSON batch): its `Idempotency-Key` is read from there.
     *
     *   { results: [{ id, status, headers, state }, { id, status, headers, redirect }, { id, status, headers, problem }, ...] }
     *
     * A failed command's problem is the RESULT, not the response: the batch
     * answers 200 because the request succeeded, and RFC 9457 has no shape for
     * several failures in one response. Each result carries the status and
     * headers its command's own response would have had (OData JSON batch): a
     * 202's `Location`, an `in_progress` result's `Retry-After`. The problem
     * carries the same `status`.
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
                $this->idempotencyKey(self::itemHeader($entry['headers'] ?? null, 'Idempotency-Key')),
                $request->user(),
            );
            // `(object)`: no headers encode as `{}`, never as a JSON list.
            $item = ['id' => $id, 'status' => $result['status'], 'headers' => (object) ($result['headers'] ?? [])];
            $results[] = $result['status'] >= 400
                ? $item + ['problem' => $result['body']]
                : $item + (array) $result['body'];
        }

        return response()->json(['results' => $results]);
    }

    /**
     * The single-command dispatch path, shared by __invoke() and batch() so
     * a batched command behaves identically to a solo one: same handler
     * resolution, same Idempotency-Key replay/caching, same exception ->
     * response-shape mapping.
     *
     * `headers` are the command's own response headers: __invoke() sends them
     * on the response, batch() on the result.
     *
     * @return array{body: array<string, mixed>|object, status: int, headers?: array<string, string>}
     */
    private function dispatchOne(Request $request, string $command, mixed $target, mixed $payload, ?string $idempotencyKey, mixed $user): array
    {
        if (($stale = self::staleRedirect($request)) !== null) {
            return $stale;
        }

        if ($command === '') {
            return $this->problem('Missing "command" field', 400, 'missing_command');
        }

        $handler = config('vapor-chamber.handlers')[$command] ?? null;
        if (!$handler) {
            return $this->problem("Unknown command: {$command}", 404, 'unknown_command');
        }

        // Wire half of exactly-once: an action declared idempotent on the JS bus
        // (`retry: { actionPolicies: { cartSet: 'idempotent' } }`, one key for all its
        // attempts) or the `idempotent()` plugin stamps an Idempotency-Key;
        // every transport sends it: the header on a single request, that name
        // in a batched command's `headers` member.
        // Replay the cached response for a key we've already processed so a
        // network retry can't double-write (e.g. duplicate orders).
        //
        // This controller scopes a key per client, not across clients: an
        // app's own key (`idempotent({ key })`, the outbox's `key`) can be the
        // same for two users adding the same product. So the key is scoped to
        // who sent it - the user, else the session, else the address - or the
        // second user's write never runs and is answered the first user's
        // state. Hashed, so a key of any length fits the cache and lock
        // tables' 255-character key column (the `database` store, Laravel's
        // default) and an app's key is not stored as given.
        $slot = $idempotencyKey ? self::slot(self::idempotencyScope($request, $user), $command, $idempotencyKey) : null;

        // The cache alone does not make a key land once: nothing is stored
        // until the action FINISHES, so a retry arriving while the first
        // attempt is still running (a client timeout on a slow write) misses
        // the cache and runs the action a second time, concurrently. The lock
        // is taken BEFORE the cache read and held for the whole run; a request
        // that cannot get it is answered 409 with `Retry-After: 1`, so the
        // client's re-send comes back a second later for the one outcome. 30s
        // bounds a crashed holder.
        $lock = $slot ? self::lock($slot) : null;
        if ($lock && !$lock->get()) {
            return $this->problem('A request with this Idempotency-Key is still running', 409, 'in_progress') + ['headers' => ['Retry-After' => '1']];
        }

        // The request a key was first used for: a re-send with the same key
        // and another target or payload is another request, answered 422
        // (Idempotency-Key draft-07 2.7), never the first request's answer.
        $fingerprint = $slot ? self::fingerprint($target, $payload) : null;

        try {
            if ($slot && ($cached = Cache::get(self::cacheKey($slot))) !== null) {
                if (($cached['fingerprint'] ?? null) !== $fingerprint) {
                    return $this->problem('This Idempotency-Key was already used for another request', 422, 'key_reused');
                }
                unset($cached['fingerprint']);
                return $cached;
            }

            $result = $this->run($request, $handler, $target, $payload, $user);
            if ($slot && self::replays($result)) {
                self::remember($slot, $result, $fingerprint);
            }
            return $result;
        } finally {
            $lock?->release();
        }
    }

    /**
     * An old page answered with a redirect (docs/contract.md 4, "A tab open
     * across a deploy"). The page sends its own build, `X-App-Version`, and
     * this app compares it with `vapor-chamber.app_version`: a page that
     * differs is old, and its command is answered `{ redirect }` to the page
     * itself, so the reload brings the new build. The library carries no
     * version. With no `app_version` set, or a request that sends no header,
     * nothing is checked. Every command crosses this gate, so a stale page
     * takes no key, no lock and no cache entry, and runs no action.
     *
     * @return array{body: array<string, string>, status: int}|null
     */
    private static function staleRedirect(Request $request): ?array
    {
        $current = config('vapor-chamber.app_version');
        $page = $request->header('X-App-Version');
        if ($current === null || $page === null || (string) $current === $page) {
            return null;
        }

        return ['body' => ['redirect' => self::reloadUrl($request)], 'status' => 200];
    }

    /**
     * Where an old page reloads: the page that sent the command, as the path
     * and query of its `Referer` when that is this host. Any other `Referer`
     * (none, another host, a path that starts a second authority) is never
     * the destination: `vapor-chamber.reload_url` is.
     */
    private static function reloadUrl(Request $request): string
    {
        $parts = parse_url((string) $request->header('Referer'));
        if (is_array($parts) && ($parts['host'] ?? null) === $request->getHost()
            && preg_match('#^/(?![/\\\\])#', $parts['path'] ?? '') === 1) {
            return $parts['path'].(isset($parts['query']) ? '?'.$parts['query'] : '');
        }

        return (string) config('vapor-chamber.reload_url', '/');
    }

    /**
     * Whether a key replays this answer to a re-send: a success, or a verdict
     * (Idempotency-Key draft-07 2.6 replays "success or an error"). A verdict
     * is a 4xx the client never re-sends and the outbox drops
     * (docs/contract.md 4). Not stored, so a re-send runs the action again:
     * - 401 and 419, which the outbox keeps for after sign-in;
     * - 408 and 429, and every 5xx: transient, re-sent to reach a success;
     * - any answer that declares a wait (`Retry-After`): the client comes
     *   back after it, and a stored wait would answer every re-send.
     *
     * @param array{body: array<string, mixed>|object, status: int, headers?: array<string, string>} $result
     */
    private static function replays(array $result): bool
    {
        $status = $result['status'];
        if ($status < 400) {
            return true;
        }

        return $status < 500
            && !in_array($status, [401, 408, 419, 429], true)
            && !isset($result['headers']['Retry-After']);
    }

    /**
     * Run the command's action and map its outcome to the answer: the
     * success body, or the exception as an RFC 9457 problem.
     *
     * @return array{body: array<string, mixed>|object, status: int, headers?: array<string, string>}
     */
    private function run(Request $request, string $handler, mixed $target, mixed $payload, mixed $user): array
    {
        try {
            [$ran, $state] = $this->invoke($request, $handler, $target, $payload, $user);
            if (!$ran) {
                // A middleware answered instead of the action (it did not throw).
                $status = $state->getStatusCode();
                $wait = $state->headers->get('Retry-After');
                $result = $this->problem(Response::$statusTexts[$status] ?? 'Error', $status, $this->statusCode($status));
                return $wait === null ? $result : $result + ['headers' => ['Retry-After' => $wait]];
            }
            // A queued job answers by returning exactly
            // ['accepted' => ['location' => url, 'retryAfter' => seconds]]:
            // 202 Accepted (RFC 9110 15.3.3), its status monitor in Location,
            // the client's `Accepted` polls it. On the batch endpoint the
            // result carries the 202 and these headers, followed the same way.
            if (is_array($state) && array_keys($state) === ['accepted']) {
                return ['body' => (object) [], 'status' => 202, 'headers' => array_filter([
                    'Location' => $state['accepted']['location'] ?? null,
                    'Retry-After' => isset($state['accepted']['retryAfter']) ? (string) $state['accepted']['retryAfter'] : null,
                ])];
            }
            return ['body' => $this->body($state), 'status' => 200] + self::invalidates($handler);
        } catch (ValidationException $e) {
            // Its own status: 422 unless the action set one (`->status(409)`).
            return $this->problem($e->getMessage(), $e->status, 'validation_failed', $this->pointers($e->errors(), $e->validator->getData()));
        } catch (AuthorizationException $e) {
            // A policy's own status (`denyAsNotFound()`, `denyWithStatus()`),
            // as Laravel's handler answers it: a 404 hides that the resource
            // exists, so it says no more than a missing one does.
            $status = $e->hasStatus() ? $e->status() : 403;
            return $status === 404
                ? $this->problem('Resource not found', 404, 'not_found')
                : $this->problem($e->getMessage(), $status, $status === 403 ? 'forbidden' : $this->statusCode($status));
        } catch (AuthenticationException $e) {
            return $this->problem($e->getMessage(), 401, 'unauthenticated');
        } catch (ModelNotFoundException $e) {
            return $this->problem('Resource not found', 404, 'not_found');
        } catch (HttpExceptionInterface $e) {
            // `abort(404)`, `abort(429, ..., ['Retry-After' => 30])`: its
            // status and headers, as Laravel's handler answers it, not a 500.
            $status = $e->getStatusCode();
            $headers = array_map(static fn (mixed $v): string => is_array($v) ? implode(', ', $v) : (string) $v, $e->getHeaders());
            $result = $this->problem($e->getMessage() !== '' ? $e->getMessage() : (Response::$statusTexts[$status] ?? 'Error'), $status, $this->statusCode($status));
            return $headers === [] ? $result : $result + ['headers' => $headers];
        } catch (\Throwable $e) {
            // Any exception that declares its own render() (a package's own
            // domain exception, or the host app's) gets its status, detail,
            // field errors, other members and `Retry-After` read from there
            // instead
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
                    $result = $this->problem($data['detail'] ?? $e->getMessage(), $rendered->getStatusCode(), $code, is_array($data['errors'] ?? null) ? $data['errors'] : []);
                    // Its own `type` and `title` too: a backend's own `type`
                    // is kept (docs/contract.md rule 3, contract case core-8).
                    $result['body'] += array_diff_key($data, array_flip(['status', 'code', 'detail', 'errors']));
                    // `Retry-After` alone, as the abort() branch carries its
                    // thrower's headers. Not the response's whole header bag:
                    // it holds `content-type: application/json`, which would
                    // replace the problem's media type, and `cache-control`
                    // and `date`, which a batch result would repeat.
                    $wait = $rendered->headers->get('Retry-After');
                    return $wait === null ? $result : $result + ['headers' => ['Retry-After' => $wait]];
                }
            }

            report($e);
            return $this->problem('Internal error', 500, 'internal_error');
        }
    }

    /**
     * Call the action inside the middleware it declares, as a route runs a
     * controller's: `HasMiddleware`'s static `middleware()` and
     * `#[Middleware]` on the class, its parents or `__invoke`, kept by their
     * `only` and `except` for `__invoke`, then resolved by the router's
     * aliases and groups (`throttle:cart`). Laravel 13's
     * Route::controllerMiddleware() and Router::resolveMiddleware(). A
     * middleware's exception (`throttle` throws a 429 with `Retry-After`)
     * reaches run()'s mapping; a response it returns instead is returned with
     * `false`, the action's value with `true`.
     *
     * @return array{0: bool, 1: mixed}
     */
    private function invoke(Request $request, string $handler, mixed $target, mixed $payload, mixed $user): array
    {
        $middleware = self::middlewareOf($handler);
        if ($middleware === []) {
            return [true, app($handler)($target, $payload, $user)];
        }

        $state = null;
        $ran = false;
        $response = (new Pipeline(app()))
            ->send($request)
            ->through(app(Router::class)->resolveMiddleware($middleware))
            ->then(function () use (&$state, &$ran, $handler, $target, $payload, $user): Response {
                $state = app($handler)($target, $payload, $user);
                $ran = true;
                return new Response();
            });

        return $ran ? [true, $state] : [false, $response];
    }

    /** @return array<int, \Closure|string> */
    private static function middlewareOf(string $handler): array
    {
        $applies = static fn (?array $only, ?array $except): bool =>
            ($only === null || in_array('__invoke', $only, true)) && ($except === null || !in_array('__invoke', $except, true));

        $declared = [];
        if (is_a($handler, HasMiddleware::class, true)) {
            foreach ($handler::middleware() as $entry) {
                $entry = $entry instanceof Middleware ? $entry : new Middleware($entry);
                if ($applies($entry->only, $entry->except)) {
                    array_push($declared, ...(array) $entry->middleware);
                }
            }
        }
        $attributes = [];
        for ($class = new \ReflectionClass($handler); $class; $class = $class->getParentClass()) {
            $attributes = array_merge($class->getAttributes(MiddlewareAttribute::class, \ReflectionAttribute::IS_INSTANCEOF), $attributes);
        }
        if (method_exists($handler, '__invoke')) {
            $attributes = array_merge($attributes, (new \ReflectionMethod($handler, '__invoke'))->getAttributes(MiddlewareAttribute::class, \ReflectionAttribute::IS_INSTANCEOF));
        }
        foreach ($attributes as $attribute) {
            $instance = $attribute->newInstance();
            if ($applies($instance->only, $instance->except)) {
                $declared[] = $instance->middleware;
            }
        }
        return $declared;
    }

    /**
     * The groups an action changes (RFC 9875), on its answer as
     * `Cache-Group-Invalidation`, and in a batched result's `headers` member
     * on the batch endpoint. The client drops its reads in those groups and
     * the router refreshes the ones on screen (docs/router.md). Declared on
     * the action class: `public const CACHE_GROUP_INVALIDATION = ['cart'];`.
     * A read joins a group with `Cache-Groups` (routes-web.php).
     *
     * @return array{headers?: array<string, string>}
     */
    private static function invalidates(string $handler): array
    {
        $groups = defined($handler.'::CACHE_GROUP_INVALIDATION') ? constant($handler.'::CACHE_GROUP_INVALIDATION') : [];
        if ($groups === []) {
            return [];
        }
        // Structured Field Strings (RFC 9651 3.3.3): quoted, `"` and `\` escaped.
        $list = implode(', ', array_map(static fn (string $g): string => '"'.addcslashes($g, '"\\').'"', $groups));
        return ['headers' => ['Cache-Group-Invalidation' => $list]];
    }

    /**
     * The success body for an action's return value. Two exact shapes are
     * lifted to the top of the envelope, where the bridges read them, per
     * result on a batch (docs/integrations/laravel.md):
     *   - ['redirect' => url]: a navigation. Wrapped as `state` it would be a
     *     success whose value is a URL.
     *   - ['state' => ..., 'stores' => [id => state]], or ['stores' => ...]:
     *     store states the client applies to the stores with those ids
     *     (docs/store.md, A store behind a transport).
     * Only those exact key sets are lifted: a state that merely HAS such a key
     * among others is data.
     */
    private function body(mixed $state): array
    {
        if (!is_array($state)) {
            return ['state' => $state];
        }
        $keys = array_keys($state);
        sort($keys);
        if ($keys === ['redirect']) {
            return ['redirect' => $state['redirect']];
        }
        if ($keys === ['state', 'stores'] || $keys === ['stores']) {
            return $state;
        }
        return ['state' => $state];
    }

    /**
     * The key from an `Idempotency-Key` value: the request's header, or a
     * batched command's `headers` member (docs/contract.md 4). The draft
     * makes it a Structured Field String (RFC 9651). The client sends the key
     * percent-encoded and quoted, so unescaping and `rawurldecode` give back
     * the exact key. A value that is not a String fails to parse, and RFC
     * 9651 ignores a field that fails to parse: no key.
     */
    private function idempotencyKey(?string $value): ?string
    {
        if ($value === null || !preg_match('/^ *"((?:[\x20\x21\x23-\x5B\x5D-\x7E]|\\\\["\\\\])*)" *$/', $value, $m)) {
            return null;
        }
        $key = rawurldecode(stripslashes($m[1]));

        return $key !== '' ? $key : null;
    }

    /**
     * A batched command's own request header, by name in any case (RFC 9110
     * 5.1): the first string value, else null.
     */
    private static function itemHeader(mixed $headers, string $name): ?string
    {
        if (!is_array($headers)) {
            return null;
        }
        foreach ($headers as $key => $value) {
            if (is_string($key) && is_string($value) && strcasecmp($key, $name) === 0) {
                return $value;
            }
        }

        return null;
    }

    /**
     * Who a key belongs to: the user, else the session, else the address a
     * request with neither came from. The draft leaves a key's uniqueness to
     * the resource owner (Idempotency-Key draft-07 2.2). This controller makes
     * it unique per client, so two clients sending the same key are two
     * requests.
     */
    public static function idempotencyScope(Request $request, mixed $user): string
    {
        if ($user instanceof Authenticatable) {
            return 'user:'.$user::class.':'.$user->getAuthIdentifier();
        }

        return $request->hasSession() ? 'session:'.$request->session()->getId() : 'ip:'.$request->ip();
    }

    // The key's storage, public so a development route (the contract's state
    // route, docs/contract.md 4) sets a key's state the way this controller
    // reads it, instead of copying the formulas.

    /** The slot of a key in a scope, for one command. */
    public static function slot(string $scope, string $command, string $key): string
    {
        return hash('sha256', "{$scope}\0{$command}\0{$key}");
    }

    /** The cache key of a slot's answer. */
    public static function cacheKey(string $slot): string
    {
        return "vc:idem:{$slot}";
    }

    /**
     * Store a slot's answer, which a repeat of its key replays, with the
     * fingerprint of the request it answered.
     *
     * @param array{body: array<string, mixed>|object, status: int, headers?: array<string, string>} $result
     */
    public static function remember(string $slot, array $result, string $fingerprint): void
    {
        Cache::put(self::cacheKey($slot), $result + ['fingerprint' => $fingerprint], self::idempotencyTtl());
    }

    /**
     * The fingerprint of a request's target and payload. Object members are
     * sorted at every level, so the same JSON object with its members in
     * another order is the same request. Lists keep their order.
     *
     * Private to this controller: it computes and compares it, nobody else.
     * It is not RFC 8785 (json_encode escapes `/` and non-ASCII and writes
     * 1.0 where ECMAScript writes 1), so it is never compared across sides.
     * A hash another party computes is RFC 8785 (src/canonical.ts).
     */
    public static function fingerprint(mixed $target, mixed $payload): string
    {
        return hash('sha256', json_encode(self::sorted([$target, $payload])));
    }

    private static function sorted(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }
        $value = array_map(self::sorted(...), $value);
        if (!array_is_list($value)) {
            ksort($value, SORT_STRING);
        }

        return $value;
    }

    /** The lock a slot holds while its command runs. */
    public static function lock(string $slot): Lock
    {
        return Cache::lock("vc:idem:lock:{$slot}", 30);
    }

    /**
     * A problem `code` for an HTTP status with no domain code of its own: the
     * status's reason phrase, snake_cased ('not_found', 'too_many_requests').
     */
    private function statusCode(int $status): string
    {
        $text = Response::$statusTexts[$status] ?? null;

        return $text === null ? 'http_error' : trim(strtolower((string) preg_replace('/\W+/', '_', $text)), '_');
    }

    /**
     * The failure, as the contract's RFC 9457 problem: `status`, `code` (its
     * identity), `detail` (the sentence, `result.error.message` on the JS
     * side), `errors` when there are field errors. This controller sends no
     * `type` or `title` of its own: `code` is the identity and `title`
     * repeated the status. A rendered exception's own are kept (run()).
     *
     * The client reads the failure's condition from `status`, by the status
     * table (`conditionOfStatus` in src/failure.ts): send the status that says
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
     * per field, the pointer into the envelope the client sent (RFC 6901; a
     * dotted key is a nested path), the field's first message.
     *
     * An action that validates `$payload` keys its errors by field (`qty`):
     * the pointer is `/payload/qty`. A generated stub validates the envelope,
     * `['target' => ..., 'payload' => ...]`, so its keys already start at the
     * envelope (`payload.qty`, `target.id`): the pointer is `/payload/qty` or
     * `/target/id`. The validated data's own keys tell the two apart.
     *
     * @param array<string, array<int, string>> $fields
     * @return list<array{pointer: string, detail: string}>
     */
    private function pointers(array $fields, mixed $data): array
    {
        $keys = is_array($data) ? array_keys($data) : [];
        sort($keys);
        $prefix = $keys === ['payload', 'target'] ? '/' : '/payload/';
        $errors = [];
        foreach ($fields as $field => $messages) {
            $segments = array_map(
                static fn (string $s): string => str_replace(['~', '/'], ['~0', '~1'], $s),
                explode('.', (string) $field),
            );
            $errors[] = ['pointer' => $prefix.implode('/', $segments), 'detail' => (string) ($messages[0] ?? '')];
        }

        return $errors;
    }
}
