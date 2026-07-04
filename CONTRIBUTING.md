# Contributing to vapor-chamber

Thanks for considering a contribution. This document covers what you need to get a working dev environment, run tests/benches, and submit a PR that has a good chance of landing quickly.

---

## Setup

Requirements:
- Node.js ≥ 20.19.0 (matches `engines.node` in [package.json](./package.json))
- npm 10+ (ships with the Node version above)

```bash
git clone https://github.com/lucianofedericopereira/vapor-chamber.git
cd vapor-chamber
npm install
npm run test:run    # full test suite, ~4s
npm run build       # tsc + Vite library build + IIFE variants
```

If `npm install` produces lockfile drift, that's expected on a fresh clone —
commit the resulting `package-lock.json` with your PR.

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
  plugins-core.ts      Core plugins (logger, validator, debounce, throttle, …)
  plugins-extra.ts     Extra plugins (cache, circuitBreaker, rateLimit, metrics)
  plugins-io.ts        I/O plugins (retry, persist, sync)
  plugins.ts           Re-export aggregator
  schema.ts            LLM tool-use layer (toAnthropicTools, toOpenAITools, …)
  form.ts              Reactive form state
  testing.ts           createTestBus + snapshot/time-travel
  devtools.ts          @vue/devtools-api integration
  directives.ts        v-vc:command directive (VDOM-only)
  transitions.ts       <Transition> hook → bus dispatch bridge
  ssr.ts               SSR dehydrate/rehydrate
  vite-hmr.ts          Vite HMR plugin
  iife.ts              IIFE entry — full variant
  iife-core.ts         IIFE entry — sprinkled-JS audience
  iife-elements.ts     IIFE entry — embeddable widgets audience
  index.ts             ESM main entry
tests/                 Vitest suites + perf.bench.ts
scripts/
  build.mjs            Vite programmatic build (ESM library + 3 IIFE variants)
  check-size.mjs       Bundle-size budget guard
docs/
  whitepaper.md        Design philosophy + integration patterns
  performance.md       Performance & tuning reference
ROADMAP.md             Beta tracking + v1.3 / v2 plan
```

---

## Workflow

### Before opening a PR

```bash
npm run typecheck     # tsc --noEmit
npm run lint:check    # biome check
npm run test:run      # full test suite
npm run build         # produces dist/ + prints sizes
npm run size:check    # fails if any IIFE variant exceeds its brotli budget
```

All five must pass. CI runs the same set on Node 20 and 22, on Linux and macOS.

### Performance work

If your change is in a hot path (`command-bus.ts`, `transports.ts`, `chamber.ts`):

1. Add a bench to [tests/perf.bench.ts](./tests/perf.bench.ts) **before** changing
   the code, and capture the baseline numbers.
2. Make your change.
3. Re-run the bench. Document the win/regression in the PR description.
4. **Do not ship a "performance" change that doesn't show up in a bench.**
   The project's rule is: only keep changes that benches confirm.

If your change might shift bundle size:

1. Run `npm run build` and note the printed sizes.
2. If the size budget guard fails, decide: is the increase intentional? If
   yes, update `BUDGETS` in [scripts/check-size.mjs](./scripts/check-size.mjs)
   and explain in the PR description.

### Code style

- Biome handles linting. Run `npm run lint` to auto-fix; CI runs `lint:check`.
- TypeScript strict mode is on. No `any` leaks at the public API boundary; internal `any` is fine where the alternative is verbose generics.
- Comments are sparse by design — write them when the *why* is non-obvious (a hidden constraint, an invariant, a workaround for a specific bug). Don't paraphrase the code.
- No emojis in source files. Sparingly in CHANGELOG / docs if explicitly asked.
- Tests live next to the module they exercise (`src/foo.ts` ↔ `tests/foo.test.ts`). Cross-cutting concerns get their own file.

---

## Releasing (maintainer-only)

1. Update [CHANGELOG.md](./CHANGELOG.md) with a new section for the release.
2. Bump `version` in [package.json](./package.json).
3. Commit: `release: vX.Y.Z`.
4. Tag: `git tag vX.Y.Z && git push --tags`.
5. `npm publish` (the `prepublishOnly` script runs typecheck, lint, tests, build, and size guard — all must pass).
6. GitHub release notes copy the CHANGELOG section verbatim.

Breaking changes only land in major versions. Variant *contents* of the IIFE bundles are explicitly not under semver before v2.0 — see [ROADMAP.md](./ROADMAP.md). ESM consumers (the main entry) obey strict semver.

---

## Reporting bugs

- Reproduction case as a minimal failing test in `tests/`. PRs welcome that add the failing test even without a fix — that's a useful contribution by itself.
- Vue version, Node version, OS, and which IIFE variant (if applicable).
- Browser if the issue is browser-specific.

For security issues, see [SECURITY.md](./SECURITY.md) — do not open a public
issue.

---

## Areas where contributions are welcome

See [ROADMAP.md](./ROADMAP.md) for the strategic plan. Concrete near-term items where help is appreciated:

- Comparative benchmarks vs `mitt`, `nano-events`, RxJS Subject, Pinia.
- Real-world integration examples in `examples/` (Rails, Django, Laravel).
- Additional `examples/` for the IIFE variants — embeddable widget, CDN-only Blade page.
- TypeDoc → static API reference site (target: `vapor-chamber.dev` or similar).
- Migration guides from `mitt` / `event-emitter` / Vuex.

---

## License

By contributing you agree your contributions will be licensed under the LGPL-2.1 license used by the rest of the project. See [LICENSE](./LICENSE).