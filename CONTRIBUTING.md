# Contributing to vapor-chamber

Thanks for considering a contribution. This document covers setting up a dev environment, running the tests and benches, and submitting a PR that is likely to land quickly.

---

## Setup

Requirements:
- Node.js ≥ 22.12.0 (matches `engines.node` in [package.json](./package.json))
- npm 10+ (ships with the Node version above)

```bash
git clone https://github.com/lucianofedericopereira/vapor-chamber.git
cd vapor-chamber
npm install
npm run test:run    # default vitest project; `npm test` runs both projects
npm run build       # tsc + Vite library build + IIFE variants
```

Lockfile drift from `npm install` is expected on a fresh clone; commit the
resulting `package-lock.json` with your PR.

---

## Project layout

```
src/
  command-bus.ts       Core: dispatch, register, plugins, hooks, listeners
  signal.ts            Side-effect-free signal abstraction (no Vue probing)
  chamber.ts           Vue composables + Vapor feature detection
  chamber-vapor.ts     Vue 3.6+ Vapor-specific wrappers
  transports.ts        HTTP / WebSocket / SSE bridges
  http.ts              Multi-method HTTP client (CSRF, interceptors, retry)
  http-cache.ts        Cache layer for the HTTP client
  http-query.ts        Query helpers
  plugins-core.ts      Core plugins (logger, validator, debounce, throttle, ...)
  plugins-extra.ts     Extra plugins (cache, circuitBreaker, rateLimit, metrics)
  plugins-io.ts        I/O plugins (retry, persist, sync)
  plugins.ts           Re-export aggregator
  schema.ts            LLM tool-use layer (toAnthropicTools, toOpenAITools, ...)
  form.ts              Reactive form state
  testing.ts           createTestBus + snapshot/time-travel
  devtools.ts          @vue/devtools-api integration
  directives.ts        v-vc-command directive (vDOM plugin + vcCommandVapor)
  transitions.ts       <Transition> hook -> bus dispatch bridge
  ssr.ts               SSR dehydrate/rehydrate
  vite-hmr.ts          Vite HMR plugin
  iife.ts              IIFE entry - full variant
  iife-core.ts         IIFE entry - sprinkled-JS audience
  iife-elements.ts     IIFE entry - embeddable widgets audience
  index.ts             ESM main entry
  dict.ts              Prototype-free dictionaries (one rule, stated once)
  router/              The router, over a server-owned catch-all
    engine.ts          Navigation: guards, two-phase commit, query fast path
    table.ts           Rows -> compiled table (chains, query defs, matching)
    history.ts         Base-aware web + memory history
    loaders.ts         Loader SPI; presets resolve a row's `load` string
    composables.ts     useRoute / useQueryParam / usePagination / ...
    vdom.ts, vapor.ts  The two RouterOutlet render surfaces (subpath per cost)
  router-fetch/        In-box loader preset for plain JSON backends
tests/                 Vitest suites + perf.bench.ts
tests/vapor/           Second project - needs vitest.vapor.config.ts
scripts/
  build.mjs            Vite programmatic build (ESM library + 3 IIFE variants)
  check-size.mjs       Bundle-size budget guard (IIFE variants only)
  check-doc-claims.mjs Orphaned docblocks, absent documented defaults, release
                       status in comments
  check-ascii.mjs      Plain ASCII, invisible characters included
  stamp-docs.mjs       Republishes generated numbers into prose; --check gates
docs/
  whitepaper.md        Design philosophy + integration patterns
  performance.md       Performance & tuning reference
ROADMAP.md             RC tracking, version policy, feature matrix
```

---

## Workflow

### Before opening a PR

```bash
npm run typecheck      # tsc --noEmit
npm run build          # produces dist/ + prints sizes - BEFORE any test run
npm run test:run       # default vitest project
npm run test:vapor     # second project, `vue` aliased to the with-vapor dist
npm run size:check     # fails if any IIFE variant exceeds its brotli budget
npm run lint:check     # biome + the prose guards (see below)
npm run test:coverage  # 100% statements / branches / functions / lines
```

All seven must pass, and the order is part of the gate:

- **Build before the test runs.** The size, boundary and Vite-plugin guards read
  `dist/` and skip themselves (`describe.skipIf(!haveDist)`) when it is absent, so a
  test run without a build is a partial run that can still print green. One suite
  also reads a file that only `tsc` emits (`dist/router/index.d.ts`).
- **After any change under `src/`, comments included, run `npm run docs`** and
  commit `docs/api/` with the change. The API reference carries source line
  anchors, so a comment that moves a line moves them. Run `npm run size:doc` too
  when a change can move a size row; both must regenerate with no diff.
- **After adding or removing tests, run `npm run docs:stamp` after
  `test:coverage`.** The test-count markers publish only from a built run with
  coverage on, so the `stamp-docs --check` inside `lint:check`, which follows a plain
  `test:run`, cannot see a stale count.

`lint:check` runs more than biome. These guards check what the source *says*
rather than what it does, which a test cannot:
`check-env-guards` (no unguarded `process.env`), `check-console-shape` (a value
with structure is a console ARGUMENT, never a substring of the message; it
classifies by type rather than by a list of names, and `--self-test` injects the
violations into real modules to prove it can still fail), `check-line-citations`
(no source-line numbers in test titles), `check-doc-claims` (no docblock attached
to nothing, no documented default whose value is absent from the file, no release
status in a comment - that belongs in CHANGELOG.md), and `check-ascii` (plain
ASCII, including invisible characters). `stamp-docs --check` fails on a stale
generated number. CI runs the same set on Node 22 and 24, on Linux and macOS.

