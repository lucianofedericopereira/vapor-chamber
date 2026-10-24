@php
    // The cart as the session holds it: the same shape the actions answer, so the
    // page starts from the server's cart and a reload never shows a stale one.
    $held = session('vc.cart', ['count' => 0, 'cents' => 0, 'last' => '']);
    $cart = [
        'count' => $held['count'],
        'total' => $held['cents'] / 100,
        'totalText' => number_format($held['cents'] / 100, 2),
        'lastAdded' => $held['last'],
    ];
@endphp
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  {{-- Real Laravel CSRF - VaporChamber.connect({ csrf: true }) reads this
       meta tag and attaches X-CSRF-TOKEN to every dispatch. --}}
  <meta name="csrf-token" content="{{ csrf_token() }}" />
  <title>vapor-chamber - Laravel demo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    .panel { border: 1px solid #ccc; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
    .row { display: flex; justify-content: space-between; align-items: center; margin: .4rem 0; }
    button { padding: .4rem .9rem; border-radius: 6px; border: 1px solid #888; cursor: pointer; }
    button[aria-disabled="true"] { opacity: .5; cursor: wait; }
    button.vc-error { border-color: #c00; color: #c00; }
    .err { color: #c00; }
    #status, #error-msg { min-height: 1.4em; margin: .75rem 0 0; }
    #last:empty::before { content: '-'; }
    pre { background: #f5f5f5; padding: .5rem; border-radius: 4px; font-size: 12px; overflow: auto; }
  </style>
</head>
<body>
  <h1>vapor-chamber on Laravel</h1>
  <p>
    Server-rendered Blade page, no build step, no Vue. The IIFE bundle
    dispatches commands to <code>POST /api/vc</code>; one controller routes
    them to action classes; the cart lives in the Laravel session.
  </p>

  <div class="panel">
    <h2>Menu</h2>
    <div class="row"><span>Coffee - $4.00</span><button type="button" data-vc-command="cartAdd" data-vc-target='{"id":1}' data-vc-payload='{"qty":1}'>Add</button></div>
    <div class="row"><span>Tea - $3.00</span><button type="button" data-vc-command="cartAdd" data-vc-target='{"id":2}' data-vc-payload='{"qty":1}'>Add</button></div>
    <div class="row"><span>Espresso - $5.00</span><button type="button" data-vc-command="cartAdd" data-vc-target='{"id":3}' data-vc-payload='{"qty":1}'>Add</button></div>
    <div class="row"><span>Coffee, quantity 0 (the server refuses it)</span><button type="button" data-vc-command="cartAdd" data-vc-target='{"id":1}' data-vc-payload='{"qty":0}'>Add</button></div>
    <div class="row"><span>Remove (the server has no such command)</span><button type="button" data-vc-command="cartRemove">Remove</button></div>
  </div>

  {{-- The cart is markup over the `cart` store. It starts from the session's
       cart, rendered into data-cart, and every answer replaces it. --}}
  <div class="panel" id="cart" data-cart="{{ json_encode($cart) }}">
    <h2>Cart <small>(server session - survives reload)</small></h2>
    <div class="row"><span>Items</span><strong id="count" data-vc-text="cart.count"></strong></div>
    <div class="row"><span>Total</span><strong>$<span id="total" data-vc-text="cart.totalText"></span></strong></div>
    <div class="row"><span>Last added</span><span id="last" data-vc-text="cart.lastAdded"></span></div>
    <button type="button" id="clear" data-vc-command="cartClear">Clear cart</button>
    <p id="status" role="status"></p>
    <p id="error-msg" class="err"></p>
  </div>

  <div class="panel">
    <h2>Wire log</h2>
    <pre id="log">(dispatch something...)</pre>
  </div>

  <script src="/js/vapor-chamber-core.iife.min.js"></script>
  <script>
    // The build this page was served from. The controller compares it with the
    // app's current one: after a deploy an open tab's command is answered
    // { redirect } to this page, and onRedirect loads the new build.
    const { bus } = VaporChamber.connect({
      endpoint: '/api/vc',
      csrf: true,
      headers: { 'X-App-Version': @json((string) config('vapor-chamber.app_version')) },
      onRedirect: (url) => location.assign(url),
    });

    // The cart is a store behind the transport: its actions have no local
    // change (`null`), and whatever the server answers is its state (`answer`).
    VaporChamber.defineChamberStore('cart', {
      state: () => JSON.parse(document.getElementById('cart').dataset.cart),
      reducers: { add: null, clear: null },
      answer: (_state, value) => value,
    })(bus);

    // The buttons and the numbers are markup. bindCommands dispatches each
    // data-vc-command, marks the button aria-disabled while it is in flight
    // (never disabled, which would send keyboard focus to <body>), ignores a
    // press meanwhile and announces a failure. bindDisplay writes the numbers.
    VaporChamber.bindCommands(document.body, { bus });
    VaporChamber.bindDisplay(document.body, { bus });

    // Telemetry and the outcome in words, as TEXT: a failure's message is the
    // backend's sentence, never markup. A redirect is a navigation, not a failure to show.
    const $ = (id) => document.getElementById(id);
    const lines = [];
    bus.on('*', (cmd, result) => {
      lines.unshift(`${cmd.action} -> ${result.ok ? 'ok' : 'fail: ' + result.error?.message}`);
      $('log').textContent = lines.slice(0, 8).join('\n');
      if (result.error?.code === 'transport:refused:redirect') return;
      $('status').textContent = result.ok
        ? (cmd.action === 'cartAdd' ? `${result.value.lastAdded} added. ${result.value.count} item(s).` : 'Cart cleared.')
        : '';
      $('error-msg').textContent = result.ok ? '' : `Error: ${result.error.message}`;
    });
  </script>
</body>
</html>
