# Sprinkled-JS demo

A minimal runnable example of the **sprinkled-JS** pattern: server-rendered
HTML, with vapor-chamber's IIFE bundle dispatching commands to a backend
over HTTP. No Vue, no Vite, no build step.

This is the canonical shape for Laravel Blade, Rails, Django, .NET MVC,
WordPress, or any other server-rendered framework.

## Files

| File              | Role                                                                  |
|-------------------|-----------------------------------------------------------------------|
| `index.html`      | The page Blade/Rails/Django would render. Includes the IIFE script.   |
| `mock-server.mjs` | Tiny Node HTTP server that emulates what `VaporChamberController.php` would do (see [`../laravel-backend/`](../laravel-backend/)) |

## Run

First, build the library once so the IIFE bundle exists (this demo has no
package.json of its own: `index.html` loads `../../dist/vapor-chamber-core.iife.min.js`):

```bash
# repo root: creates dist/
npm install
```

Then one process, since the mock backend serves the page too:

```bash
cd examples/sprinkled-blade
node mock-server.mjs         # -> http://localhost:3001
```

Open <http://localhost:3001>. The cart is **rendered into the HTML** by the
backend (the Blade `@json($cart)` moment): the count is the span's text, and
the cart as JSON in its `data-cart`, which the page's store starts from. First
paint is correct, so there is no startup fetch and no flicker. Same origin, so
no CORS at all.

To see the other half of the trade-off, serve the file statically instead:

```bash
node ../static-server.mjs    # -> http://localhost:3000/examples/sprinkled-blade/index.html
node mock-server.mjs         # backend still on :3001
```

Now the page is cross-origin. No cart is rendered into it, so the page reads the cart once at load
with a `cartState` command, and the count reads "not read yet" until it
answers. That is the flicker server rendering removes. Every dispatch is also preceded by a CORS
preflight (`Content-Type: application/json` is not CORS-safelisted), which is
why the backend's `Access-Control-Allow-Headers` must list `Content-Type`, and
`Idempotency-Key` for a keyed command.

Click "Add to cart". You should see:

- The cart counter updating
- A telemetry log line per dispatch
- "Added." in the status line
- A POST to `http://localhost:3001/api/vc` in the network tab

"Remove" sends a command the backend does not have. It answers a 404 problem,
the button turns red, the failure is announced and the error line shows it.

## What this demo proves

- The IIFE bundle works without a bundler, from a plain `<script>` tag.
- The page is markup. `bindCommands` dispatches each `data-vc-command`, marks
  the button `aria-disabled` while it is in flight and announces a failure.
  `bindDisplay` writes the count from a store (`data-vc-text="cart.summary"`).
  A busy display that waits is CSS on `vc-loading`
  ([accessibility.md](../../docs/accessibility.md)).
- `VaporChamber.connect()` is a one-line setup that wires HTTP transport +
  CSRF token reading. Its bus re-sends a transient failure (a 429, 503 or
  408, after any `Retry-After`). A failure that may have landed (no reply, a
  502 or 504) is re-sent only for an action declared safe to send twice:
  `connect({ retry: { actionPolicies: { cartSet: 'idempotent' } } })`.
  `retry: false` turns retries off.
- The CSRF token in `<meta name="csrf-token">` flows automatically into
  every dispatched command's `X-CSRF-TOKEN` header.
- `bus.on('*', ...)` lets you tap every dispatch for telemetry / logging
  without modifying the call sites.
- The cart is a store behind the transport. What the server answers is its
  state, and the server's rendered cart is where it starts.
- The backend contract (`{command, target, payload}` in, `{ state }` out, or
  an RFC 9457 problem for a failure) is intentionally simple, easy to
  build in any language.

## Mapping to a real Laravel / Rails / Django app

| Demo                                            | Laravel                                        | Rails                                | Django                            |
|-------------------------------------------------|------------------------------------------------|--------------------------------------|-----------------------------------|
| `<meta name="csrf-token" content="demo-...">`     | `<meta name="csrf-token" content="{{ csrf_token() }}">` | `<%= csrf_meta_tags %>`             | `{% csrf_token %}` (cookie-based) |
| `mock-server.mjs` POST handler                  | `VaporChamberController` (see `../laravel-backend/`) | `class VaporController < ApplicationController` | `def vapor_chamber_view(request)` |
| `handlers.cartAdd` mapping                      | `config/vapor-chamber.php` action class registry | Service-object dispatch              | View dispatch                     |
| `data-cart='{...}'` on the count span           | `data-cart='@json($cart)'`                     | `data-cart="<%= @cart.to_json %>"`   | `data-cart="{{ cart_json }}"`     |
| Static `<script>` from `dist/`                  | `<script src="{{ asset('vendor/vapor-chamber/iife.min.js') }}">` | `javascript_include_tag` | `{% static 'vapor-chamber/iife.min.js' %}` |

For a complete Laravel backend, see
[`../laravel-backend/`](../laravel-backend/): drop-in PHP files for the
controller, action classes, config, and routes.
