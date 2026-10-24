# Laravel backend companions

Drop-in PHP files showing the backend side of a vapor-chamber dispatch.
These are illustrative - adapt namespaces, models, and table names to your
project.

| File                                | Goes to                                       | Purpose                                              |
|-------------------------------------|-----------------------------------------------|------------------------------------------------------|
| `VaporChamberController.php`        | `app/Http/Controllers/`                       | Single dispatcher; resolves action classes by name   |
| `config-vapor-chamber.php`          | `config/vapor-chamber.php`                    | Maps command names -> action class FQCNs              |
| `routes-web.php`                    | `routes/web.php` snippet                      | Two CSRF flows: Blade meta tag vs Sanctum SPA cookie |
| `AddToCart.php`                     | `app/Actions/Cart/`                           | Action class with inline validation                  |
| `CancelOrder.php`                   | `app/Actions/Order/`                          | Action class with Gate-based authorization           |
| `ProcessCheckout.php`               | `app/Actions/Order/`                          | Queued-command action answering 202 with its monitor |

**Read first:** [`docs/integrations/laravel.md`](../../docs/integrations/laravel.md)
covers the full integration picture (CSRF flows, Inertia coexistence, Filament
panels, Reverb realtime, queued commands).

## Conventions

- **One action class per command.** Keeps the controller thin, makes
  commands testable, gives validation/authorization a natural home.
- **`__invoke($target, $payload, $user)` signature.** `$target` is the
  `target` argument of `bus.dispatch(action, target, payload)`; `$payload` is
  the optional `payload` argument; `$user` is the authenticated user (or null).
- **The target is identity, the payload is input.** Look the target up with
  `findOrFail` (a missing one is a 404); validate the payload, so a field error
  points at `/payload/<field>`, the one pointer spelling FormBus maps.
- **Return any JSON-serializable shape** - it becomes the client's
  `result.value`.
- **Throw framework exceptions** for failure paths. The controller answers
  each as an RFC 9457 problem (`application/problem+json`, `{ status, code,
  detail, errors? }`):
  - `ValidationException` -> 422 (or the status it was given),
    `code: 'validation_failed'`, the field errors as
    `errors: [{ pointer: '/payload/<field>', detail }]`
  - `AuthorizationException` -> 403, `code: 'forbidden'`; a policy's own
    status instead (`denyAsNotFound()` -> 404, `code: 'not_found'`)
  - `AuthenticationException` -> 401, `code: 'unauthenticated'`
  - `ModelNotFoundException` -> 404, `code: 'not_found'`
  - `abort()` (an HTTP exception) -> its status and headers, the code its
    reason phrase snake_cased (`abort(429)` -> `code: 'too_many_requests'`)
  - An exception with its own `render()` -> its status, `detail`, `code`,
    and its own `type` and `title` when it gives them
  - Anything else -> 500, `code: 'internal_error'`, `detail: 'Internal error'`
    (and `report()`s the original)

  On the batch endpoint the same problem rides on the command's own result,
  `{ id, status, headers, problem }`, inside a 200; a success is
  `{ id, status, headers, state }`. The status and headers are the ones the
  command's own response would have had (OData JSON batch):
  `{ id, status: 409, headers: { "Retry-After": "1" }, problem }`. A batched
  command's `Idempotency-Key` is read from its own `headers` member.

## Idempotency (double-submit protection)

An action declared idempotent on the JS bus
(`createAsyncCommandBus({ retry: { actionPolicies: { cartSet: 'idempotent' } } })`, or
`retry: 'idempotent'` on the schema action) carries one `Idempotency-Key` on
every attempt the bus re-sends; the `idempotent()` plugin stamps one too, and
the outbox replays with its record's key. The controller honors it with a
cache: a second POST with the same key replays the stored answer, a success or
a 4xx verdict, instead of running the action again, so a re-send can't create
a duplicate order. A transient failure or an answer with `Retry-After` is not
stored, so its re-send runs again. The window is `idempotency_ttl` in
config/vapor-chamber.php, default 24 hours. A re-send that arrives while the first is still running gets
409 with `Retry-After: 1`, and the bus comes back for the finished answer. The
same key with another target or payload is another request and gets 422
`key_reused`, never the first answer. A
key belongs to whoever sent it - the user, else the session, else the
address - so two users
sending the same key (an app's own `key` can be) each run
their own. It needs a Laravel cache store nobody clears: `cache:clear` or an
evicting Redis loses keys, and a re-send then runs again.

## An old page

A page sends the build it was served from as the `X-App-Version` header
(`httpTransport({ headers })`, `onRedirect: (url) => location.assign(url)`). Set
`app_version` in config/vapor-chamber.php (`env('APP_VERSION')`) and the controller
answers a command from a page that differs `{ redirect }`, to the page that sent it
(its `Referer` path on this host, else `reload_url`), so the reload brings the new
build. The check is the gate every command crosses, single or batched: an old page's
command takes no idempotency key, no lock and runs no action. The version is yours,
the library carries none. With `app_version` null nothing is checked.

## Smoke test

```bash
php artisan serve
```

```html
<meta name="csrf-token" content="{{ csrf_token() }}">
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber@<version>/dist/vapor-chamber-core.iife.min.js"></script>
<script>
  const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
  dispatch('cartAdd', { id: 1 }, { qty: 2 }).then(r => console.log(r));
</script>
```

Server log: one `POST /api/vc` with JSON body; the answer is
`{ "state": { "count": 2, ... } }`. Browser console: the command's result,
`{ ok: true, value: { count: 2, total: ... } }`.