`test:run` is not the whole suite: `tests/vapor/**` runs only under
`vitest.vapor.config.ts` (it needs `vue` aliased to a build that includes
Vapor; the config header explains why), and the router/vapor outlet's
acceptance guards live there. `npm test` runs both projects back to back.
Run `test:vapor` after `build`, since its size guard measures a real production
bundle.

The `examples/` workspaces sit outside that gate; they build against the
working tree on demand. `examples/exo-astro` needs Node ≥ 22.12 (Astro 7's own
floor); its directive scanner is covered by the repo suite, so `npm test` from
the root does exercise that example's code.

### Performance work

If your change is in a hot path (`command-bus.ts`, `transports.ts`, `chamber.ts`):

1. Add a bench to [tests/perf.bench.ts](./tests/perf.bench.ts) **before** changing
   the code, and capture the baseline numbers.
2. Make your change.
3. Re-run the bench and report the win or regression in the PR description.
4. **Keep a "performance" change only if a bench confirms it.** That is the
   project's rule.

If your change might shift bundle size:

1. Run `npm run build` and note the printed sizes.
2. If the size budget guard (`npm run size:check`) fails and the increase is
   intentional, update `BUDGETS` in [scripts/check-size.mjs](./scripts/check-size.mjs)
   and explain why in the PR description.

### Code style

- Biome handles linting. Run `npm run lint` to auto-fix; CI runs `lint:check`.
- TypeScript strict mode is on. No `any` leaks at the public API boundary; internal `any` is fine where the alternative is verbose generics.
- Comments are sparse by design - write them when the *why* is non-obvious (a hidden constraint, an invariant, a workaround for a specific bug). Don't paraphrase the code.
- No emojis in source files. In CHANGELOG and docs, use them sparingly and only when explicitly asked.
- Tests live next to the module they exercise (`src/foo.ts` <-> `tests/foo.test.ts`). Cross-cutting concerns get their own file.

### Module discipline

Rules that apply across modules, each one written down because it was learned
the expensive way:

- **A subpath is named for what it costs.** It gets its own measured row in
  `docs/BUNDLE-SIZES.md` and a boundary fixture in the `vdom-boundary.test.ts`
  shape. A subpath that imports nothing the core lacks isolates nothing and
  should not exist. Minting one also adds a build entry, which re-chunks shared
  code and has moved an unrelated size guard.
- **Cleanup is `onScopeDispose` only**, gated on `hasInjectionContext()` where a
  gate is needed. `getCurrentInstance()` returns null in Vapor by design, and
  upstream has confirmed that is permanent, so never branch on it.
- **Errors are coded taxonomies per module**, and tests switch on `code`, never
  on message text.
- **Performance claims are interleaved A/B on the real path**, with derived
  baselines and a control row. No committed bench, no claim in the docs. An
  isolated loop is not evidence - a loop-invariant read gets hoisted and the
  number is garbage.
- **External strings are never keys on `{}`** (`src/dict.ts`): store ids, state
  keys, command patterns and query params all read via `Object.hasOwn`. This
  class has been found at six sites so far.
- **A number a human retypes is a number that drifts.** Anything a run can
  compute belongs to a `vc:` marker fed by `scripts/stamp-docs.mjs`, not to
  prose. `CHANGELOG.md` is the deliberate exception: it is history, and its
  numbers must stay frozen at what was true for that release.

---

## Releasing (maintainer-only)

1. Update [CHANGELOG.md](./CHANGELOG.md) with a new section for the release.
2. Bump `version` in [package.json](./package.json).
3. Commit: `release: vX.Y.Z`.
4. Tag: `git tag vX.Y.Z && git push --tags`.
5. `npm publish`. The `prepublishOnly` script runs the seven gates of "Before opening a PR"
   in that order (build before either test project, coverage last), and all must pass.
6. GitHub release notes copy the CHANGELOG section verbatim.

A breaking change to a surface documented as stable needs a major; before Vue 3.6 stable, experimental surfaces take breaking changes in minors (ROADMAP, "Version policy before 3.6 stable"). Variant *contents* of the IIFE bundles are explicitly not under semver before v2.0; see [ROADMAP.md](./ROADMAP.md). The ESM main entry follows strict semver.

---

## Reporting bugs

- A reproduction as a minimal failing test in `tests/`. A PR that adds the failing test, even without a fix, is a useful contribution by itself.
- Vue version, Node version, OS, and which IIFE variant (if applicable).
- Browser if the issue is browser-specific.

For security issues, see [SECURITY.md](./SECURITY.md) - do not open a public
issue.

---

## Areas where contributions are welcome

See [ROADMAP.md](./ROADMAP.md) for the strategic plan. Concrete near-term items where help is appreciated:

- Comparative benchmarks vs RxJS Subject, Pinia.
- Real-world integration examples in `examples/` (Rails, Django).
- Additional `examples/` for the IIFE variants - embeddable widget, CDN-only Blade page.
- TypeDoc -> static API reference site (target: `vapor-chamber.dev` or similar).
- A migration guide from Vuex.

---

## License

By contributing you agree your contributions will be licensed under the LGPL-2.1 license used by the rest of the project. See [LICENSE](./LICENSE).