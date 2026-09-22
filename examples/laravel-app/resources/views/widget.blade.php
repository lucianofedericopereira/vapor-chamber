<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="csrf-token" content="{{ csrf_token() }}" />
  <title>vapor-chamber - Laravel widget bridge</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    .panel { border: 1px solid #ccc; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
    .row { display: flex; justify-content: space-between; align-items: center; margin: .4rem 0; }
    button { padding: .4rem .9rem; border-radius: 6px; border: 1px solid #888; cursor: pointer; }
    pre { background: #f5f5f5; padding: .5rem; border-radius: 4px; font-size: 12px; overflow: auto; }
    .note { color: #555; font-size: 14px; }
  </style>
</head>
<body>
  <h1>Widget bridge</h1>
  <p class="note">
    The sibling page <a href="/cart">/cart</a> is the no-Vue story: the
    <code>core</code> IIFE, plain DOM, one <code>&lt;script src&gt;</code>.
    This page is the other half - a <strong>Vapor custom element</strong> whose
    events cross the shadow boundary into the surrounding page.
  </p>

  <div class="panel">
    <h2>The widget</h2>
    {{-- A real custom element. Its internals are Vapor; the page only sees a tag. --}}
    <vc-cart></vc-cart>
    <p class="note">Rendered inside a shadow root by <code>defineWidget</code>.</p>
  </div>

  {{-- Alpine listens on WINDOW via `.window`, which is why the bridged event is
       dispatched with `composed: true` (escapes the shadow root) and
       `bubbles: true` (reaches window). --}}
  <div class="panel" x-data="{ count: 0, last: '' }"
       @cart-added.window="count = $event.detail.count; last = $event.detail.lastAdded">
    <h2>Alpine listener</h2>
    <div class="row"><span>Items</span><strong x-text="count"></strong></div>
    <div class="row"><span>Last added</span><span x-text="last || '-'"></span></div>
  </div>

  <div class="panel">
    <h2>Plain-DOM listener</h2>
    <div class="row"><span>Events seen</span><strong id="seen">0</strong></div>
    <pre id="log">(add something...)</pre>
  </div>

  {{-- 1. Alpine, from CDN. Not vendored: it is a host-page framework this demo
          only needs in order to prove the bridge reaches it. --}}
  <script defer src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js"></script>

  {{-- 2. The vapor-chamber ELEMENTS variant. `defineWidget` / `emitDOMEvent`
          are its identity and are absent from `core` (which /cart uses). --}}
  <script src="/js/vapor-chamber-elements.iife.min.js"></script>

  {{-- The Vue version this demo loads, owned by `npm run docs:stamp` and read
       from the repo's own devDependency, so it cannot drift from what the
       library is tested against.

       It lives in ELEMENT CONTENT below, not in the import specifier, and that
       is not cosmetic. HTML comments inside a <script> are raw text rather than
       comments, so a stamp marker placed in the URL renders literally and
       yields an invalid specifier - the version arrives wrapped in comment
       delimiters. Here the delimiters really are comments, textContent skips
       them, and the URL is assembled at runtime.

       (Deliberately described rather than shown: a marker written into prose is
       still a marker to the stamper. An opening one with no matching close
       makes its regex run to the NEXT close in the file and swallow whatever
       lies between - which is exactly what happened to this span while it was
       being written.) --}}
  <span id="vc-vue-version" hidden><!-- vc:vueAligned -->3.6.0-rc.9<!-- /vc:vueAligned --></span>

  {{-- 3. Vue, as a MODULE. Vapor ships only as `esm-browser` - there is no
          `vue.runtime-with-vapor.global.js` - so a classic <script src> tag
          cannot obtain Vapor at all, and the library's runtime probe cannot
          resolve a bare specifier in a browser. `configureVue()` is therefore
          not optional here; it is the only channel. --}}
  <script type="module">
    const version = document.getElementById('vc-vue-version').textContent.trim();
    const Vue = await import(
      `https://cdn.jsdelivr.net/npm/vue@${version}/dist/vue.runtime-with-vapor.esm-browser.prod.js`
    );

    VaporChamber.configureVue(Vue);

    const { dispatch } = VaporChamber.connect({ endpoint: '/api/vc', csrf: true });

    // A Vapor setup() returns a BLOCK - real DOM nodes. There is no compiler on
    // a no-build page to turn a template into one, and `h` is not on the
    // VaporChamber global in any variant.
    const defined = VaporChamber.defineWidget('vc-cart', {
      setup() {
        const button = document.createElement('button');
        button.textContent = 'Add coffee';
        button.addEventListener('click', async () => {
          button.disabled = true;
          const result = await dispatch('cartAdd', { id: 1 }, { qty: 1 });
          button.disabled = false;
          if (!result.ok) return;
          // Bridge out of the shadow root to whatever the page uses.
          const host = button.getRootNode().host;
          VaporChamber.emitDOMEvent(host, 'cart-added', {
            count: result.value.count,
            lastAdded: result.value.lastAdded,
          });
        });
        return button;
      },
    });

    // The documented sharp edge, made visible rather than silent: the wrapper
    // returns null when Vapor is absent, and `defineWidget` reports that as
    // `false`.
    if (!defined) {
      document.querySelector('.panel').textContent =
        'Vapor was not detected - defineWidget() returned false.';
    }

    let seen = 0;
    const lines = [];
    document.addEventListener('cart-added', (e) => {
      seen++;
      document.getElementById('seen').textContent = String(seen);
      lines.unshift(`cart-added -> count ${e.detail.count} (${e.detail.lastAdded})`);
      document.getElementById('log').textContent = lines.slice(0, 8).join('\n');
    });
  </script>
</body>
</html>
