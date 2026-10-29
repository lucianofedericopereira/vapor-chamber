# Laravel backend companions

Drop-in PHP files that show the backend side of a vapor-chamber dispatch. They are
illustrative: adapt namespaces, models and table names to your project.

| File                                | Goes to                                       | Purpose                                              |
|-------------------------------------|-----------------------------------------------|------------------------------------------------------|
| `VaporChamberController.php`        | `app/Http/Controllers/`                       | Single dispatcher. Resolves action classes by name   |
| `config-vapor-chamber.php`          | `config/vapor-chamber.php`                    | Maps command names -> action class FQCNs              |
| `routes-web.php`                    | `routes/web.php` snippet                      | Two CSRF flows: Blade meta tag vs Sanctum SPA cookie |
| `AddToCart.php`                     | `app/Actions/Cart/`                           | Action class with inline validation                  |
| `CancelOrder.php`                   | `app/Actions/Order/`                          | Action class with Gate-based authorization           |
| `ProcessCheckout.php`               | `app/Actions/Order/`                          | Queued-command action answering 202 with its monitor |

**Read first:** [`docs/integrations/laravel.md`](../../docs/integrations/laravel.md) covers the
full integration picture: CSRF flows, Inertia coexistence, Filament panels, Reverb realtime,
queued commands.

## Conventions

- **One action class per command.** It keeps the controller thin, makes commands testable, and
  gives validation and authorization a natural home.
- **The `__invoke($target, $payload, $user)` signature.** `$target` is the `target` argument of
  `bus.dispatch(action, target, payload)`, `$payload` is the optional `payload` argument, and
  `$user` is the authenticated user (or null).
- **The target is identity, the payload is input.** Look the target up with `findOrFail`, so a
  missing one is a 404. Validate the payload, so a field error points at `/payload/<field>`, the
  one pointer spelling FormBus maps.
- **Return any JSON-serializable shape.** It becomes the client's `result.value`.
- **Throw framework exceptions for failure paths.** The controller answers each as an RFC 9457
  problem (`application/problem+json`, `{ status, code, detail, errors? }`):
  - `ValidationException` -> 422 (or the status it was given), `code: 'validation_failed'`, the
    field errors as `errors: [{ pointer: '/payload/<field>', detail }]`
  - `AuthorizationException` -> 403, `code: 'forbidden'`, or a policy's own status instead
    (`denyAsNotFound()` -> 404, `code: 'not_found'`)
  - `AuthenticationException` -> 401, `code: 'unauthenticated'`
  - `ModelNotFoundException` -> 404, `code: 'not_found'`
  - `abort()` (an HTTP exception) -> its status and headers, the code its reason phrase in
    snake case (`abort(429)` -> `code: 'too_many_requests'`)
  - An exception with its own `render()` -> its status, `detail`, `code`, and its own `type` and
    `title` when it gives them
  - Anything else -> 500, `code: 'internal_error'`, `detail: 'Internal error'` (and `report()`s
    the original)

  On the batch endpoint the same problem rides on the command's own result,
  `{ id, status, headers, problem }`, inside a 200. A success is `{ id, status, headers, state }`.
  The status and headers are the ones the command's own response would have had (OData JSON
  batch): `{ id, status: 409, headers: { "Retry-After": "1" }, problem }`. A batched command's
  `Idempotency-Key` is read from its own `headers` member.

## Idempotency (double-submit protection)

Three things put an `Idempotency-Key` on a command:

- an action declared idempotent on the JS bus
  (`createAsyncCommandBus({ retry: { actionPolicies: { cartSet: 'idempotent' } } })`, or
  `retry: 'idempotent'` on the schema action), one key on every attempt the bus re-sends.
- the `idempotent()` plugin.
- the outbox, which replays with its record's key.

The controller honours the key with a cache:

- A second POST with the same key replays the stored answer, a success or a 4xx verdict, instead
  of running the action again. So a re-send cannot create a duplicate order.
- A transient failure or an answer with `Retry-After` is not stored, so its re-send runs again.
- The window is `idempotency_ttl` in config/vapor-chamber.php, default 24 hours.
- A re-send that arrives while the first is still running gets 409 with `Retry-After: 1`, and the
  bus comes back for the finished answer.
- The same key with another target or payload is another request. It gets 422 `key_reused`,
  never the first answer.
- A key belongs to whoever sent it (the user, else the session, else the address). So two users
  who send the same key, which an app's own `key` can do, each run their own.
- It needs a Laravel cache store nobody clears. `cache:clear` or an evicting Redis loses keys, and
  a re-send then runs again.

## An old page

A page sends the build it was served from as the `X-App-Version` header
(`httpTransport({ headers })`, `onRedirect: (url) => location.assign(url)`). Set `app_version` in
config/vapor-chamber.php (`env('APP_VERSION')`).

- The controller then answers a command from a page that differs with `{ redirect }` to the page
  that sent it: its `Referer` path on this host, else `reload_url`. The reload brings the new
  build.
- The check is the gate every command crosses, single or batched. An old page's command takes no
  idempotency key and no lock, and runs no action.
- The version is yours, and the library carries none. With `app_version` null, nothing is
  checked.

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

The server log shows one `POST /api/vc` with a JSON body, answered
`{ "state": { "count": 2, ... } }`. The browser console shows the command's result,
`{ ok: true, value: { count: 2, total: ... } }`.
