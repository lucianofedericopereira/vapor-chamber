# Sprinkled-JS demo

Minimal runnable example of the **sprinkled-JS** pattern — server-rendered
HTML with vapor-chamber's IIFE bundle dispatching commands to a backend
over HTTP. No Vue, no Vite, no build step.

This is the canonical shape for Laravel Blade, Rails, Django, .NET MVC,
WordPress, or any other server-rendered framework.

## Files

| File              | Role                                                                  |
|-------------------|-----------------------------------------------------------------------|
| `index.html`      | The page Blade/Rails/Django would render. Includes the IIFE script.   |
| `mock-server.mjs` | Tiny Node HTTP server that emulates what `VaporChamberController.php` would do (see [`../laravel-backend/`](../laravel-backend/)) |

## Run

Two terminals:

```bash
# Terminal 1: backend mock (emulates Laravel/Rails/Django route)
cd examples/sprinkled-blade
node mock-server.mjs

# Terminal 2: serve the static HTML
cd examples/sprinkled-blade
npx serve .          # → http://localhost:3000
```

Open the printed URL. Click "Add to cart" — you should see:

- The cart counter updating
- A telemetry log line per dispatch
- A POST to `http://localhost:3001/api/vc` in the network tab

## What this demo proves

- IIFE bundle works without a bundler — pure `<script>` tag.
- `VaporChamber.connect()` is a one-line setup that wires HTTP transport +
  CSRF token reading.
- The CSRF token in `<meta name="csrf-token">` flows automatically into
  every dispatched command's `X-CSRF-TOKEN` header.
- `bus.on('*', …)` lets you tap every dispatch for telemetry / logging
  without modifying the call sites.
- The backend contract (`{command, target, payload}` in, `{ok, state}` out)
  is intentionally simple — easy to implement in any language.

## Mapping to a real Laravel / Rails / Django app

| Demo                                            | Laravel                                        | Rails                                | Django                            |
|-------------------------------------------------|------------------------------------------------|--------------------------------------|-----------------------------------|
| `<meta name="csrf-token" content="demo-…">`     | `<meta name="csrf-token" content="{{ csrf_token() }}">` | `<%= csrf_meta_tags %>`             | `{% csrf_token %}` (cookie-based) |
| `mock-server.mjs` POST handler                  | `VaporChamberController` (see `../laravel-backend/`) | `class VaporController < ApplicationController` | `def vapor_chamber_view(request)` |
| `handlers.cartAdd` mapping                      | `config/vapor-chamber.php` action class registry | Service-object dispatch              | View dispatch                     |
| Static `<script>` from `dist/`                  | `<script src="{{ asset('vendor/vapor-chamber/iife.min.js') }}">` | `javascript_include_tag` | `{% static 'vapor-chamber/iife.min.js' %}` |

For a complete Laravel implementation, see
[`../laravel-backend/`](../laravel-backend/) — drop-in PHP files for the
controller, action classes, config, and routes.
