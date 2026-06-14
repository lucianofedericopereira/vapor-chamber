<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  {{-- Real Laravel CSRF — VaporChamber.connect({ csrf: true }) reads this
       meta tag and attaches X-CSRF-TOKEN to every dispatch. --}}
  <meta name="csrf-token" content="{{ csrf_token() }}" />
  <title>vapor-chamber — Laravel demo</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    .panel { border: 1px solid #ccc; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
    .row { display: flex; justify-content: space-between; align-items: center; margin: .4rem 0; }
    button { padding: .4rem .9rem; border-radius: 6px; border: 1px solid #888; cursor: pointer; }
    button:disabled { opacity: .5; cursor: wait; }
    .err { color: #c00; }
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
    <div class="row"><span>Coffee — $4.00</span><button data-add="1">Add</button></div>
    <div class="row"><span>Tea — $3.00</span><button data-add="2">Add</button></div>
    <div class="row"><span>Espresso — $5.00</span><button data-add="3">Add</button></div>
  </div>

  <div class="panel">
    <h2>Cart <small>(server session — survives reload)</small></h2>
    <div class="row"><span>Items</span><strong id="count">{{ session('vc.cart.count', 0) }}</strong></div>
    <div class="row"><span>Total</span><strong>$<span id="total">{{ number_format(session('vc.cart.cents', 0) / 100, 2) }}</span></strong></div>
    <div class="row"><span>Last added</span><span id="last">{{ session('vc.cart.last', '—') }}</span></div>
    <button id="clear">Clear cart</button>
    <p id="status"></p>
  </div>

  <div class="panel">
    <h2>Wire log</h2>
    <pre id="log">(dispatch something…)</pre>
  </div>

  <script src="/js/vapor-chamber-core.iife.min.js"></script>
  <script>
    // One line: bus + HTTP transport + CSRF from the Blade meta tag.
    const { bus, dispatch } = VaporChamber.connect({ endpoint: '/api/vc', csrf: true });

    const $ = (id) => document.getElementById(id);
    const lines = [];
    bus.on('*', (cmd, result) => {
      lines.unshift(`${cmd.action} → ${result.ok ? 'ok' : 'fail: ' + result.error?.message}`);
      $('log').textContent = lines.slice(0, 8).join('\n');
    });

    function render(state) {
      $('count').textContent = state.count;
      $('total').textContent = state.total.toFixed(2);
      $('last').textContent = state.lastAdded || '—';
    }

    document.querySelectorAll('[data-add]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const result = await dispatch('cartAdd', { id: Number(btn.dataset.add) }, { qty: 1 });
        btn.disabled = false;
        if (result.ok) { render(result.value); $('status').textContent = ''; }
        else $('status').innerHTML = `<span class="err">${result.error.message}</span>`;
      });
    });

    $('clear').addEventListener('click', async () => {
      const result = await dispatch('cartClear', {});
      if (result.ok) render(result.value);
    });
  </script>
</body>
</html>
