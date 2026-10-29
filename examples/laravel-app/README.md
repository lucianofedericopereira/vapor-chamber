# Runnable Laravel example

A **real, verified Laravel app** that wires the full vapor-chamber dispatch loop: Blade page ->
IIFE bundle -> `POST /api/vc` (real Laravel CSRF) -> one thin controller -> action classes ->
session-backed cart -> `{ state }` back into the page. A failure is an RFC 9457 problem.

- No build step and no database: it runs on a fresh skeleton with zero migrations.
- The `/cart` page loads no Vue. `/widget` loads it as a module (below).

This folder complements [`../laravel-backend/`](../laravel-backend), the drop-in companion files
for *your* app with your models, by being **runnable as it is**. The actions here use a static
catalog and the Laravel session instead of assuming a products table.

## Run

```bash
cd examples/laravel-app
./setup.sh              # composer create-project + drops the files in (./demo-app)
cd demo-app && php artisan serve
# open http://127.0.0.1:8000/cart     - no Vue at all
# open http://127.0.0.1:8000/widget   - a Vapor widget bridging into the page
```

- `setup.sh` is idempotent and **updates** an existing `demo-app`. It replaces its own route
  block rather than skipping when one is already present, so a scaffold made before a page was
  added still picks it up.
- It also adds this repo's Composer package from the checkout (`composer require`). Its provider leaves the
  command routes' input as the client sent it (docs/integrations/laravel.md, "Input as the client
  sent it"). An older scaffold's `bootstrap/app.php` lines for the same are removed.
- It needs PHP 8.3 or later (Laravel 13) and Composer. `setup.sh` also builds the vapor-chamber
  `dist/` on demand for the IIFE copy.

`composer create-project` always pulls the **current** Laravel skeleton.[^verified] Nothing
here pins a major: the wiring is one route, one controller and two action classes, a shape
unchanged since Laravel 11.

[^verified]: Last verified end to end on **Laravel 13.38** with PHP 8.5, 2026-10-23.

## Two pages, because there are two stories

| page | bundle | Vue? | what it shows |
| --- | --- | --- | --- |
| `/cart` | `core` | no | sprinkled JS: `connect()`, a store seeded from the session cart, `bindCommands` and `bindDisplay` over markup, one `<script src>` |
| `/widget` | `elements` | yes, as a module | a Vapor custom element whose events cross the shadow boundary into Alpine and plain-DOM listeners |

They are separate on purpose. `/cart`'s whole point is that nothing but the `core` IIFE is on
the page, and `core` omits `defineWidget` and `emitDOMEvent`. `/widget` needs Vue, and needs it
as a **module**. Vue publishes Vapor as `esm-browser` only (there is no
`vue.runtime-with-vapor.global.js`), so a classic `<script src>` tag cannot obtain Vapor, and the
library's runtime probe cannot resolve a bare specifier in a browser. So
`VaporChamber.configureVue(Vue)` is not a convenience there: it is the only channel.

Nothing third-party is vendored: only the library's own IIFEs are copied into `public/js`. Vue
and Alpine load from a CDN. `npm run docs:stamp` stamps Vue's version from this repo's
`devDependencies`, so the demo cannot drift from the version the library is tested against.

## What's demonstrated

- **One endpoint, many commands:** the action name travels in the JSON body, not the URL:
  `dispatch('cartAdd', { id: 1 }, { qty: 1 })`.
- **The widget bridge** (`/widget`): `emitDOMEvent` dispatches a composed, bubbling
  `CustomEvent` from inside the shadow root, so Alpine's `@cart-added.window` and a plain
  `document.addEventListener` both see it. This is the runnable counterpart to the patterns in
  [`docs/integrations/laravel.md`](../../docs/integrations/laravel.md).
- **Real CSRF flow A:** the Blade meta tag and `VaporChamber.connect({ csrf: true })` attach
  `X-CSRF-TOKEN`, verified by Laravel's `web` middleware.
- **Action classes:** `__invoke($target, $payload, $user)`, with inline
  `validator()->validate()` on the payload.
  - The controller maps `ValidationException` to a 422 `application/problem+json` answer,
    `code: 'validation_failed'`, with each field as a `/payload/<field>` pointer.
  - An unknown item is `ModelNotFoundException` -> 404 `not_found`.
- **Server-truth state:** the cart lives in the session. Reload the page, and Blade renders the
  same numbers the bus returned.
- **Wire observability:** `bus.on('*', ...)` logs every dispatch on the page.
- **An old page:** each page sends the build it was served from as `X-App-Version`. The
  controller compares it with `config('vapor-chamber.app_version')` (`APP_VERSION` in `.env`, `1`
  here). It answers a page that differs with `{ redirect }` to the page itself, which
  `onRedirect` loads. To see it, open `/cart`, set `APP_VERSION=2` in the demo's `.env` (a
  deploy), and press Add in the open tab. It reloads onto the new build with the cart intact,
  and the old tab's command ran no action.

## Smoke test (no browser)

```bash
# happy path
curl -s -X POST http://127.0.0.1:8000/api/vc \
  -H 'Content-Type: application/json' -H "X-CSRF-TOKEN: $TOKEN" -b cookies.txt \
  -d '{"command":"cartAdd","target":{"id":1},"payload":{"qty":2}}'
# -> {"state":{"count":2,"total":8,"totalText":"8.00","lastAdded":"Coffee"}}

# validation failure - an RFC 9457 problem, the field as a JSON pointer
... -d '{"command":"cartAdd","target":{"id":1},"payload":{"qty":0}}'
# -> 422 {"status":422,"code":"validation_failed","detail":"...","errors":[{"pointer":"/payload/qty","detail":"..."}]}

# an item that does not exist
... -d '{"command":"cartAdd","target":{"id":99}}'   # -> 404 {"status":404,"code":"not_found","detail":"Resource not found"}

# unknown command
... -d '{"command":"nope","target":{}}'             # -> 404 {"status":404,"code":"unknown_command","detail":"..."}

# an old page (the header is the page's build, the config says 2)
... -H 'X-App-Version: 1' -d '{"command":"cartAdd","target":{"id":1}}'   # -> 200 {"redirect":"/cart"}, no action ran
```

Get `$TOKEN` and the session cookie from `GET /cart` first, or just use the page.

## Check your backend

The wire contract's cases ship as Pact files in `contract/`. With the demo served and
[`pact-verifier`](https://github.com/pact-foundation/pact-reference/releases) on the `PATH`, run
from the repo root:

```bash
node scripts/verify-contract.mjs --base http://127.0.0.1:8000
```

It checks every case on the demo's own `web` routes and exits non-zero on a failure. An app checks
itself the same way (docs/contract.md 4).

**Read next:** [`docs/integrations/laravel.md`](../../docs/integrations/laravel.md) for the full
picture: the Sanctum SPA flow, Inertia coexistence, Filament panels, Echo and Reverb realtime,
queued commands, idempotency keys.
