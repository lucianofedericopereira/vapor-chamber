# Laravel backend companions

Drop-in PHP files showing the backend side of a vapor-chamber dispatch.
These are illustrative — adapt namespaces, models, and table names to your
project.

| File                                | Goes to                                       | Purpose                                              |
|-------------------------------------|-----------------------------------------------|------------------------------------------------------|
| `VaporChamberController.php`        | `app/Http/Controllers/`                       | Single dispatcher; resolves action classes by name   |
| `config-vapor-chamber.php`          | `config/vapor-chamber.php`                    | Maps command names → action class FQCNs              |
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
  first arg from `bus.dispatch(action, target, payload)`; `$payload` is the
  optional second arg; `$user` is the authenticated user (or null).
- **Return any JSON-serializable shape** — it becomes the client's
  `result.value`.
- **Throw framework exceptions** for failure paths. The controller maps:
  - `ValidationException` → 422 + `{ ok: false, error }`
  - `AuthorizationException` → 403 + `{ ok: false, error }`
  - `ModelNotFoundException` → 404 + `{ ok: false, error }`
  - Anything else → 500 + `{ ok: false, error: 'Internal error' }` (and
    `report()`s the original)

## Smoke test

```bash
php artisan serve
```

```html
<meta name="csrf-token" content="{{ csrf_token() }}">
<script src="https://cdn.jsdelivr.net/npm/vapor-chamber/dist/vapor-chamber-core.iife.min.js"></script>
<script>
  const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc' });
  dispatch('cartAdd', { id: 1 }, { qty: 2 }).then(r => console.log(r));
</script>
```

Server log: one `POST /api/vc` with JSON body. Browser console:
`{ ok: true, value: { count: 1, total: ... } }`.
