# 12. Sizes and tuning

This chapter reads what each entry costs and tunes the library for speed or memory. How speed is
measured, and the knobs in depth, are in [performance.md](../performance.md).

## Read the bundle sizes

Minified, comment-free, brotli q=11. The always-current per-export table is
**[docs/BUNDLE-SIZES.md](../BUNDLE-SIZES.md)** (`npm run size:doc`). `npm run size:check`
fails CI on any regression past budget.

The two that matter: the dispatch core is **<!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB**, and the import-everything barrel
is <!-- vc:sizeBarrel -->48.5<!-- /vc:sizeBarrel --> KB.

### The main entries

| Entry | brotli |
|---|--:|
| dispatch core (`createCommandBus`, tree-shaken) | **<!-- vc:sizeCore -->6.1<!-- /vc:sizeCore --> KB** |
| `vapor-chamber` (main barrel, import-*everything*) | <!-- vc:sizeBarrel -->48.5<!-- /vc:sizeBarrel --> KB |
| `vapor-chamber/router` | <!-- vc:sizeRouter -->11.3<!-- /vc:sizeRouter --> KB |
| `vapor-chamber/router/vdom` | <!-- vc:sizeRouterVdom -->0.7<!-- /vc:sizeRouterVdom --> KB |
| `vapor-chamber/router/vapor` | <!-- vc:sizeRouterVapor -->0.7<!-- /vc:sizeRouterVapor --> KB |
| `vapor-chamber/router/remote` | <!-- vc:sizeRouterRemote -->6.6<!-- /vc:sizeRouterRemote --> KB |
| `vapor-chamber/router-fetch` | <!-- vc:sizeRouterFetch -->6.9<!-- /vc:sizeRouterFetch --> KB |
| `vapor-chamber/vue` (with the root's surface, import-*everything*) | <!-- vc:sizeVue -->48.6<!-- /vc:sizeVue --> KB |
| `vapor-chamber/vapor` (the same) | <!-- vc:sizeVapor -->48.7<!-- /vc:sizeVapor --> KB |
| `vapor-chamber/reactive` | <!-- vc:sizeReactive -->0.5<!-- /vc:sizeReactive --> KB |
| `vapor-chamber/transports` | <!-- vc:sizeTransports -->12.1<!-- /vc:sizeTransports --> KB |
| `vapor-chamber/outbox` | <!-- vc:sizeOutbox -->6.1<!-- /vc:sizeOutbox --> KB |
| `vapor-chamber/mcp` | <!-- vc:sizeMcp -->1.8<!-- /vc:sizeMcp --> KB |
| `vapor-chamber/ssr` | <!-- vc:sizeSsr -->1.0<!-- /vc:sizeSsr --> KB |
| `vapor-chamber/store` | <!-- vc:sizeStore -->5.8<!-- /vc:sizeStore --> KB |

**Rows are not additive.** Every row includes the shared core, which your bundle carries once.
The `/vue` and `/vapor` rows include the whole root they carry. An app pays only for what it
imports.[^one-import] `vapor-chamber` is the barrel measured import-everything, and your bundler
drops what you do not use.

[^one-import]: One import from `/vapor` builds `examples/vapor-sfc` to the same bytes as two (log s35.236).

These figures are **machine-stamped** from [docs/BUNDLE-SIZES.md](../BUNDLE-SIZES.md), the
generated source of truth (`npm run size:doc`). `npm run docs:stamp` republishes its rows here,
and `lint:check` fails on a stale one. A number a human retypes drifts, so none is retyped.

## Choose speed or memory

`vaporChamberWire({ profile: 'lean' })` trades speed for memory. The default, `'performance'`,
trades memory for speed. The choice folds out of the build, so it costs nothing per call. On
esbuild or webpack, define `__VC_LEAN__` yourself. The trade is in the whitepaper, section 7.3.

## Use the tuning knobs

- `configureUid(fn)` swaps the unique-ID generator, for example to `crypto.randomUUID()` for
  distributed tracing.
- `configureSignal(fn)` brings your own signal.
- `vapor-chamber/alien-signals` gives push-pull reactivity outside Vue.
- `createFastLane()` (`vapor-chamber/fast-lane`) is a dispatcher for real hot loops, with no
  envelope, result or plugins.

Each is described in [performance.md](../performance.md), "Tuning knobs" and "Two doorways".

Next: [13. Examples](./13-examples.md).
