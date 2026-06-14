# Runnable Laravel example

A **real, verified Laravel app** wiring the full vapor-chamber dispatch loop:
Blade page → IIFE bundle → `POST /api/vc` (real Laravel CSRF) → one thin
controller → action classes → session-backed cart → `{ ok, state }` back into
the page. No build step, no Vue, no database — it runs on a fresh skeleton
with zero migrations.

This folder complements [`../laravel-backend/`](../laravel-backend) (drop-in
companion files for *your* app, with your models) by being **runnable as-is**:
the actions here use a static catalog + the Laravel session instead of
assuming a products table.

## Run

```bash
cd examples/laravel-app
./setup.sh              # composer create-project + drops the files in (./demo-app)
cd demo-app && php artisan serve
# open http://127.0.0.1:8000/cart
```

Needs PHP ≥ 8.2 and Composer. `setup.sh` is idempotent and builds the
vapor-chamber `dist/` on demand for the IIFE copy.

## What's demonstrated

- **One endpoint, many commands** — the action name travels in the JSON body,
  not the URL: `dispatch('cartAdd', { id: 1 }, { qty: 1 })`.
- **Real CSRF flow A** — the Blade meta tag + `VaporChamber.connect({ csrf: true })`
  attaching `X-CSRF-TOKEN`, verified by Laravel's `web` middleware.
- **Action classes** — `__invoke($target, $payload, $user)`, inline
  `validator()->validate()` → the controller maps `ValidationException` to
  `422 { ok: false, error }`.
- **Server-truth state** — the cart lives in the session; reload the page and
  Blade renders the same numbers the bus returned.
- **Wire observability** — `bus.on('*', …)` logs every dispatch on the page.

## Smoke test (no browser)

```bash
# happy path
curl -s -X POST http://127.0.0.1:8000/api/vc \
  -H 'Content-Type: application/json' -H "X-CSRF-TOKEN: $TOKEN" -b cookies.txt \
  -d '{"command":"cartAdd","target":{"id":1},"payload":{"qty":2}}'
# → {"ok":true,"state":{"count":2,"total":8,"lastAdded":"Coffee"}}

# validation failure
... -d '{"command":"cartAdd","target":{"id":99}}'   # → 422 {"ok":false,...}

# unknown command
... -d '{"command":"nope","target":{}}'             # → 404 {"ok":false,...}
```

(Get `$TOKEN` + session cookie from `GET /cart` first — or just use the page.)

**Read next:** [`docs/integrations/laravel.md`](../../docs/integrations/laravel.md)
for the full picture — Sanctum SPA flow, Inertia coexistence, Filament panels,
Echo/Reverb realtime, queued commands, idempotency keys.
