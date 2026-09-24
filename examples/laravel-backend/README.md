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
- **Return any JSON-serializable shape** - it becomes the client's
  `result.value`.
- **Throw framework exceptions** for failure paths. The controller answers
  each as an RFC 9457 problem (`application/problem+json`, `{ type, title,
  status, detail, code }`):
  - `ValidationException` -> 422, `code: 'validation_failed'`
  - `AuthorizationException` -> 403, `code: 'forbidden'`
  - `ModelNotFoundException` -> 404, `code: 'not_found'`
  - An exception with its own `render()` -> its status, `detail`, and `code`
    (or the last segment of its `type`)
  - Anything else -> 500, `code: 'internal_error'`, `detail: 'Internal error'`
    (and `report()`s the original)

  On the batch endpoint the same problem rides on the command's own result,
  `{ id, ok: false, problem }`, inside a 200.

## Idempotency (double-submit protection)

When the JS side enables the `idempotent()` plugin, retried or replayed commands
carry an `Idempotency-Key` header. The controller honors it with a short-lived
cache (TTL 60s, matching the JS plugin's default): a second POST with the same
key replays the cached response instead of running the action again, so a
network retry can't create a duplicate order. No setup is needed beyond a
working Laravel cache store.

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

Server log: one `POST /api/vc` with JSON body. Browser console:
`{ ok: true, value: { count: 1, total: ... } }`.
