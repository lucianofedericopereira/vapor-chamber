# Runnable Laravel example

A **real, verified Laravel app** wiring the full vapor-chamber dispatch loop:
Blade page -> IIFE bundle -> `POST /api/vc` (real Laravel CSRF) -> one thin
controller -> action classes -> session-backed cart -> `{ ok, state }` back into
the page. No build step, no Vue, no database - it runs on a fresh skeleton
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
# open http://127.0.0.1:8000/cart     - no Vue at all
# open http://127.0.0.1:8000/widget   - a Vapor widget bridging into the page
```

`setup.sh` is idempotent and **updates** an existing `demo-app`: it replaces its
own route block rather than skipping when one is already present, so a scaffold
made before a page was added still picks it up.

Needs PHP ≥ 8.2 and Composer. `setup.sh` also builds the vapor-chamber `dist/`
on demand for the IIFE copy.

`composer create-project` always pulls the **current** Laravel skeleton - last
verified end-to-end on **Laravel 13.21** with PHP 8.5. Nothing here pins a
major: the wiring is one route, one controller and two action classes, which
has not changed shape since Laravel 11.

## Two pages, because there are two stories

| page | bundle | Vue? | what it shows |
| --- | --- | --- | --- |
| `/cart` | `core` | no | sprinkled JS: `connect()` + plain DOM, one `<script src>` |
| `/widget` | `elements` | yes, as a module | a Vapor custom element whose events cross the shadow boundary into Alpine and plain-DOM listeners |

They are separate on purpose. `/cart`'s whole point is that nothing but the
`core` IIFE is on the page - and `core` deliberately omits `defineWidget` /
`emitDOMEvent`. `/widget` needs Vue, and needs it as a **module**: Vue publishes
Vapor as `esm-browser` only (there is no `vue.runtime-with-vapor.global.js`), so
a classic `<script src>` tag cannot obtain Vapor, and the library's runtime probe
cannot resolve a bare specifier in a browser. `VaporChamber.configureVue(Vue)` is
therefore not a convenience there, it is the only channel.

Nothing third-party is vendored: only the library's own IIFEs are copied into
`public/js`. Vue and Alpine load from a CDN, and Vue's version is stamped from
this repo's `devDependencies` by `npm run docs:stamp`, so the demo cannot drift
from the version the library is tested against.

## What's demonstrated

- **One endpoint, many commands** - the action name travels in the JSON body,
  not the URL: `dispatch('cartAdd', { id: 1 }, { qty: 1 })`.
- **The widget bridge** (`/widget`) - `emitDOMEvent` dispatches a composed,
  bubbling `CustomEvent` from inside the shadow root, so Alpine's
  `@cart-added.window` and a plain `document.addEventListener` both see it. This
  is the runnable counterpart to the patterns in
  [`docs/integrations/laravel.md`](../../docs/integrations/laravel.md), which
  until now had none.
- **Real CSRF flow A** - the Blade meta tag + `VaporChamber.connect({ csrf: true })`
  attaching `X-CSRF-TOKEN`, verified by Laravel's `web` middleware.
- **Action classes** - `__invoke($target, $payload, $user)`, inline
  `validator()->validate()` -> the controller maps `ValidationException` to a
  422 `application/problem+json` answer, `code: 'validation_failed'`.
- **Server-truth state** - the cart lives in the session; reload the page and
  Blade renders the same numbers the bus returned.
- **Wire observability** - `bus.on('*', ...)` logs every dispatch on the page.

## Smoke test (no browser)

```bash
# happy path
curl -s -X POST http://127.0.0.1:8000/api/vc \
  -H 'Content-Type: application/json' -H "X-CSRF-TOKEN: $TOKEN" -b cookies.txt \
  -d '{"command":"cartAdd","target":{"id":1},"payload":{"qty":2}}'
# -> {"ok":true,"state":{"count":2,"total":8,"lastAdded":"Coffee"}}

# validation failure
... -d '{"command":"cartAdd","target":{"id":99}}'   # -> 422 {"ok":false,...}

# unknown command
... -d '{"command":"nope","target":{}}'             # -> 404 {"ok":false,...}
```

(Get `$TOKEN` + session cookie from `GET /cart` first - or just use the page.)

**Read next:** [`docs/integrations/laravel.md`](../../docs/integrations/laravel.md)
for the full picture - Sanctum SPA flow, Inertia coexistence, Filament panels,
Echo/Reverb realtime, queued commands, idempotency keys.
