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
| `ProcessCheckout.php`               | `app/Actions/Order/`                          | Queued-command action returning optimistic state     |

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
  - `ValidationException` -> 422, `code: 'validation_failed'`, the field
    errors as `errors: [{ pointer: '/payload/<field>', detail }]`
  - `AuthorizationException` -> 403, `code: 'forbidden'`
  - `ModelNotFoundException` -> 404, `code: 'not_found'`
  - An exception with its own `render()` -> its status, `detail`, and `code`
  - Anything else -> 500, `code: 'internal_error'`, `detail: 'Internal error'`
    (and `report()`s the original)

  On the batch endpoint the same problem rides on the command's own result,
  `{ id, problem }`, inside a 200; a success is `{ id, state }`. Headers the
  command's own response would have had ride beside it, `headers` (OData JSON
  batch): `{ id, problem, headers: { "Retry-After": "1" } }`.

## Idempotency (double-submit protection)

An action declared idempotent on the JS bus
(`createAsyncCommandBus({ retry: { actionPolicies: { cartSet: 'idempotent' } } })`, or
`retry: 'idempotent'` on the schema action) carries one `Idempotency-Key` on
every attempt the bus re-sends; the `idempotent()` plugin stamps one too, and
the outbox replays with its record's key. The controller honors it with a
short-lived cache (TTL 60s): a second POST with the same key replays the cached
response instead of running the action again, so a re-send can't create a
duplicate order. A re-send that arrives while the first is still running gets
409 with `Retry-After: 1`, and the bus comes back for the finished answer. No
setup is needed beyond a working Laravel cache store.

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
