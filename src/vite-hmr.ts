/**
 * vapor-chamber - Vite plugins: HMR (serve) and build-time Vue wiring (build)
 *
 * v1.20.0 - CHANGED (same release, later): `vaporChamberWire()` also runs under the dev server,
 *           where it only defines `__VC_WIRED__`. chamber.ts's DEV probe-path
 *           hint reads it, so a plugin user is no longer told to change imports
 *           the plugin already wires in the build. The redirect stays
 *           build-only, now on a measurement: over a pre-bundled install, a
 *           dev-time redirect put two chamber modules in the page. See the
 *           function's note.
 * v1.20.0 - ADDED: `vaporChamberWire()`, a second plugin, build-only. It
 *           resolves the bare 'vapor-chamber' specifier to a virtual module
 *           that imports 'vapor-chamber/vue' (or '/vapor') for its side effect
 *           and re-exports the real root, so an app importing its composables
 *           from the root is wired in production with no import changed (H1).
 *           Kept apart from `vaporChamberHMR`, which stays serve-only and
 *           unchanged: one runs where the probe cannot resolve, the other
 *           where it can. See the function's own note for the shape and why
 *           it does not run under the dev server.
 * v1.19.0 - CODE CHANGE, and the first one this file's own tests could not
 *           have found. The transform claimed `.vue` and `.vapor.vue` and had
 *           never delivered a shim to either: `enforce: 'pre'` puts it ahead of
 *           @vitejs/plugin-vue, so it prepended its import to RAW SFC text,
 *           where the block outside every block is discarded by compiler-sfc
 *           without a diagnostic. Proven against the real dev pipeline, not the
 *           unit fixture: `transformRequest('/src/CartPanel.vue')` on
 *           examples/vapor-sfc returns byte-identical output with this plugin
 *           and without it. SFCs are now skipped, and the fixture that
 *           "covered" them (a script fragment under a `.vapor.vue` id, which no
 *           SFC produces) is replaced by one that runs compiler-sfc.
 *           The same pass retired `lineShiftMap`: it fixed a one-line offset
 *           and, unmeasured, flattened every chained downstream map onto column
 *           zero. Injecting on the SAME line moves no line, so Vite's identity
 *           default is correct and the map is gone. See transform() for the
 *           three-way mappings measurement.
 * v1.17.0 - Vue 3.6.0-rc.6 HMR alignment. NO CODE CHANGE; two upstream fixes
 *           land underneath this shim and both are recorded because they change
 *           what a hot reload does to a bus, not what this plugin does.
 *           - per-render EffectScope (runtime-vapor: own each dev render
 *             generation with a render scope for HMR, 9ab65a1) - an HMR rerender
 *             now tears down child components mounted INSIDE an element, which
 *             the parent's block graph cannot reach and which previously stayed
 *             alive. Those children's setup() scopes are what `useCommand()`
 *             hangs its cleanup on, so before rc.6 every hot reload left the old
 *             generation's `on()` listeners subscribed to the bus this plugin
 *             preserves across the reload - measured on rc.5, one dispatch fired
 *             a listener once per generation ever rendered. The preserved bus is
 *             precisely what made the leak accumulate rather than vanish with a
 *             fresh bus, so it is this plugin's business even though the fix is
 *             upstream and needs nothing here.
 *             Fixture: tests/hmr-render-scope-fixture.test.ts.
 *           - hmr updating flag hygiene (hmr: cover vapor fast-path reload with
 *             the hmr updating flag and reset it on failed updates, 991a885) -
 *             a FAILED update now resets `isHmrUpdating` immediately instead of
 *             leaving it set forever. This corroborates the v1.5.0 decision
 *             below to wrap bus persistence in try/catch: upstream reached the
 *             same "a failed HMR pass must not leave global state latched"
 *             conclusion for its own flag.
 * v1.6.0 - CODE CHANGE: the injected shim now primes globalThis.__VUE__ from the
 *           consumer's 'vue' (via a companion virtual module that evaluates before
 *           'vapor-chamber') so the lib's synchronous Vue/Vapor detection works in
 *           Vite dev. Before this, the shim's top-of-module injection guaranteed
 *           vapor-chamber evaluated before any user code could prime detection, and
 *           the async probe (bare-specifier dynamic import) always fails in
 *           browsers - so createVaporChamberApp() threw on every dev page load
 *           whenever this plugin was active. Found by browser-verifying the
 *           vapor-sfc example. Non-Vue consumers unaffected (the priming module is
 *           emitted only when 'vue' resolves).
 * v1.5.0 - Vue 3.6.0-beta.14 HMR alignment:
 *           - dedupe HMR parent reloads (hmr: dedupe HMR parent reloads) - Vue now
 *             deduplicates parent reload events at the runtime level; the dispose
 *             shim mirrors this with a per-cycle guard so the bus is persisted at
 *             most once per HMR update regardless of how many parent reload events
 *             fire.
 *           - align child/parent reload timing (hmr: align child component HMR
 *             reload with parent rerender) - child component HMR reload is now
 *             synchronised with the parent rerender; bus restoration happens after
 *             the full parent subtree has settled.
 *           - preserve setup effects (runtime-vapor: preserve setup effects during
 *             hmr rerender) - watchers and computed effects created in setup() are
 *             maintained across HMR rerenders; bus handlers registered via
 *             watchEffect inside setup() survive a hot reload without re-registration.
 *           - restore HMR context on errors (runtime-vapor: restore hmr context on
 *             errors) - HMR context is recovered when an error occurs mid-reload;
 *             the shim wraps bus persistence in try/catch so a failed getCommandBus()
 *             call doesn't leave the module in an unrecoverable state.
 *           - update app instance on root reload (runtime-vapor: update app instance
 *             on root hmr reload) - the app instance on the root component is
 *             refreshed after a root HMR cycle; callers of createVaporChamberApp()
 *             no longer need to re-acquire the app reference after a root reload.
 * v1.1.0 - Vapor<->VDOM mode switching: tracks __vapor state during HMR reloads
 *           so components switching between Vapor and VDOM modes preserve bus state.
 * v0.5.0 - State-preserving hot module replacement.
 *
 * Preserves the shared command bus (handlers, plugins, hooks) across Vite HMR
 * updates so that application state survives component hot-reloads.
 *
 * Without this plugin, each HMR update re-creates the bus from scratch,
 * clearing all registered handlers and registered state.
 *
 * Tested against:
 *   - Vite >= 7.0.0 (programmatic build API + library mode)
 *   - @vitejs/plugin-vue >= 5.0.0 (Vue 3.6 Vapor SFC support - earlier
 *     plugin-vue versions only handle 3.5 VDOM and silently skip vapor blocks)
 *   - Vue >= 3.5.0 (composables) or >= 3.6.0-beta.14 (full Vapor surface)
 *
 * If you're on plugin-vue v4 the HMR plugin still works for VDOM SFCs but
 * you'll miss Vapor support entirely - Vapor `<script setup vapor>` blocks
 * fall back to the VDOM compiler. Upgrade plugin-vue alongside Vue 3.6.
 *
 * @example
 * // vite.config.ts
 * import { defineConfig } from 'vite'
 * import vue from '@vitejs/plugin-vue'
 * import { vaporChamberHMR } from 'vapor-chamber/vite'
 *
 * export default defineConfig({
 *   plugins: [vue(), vaporChamberHMR()]
 * })
 *
 * @example
 * // main.ts - no changes required; HMR is transparent
 * import { createCommandBus } from 'vapor-chamber'
 * const bus = createCommandBus()
 * bus.register('cartAdd', handler)
 * // After HMR: handler is still registered, state is preserved
 */

export type VaporChamberHMROptions = {
  /**
   * Virtual module ID used to share the bus instance across HMR boundaries.
   * Default: 'virtual:vapor-chamber-hmr'
   */
  moduleId?: string;
  /**
   * Enable verbose logging of HMR events.
   * Default: false
   */
  verbose?: boolean;
};

// The global symbol used to persist the bus across HMR updates in the browser.
const HMR_GLOBAL_KEY = '__VAPOR_CHAMBER_BUS__';
// The slot the library reads a hand-supplied Vue namespace from. Duplicated
// from chamber.ts VUE_GLOBAL_KEY rather than imported: this plugin runs in
// Vite's Node process and must not pull the Vue-detection module (and its
// module-load probe) into a build tool. Kept in sync by
// tests/vite-hmr.test.ts, which asserts the emitted module names this key.
const VUE_GLOBAL_KEY = '__VAPOR_CHAMBER_VUE__';
// Track whether the last active component was Vapor or VDOM - used for mode switch detection.
const HMR_MODE_KEY = '__VAPOR_CHAMBER_MODE__';

/**
 * Matches an actual `import`/`export ... from 'vapor-chamber...'` (or a
 * `require`/dynamic `import()` of one) rather than the bare substring
 * 'vapor-chamber' - which also hits comments, string literals and this
 * library's own doc blocks.
 */
const IMPORTS_VAPOR_CHAMBER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]vapor-chamber(?:\/[^'"]*)?['"]/;

/**
 * vaporChamberHMR - Vite plugin for state-preserving hot reload.
 *
 * Injects a small runtime shim that:
 * 1. Stores the command bus on `globalThis[HMR_GLOBAL_KEY]` after creation.
 * 2. On HMR accept, restores the previously stored bus instance instead of
 *    creating a new one - preserving all registered handlers and plugins.
 */
export function vaporChamberHMR(options: VaporChamberHMROptions = {}): any {
  const { verbose = false } = options;
  const virtualModuleId = options.moduleId ?? 'virtual:vapor-chamber-hmr';
  const resolvedVirtualModuleId = '\0' + virtualModuleId;
  // Vue-priming companion module - see load() below for why it must exist.
  const primeModuleId = virtualModuleId + '-vue-prime';
  const resolvedPrimeModuleId = '\0' + primeModuleId;

  return {
    name: 'vapor-chamber-hmr',
    enforce: 'pre' as const,
    // Vite's own dev-only mechanism, and strictly stronger than the
    // `process.env.NODE_ENV` check in `transform` below: NODE_ENV can be
    // anything under `--mode staging` or a programmatic build that never sets
    // it, and if that check misses, the shim + virtual module + the
    // `globalThis` bus-persistence keys ship in the production bundle. This
    // one property cannot be fooled - the plugin simply does not run on build.
    apply: 'serve' as const,

    resolveId(id: string) {
      if (id === virtualModuleId) return resolvedVirtualModuleId;
      if (id === primeModuleId) return resolvedPrimeModuleId;
    },

    /**
     * The transform below can only reach an app THROUGH its own source, so an
     * app whose entry script never names the package - every bus call living in
     * SFCs, `main.ts` doing nothing but `createApp(App).mount()` - got no shim
     * at all, and its bus was rebuilt from scratch on every hot reload. That was
     * true of the SFC path in general until this release; it is now true only of
     * this narrower case, which no amount of module matching can fix.
     *
     * An HTML entry can, because Vite hands it to us directly. `head-prepend`
     * puts the tag ahead of the app's own module script, and module scripts run
     * in document order, so the shim (and the Vue priming it imports) evaluates
     * first - which is the ordering the whole design already depends on.
     *
     * `__x00__` is Vite's own encoding of the `\0` virtual-module prefix: it is
     * character-for-character what Vite writes when it rewrites this same import
     * inside a module, so this borrows the encoding rather than inventing one.
     *
     * Additive, not a replacement. An app served through Blade or any other
     * backend template never sends its HTML through Vite, so the transform stays
     * the general path. Double injection is free: a virtual module is a
     * singleton in the graph and evaluates once however many importers it has.
     */
    transformIndexHtml() {
      return [{
        tag: 'script',
        attrs: { type: 'module', src: `/@id/__x00__${virtualModuleId}` },
        injectTo: 'head-prepend' as const,
      }];
    },

    async load(id: string) {
      // -- Vue-priming module ----------------------------------------------
      // The HMR shim import is injected at the TOP of every transformed
      // module, so vapor-chamber evaluates before ANY user code - including
      // any user attempt to set globalThis.__VUE__. And in the browser the
      // lib's async probe (a `@vite-ignore`-annotated `import('vue')`) is a bare
      // specifier import that always fails without an import map. Net effect
      // (pre-v1.6.0): with this plugin active, Vue/Vapor detection could
      // NEVER succeed in Vite dev - createVaporChamberApp() threw on every
      // dev page load. This module fixes it at the right layer: it sets
      // globalThis.__VUE__ from the consumer's own 'vue' BEFORE the shim
      // imports 'vapor-chamber' (its module body runs first in DFS order),
      // so the lib's synchronous probe finds the real Vue module - alias
      // and all. Emitted only when 'vue' resolves, so non-Vue Vite apps
      // using this plugin are unaffected.
      if (id === resolvedPrimeModuleId) {
        const vueResolved = await (this as any).resolve?.('vue');
        if (!vueResolved) return 'export {};';
        // Writes the library-owned slot, not Vue's `__VUE__`. Vue assigns the
        // boolean `true` to `__VUE__` when the first app is created, so a
        // namespace parked there is replaced on mount - and writing Vue's own
        // key means fighting Vue over the value's type for no gain. The
        // library reads its own slot first (chamber.ts VUE_GLOBAL_KEY).
        return `
// vapor-chamber HMR shim - Vue priming (must evaluate before 'vapor-chamber')
import * as __VC_VUE__ from 'vue';
if (!globalThis.${VUE_GLOBAL_KEY} || typeof globalThis.${VUE_GLOBAL_KEY}.ref !== 'function') {
  globalThis.${VUE_GLOBAL_KEY} = __VC_VUE__;
}
export {};
        `.trim();
      }

      if (id !== resolvedVirtualModuleId) return;

      // This module is injected into the app bundle.
      // It patches setCommandBus/getCommandBus to persist across HMR.
      return `
// vapor-chamber HMR shim - injected by vaporChamberHMR() Vite plugin
import '${primeModuleId}';
import { getCommandBus, setCommandBus, resetCommandBus, isVaporAvailable } from 'vapor-chamber';

const KEY = '${HMR_GLOBAL_KEY}';
const MODE_KEY = '${HMR_MODE_KEY}';

// On first load: store current bus and mode in globalThis
if (typeof globalThis[KEY] === 'undefined') {
  globalThis[KEY] = getCommandBus();
  globalThis[MODE_KEY] = isVaporAvailable() ? 'vapor' : 'vdom';
} else {
  // On HMR reload: restore the preserved bus
  setCommandBus(globalThis[KEY]);
  // Detect vapor<->vdom mode switch (Vue 3.6.0-beta.10 tracks __vapor state)
  const prevMode = globalThis[MODE_KEY];
  const currMode = isVaporAvailable() ? 'vapor' : 'vdom';
  if (prevMode !== currMode) {
    globalThis[MODE_KEY] = currMode;
    ${verbose ? "console.log('[vapor-chamber] HMR: mode switched from ' + prevMode + ' to ' + currMode + ', bus preserved');" : ''}
  } else {
    ${verbose ? "console.log('[vapor-chamber] HMR: restored bus from previous module');" : ''}
  }
}

// Accept HMR updates for the entire app module tree without full reload
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    // Beta.14: clear the per-cycle dedup flag so dispose can run on the next update.
    import.meta.hot.data.__vc_disposed = false;
    ${verbose ? "console.log('[vapor-chamber] HMR: module updated, bus preserved');" : ''}
  });

  // On dispose, persist the current bus and mode for the next module version.
  // Beta.14: guarded to run at most once per HMR cycle (dedupe HMR parent reloads).
  // Wrapped in try/catch so a mid-reload error doesn't leave the module unrecoverable
  // (runtime-vapor: restore hmr context on errors).
  import.meta.hot.dispose((data) => {
    if (data.__vc_disposed) return;
    data.__vc_disposed = true;
    try {
      globalThis[KEY] = getCommandBus();
      globalThis[MODE_KEY] = isVaporAvailable() ? 'vapor' : 'vdom';
    } catch (_) {
      // Preserve whatever was last stored - do not overwrite with a failed read.
    }
    ${verbose ? "console.log('[vapor-chamber] HMR: bus persisted for next reload');" : ''}
  });
}

export { getCommandBus, setCommandBus, resetCommandBus };
      `.trim();
    },

    // Transform: inject the HMR shim into every module that imports
    // vapor-chamber. (The comment here used to say "only the app entry" while
    // the predicate matched every non-node_modules file mentioning the
    // package - harmless at runtime, since the module graph dedupes the
    // virtual import, but it described a different design. The predicate is
    // now an IMPORT match rather than a substring one, so a passing mention in
    // a comment or a string literal no longer pulls the shim in.)
    transform(code: string, id: string) {
      // `apply: 'serve'` above is the real production guard; this stays as a
      // belt-and-braces check for anyone invoking the transform directly.
      if (process.env.NODE_ENV === 'production') return;
      if (!IMPORTS_VAPOR_CHAMBER.test(code)) return;
      if (id.includes('node_modules')) return;
      if (id.includes(resolvedVirtualModuleId)) return;
      // SCRIPTS ONLY. `.vue` and `.vapor.vue` used to be in this list, and the
      // injection into them never once reached the browser: this plugin is
      // `enforce: 'pre'`, so it runs BEFORE @vitejs/plugin-vue and sees the raw
      // SFC text. Prepending an import there puts it outside every block, and
      // compiler-sfc discards top-level text without a word. Verified against
      // the real dev pipeline on examples/vapor-sfc - `transformRequest` output
      // for CartPanel.vue is byte-identical with this plugin and without it.
      //
      // The test that "covered" the case handed the transform a bare script
      // fragment under a `.vapor.vue` id, so it asserted on a string that no
      // SFC would ever produce. Same bug class as every mocked integration in
      // this repo's history: the fixture agreed with the code instead of with
      // Vite. tests/vite-hmr.test.ts now runs a real SFC through plugin-vue.
      //
      // Nothing is lost by dropping them, because nothing was ever gained. The
      // shim reaches the graph through the entry script, and the virtual module
      // is a singleton, so one import anywhere is the whole mechanism.
      if (!id.match(/\.(ts|js|tsx|jsx)$/)) return;

      // Avoid double-injection
      if (code.includes(virtualModuleId)) return;

      // SAME LINE, deliberately, and with no sourcemap.
      //
      // This prepended a whole line and returned a hand-built one-line shift
      // map, on the correct reasoning that `map: null` means "no mapping
      // information" to Vite, which reads it as identity - so a prepended LINE
      // silently moved every stack frame, breakpoint and overlay location down
      // by one. What that fix cost went unmeasured: a line-shift map can only
      // say "output line N came from source line N-1, column 0", and Vite
      // CHAINS maps, so every downstream map's column detail collapsed onto
      // column 0. Measured on examples/vapor-sfc, mappings length:
      //
      //                          src/main.ts     src/CartPanel.vue
      //   vue() alone               92                816
      //   with the shift map        37                165   (columns gone)
      //   with this               101                816   (baseline restored)
      //
      // Injecting on the SAME line moves no line at all, so plain identity is
      // exactly right for every line, and for every column except those on
      // line 1, which shift right by the length of the import. That is a
      // strictly smaller error than the one the shift map was fixing, and it
      // costs neither a map nor a VLQ encoder.
      const injected = `import '${virtualModuleId}';`;
      return { code: `${injected}${code}` };
    },
  };
}

// ---------------------------------------------------------------------------
// vaporChamberWire - build-time Vue wiring for apps that import the root
// ---------------------------------------------------------------------------

export type VaporChamberWireOptions = {
  /**
   * Which static entry wires Vue into the root. `'vue'` (the default) wires
   * the Vue 3.5-safe primitives and the `@vue/reactivity` tracking pair, the
   * same as importing `vapor-chamber/vue`. `'vapor'` wires that plus
   * `createVaporApp`, `defineVaporComponent` and `defineVaporAsyncComponent`,
   * the same as importing `vapor-chamber/vapor` - pick it when the app
   * compiles `<script setup vapor>` SFCs.
   *
   * The choice is yours on purpose. The plugin does not inspect
   * @vitejs/plugin-vue to guess it: `'vapor'` puts the Vapor runtime in the
   * bundle, which a vDOM-only Vue 3.6 app should not pay for, and a guess
   * would decide that cost for you.
   */
  entry?: 'vue' | 'vapor';
};

/**
 * Prefix of the virtual "wired root" module. The real root's resolved id is
 * appended, so two copies of the package in one graph (a monorepo, a linked
 * checkout) each get their own wired root instead of sharing a guess.
 */
const WIRED_ROOT_PREFIX = '\0vapor-chamber:wired-root:';

/**
 * vaporChamberWire - make root imports production-correct in a Vite build.
 *
 * The package root must work with no Vue in the tree, so it reaches Vue
 * through a runtime lookup that resolves under a dev server and cannot resolve
 * in a production bundle. An app importing its composables from the root
 * therefore ships them without reactivity, cleanup or the KeepAlive guard -
 * which `warnUnwired()` in chamber.ts now reports once at runtime, and which
 * `vapor-chamber/vue` / `vapor-chamber/vapor` fix by being imported instead.
 *
 * This plugin fixes it without changing an import. It resolves the bare
 * `vapor-chamber` specifier - from every importer: scripts, compiled SFCs, the
 * HMR shim - to a virtual module whose whole body is
 *
 *     import 'vapor-chamber/vue';            // or /vapor
 *     export * from '<the real root>';
 *
 * so the static entry's wiring is in the graph wherever the root is, and the
 * real root is reached by its resolved id (`this.resolve(..., { skipSelf })`),
 * which is what keeps the redirect from resolving to itself.
 *
 * A redirect of `vapor-chamber` straight to `vapor-chamber/vue` would not
 * work: the root also exports the bus, plugins, transports and the HTTP
 * client, and the Vue entries deliberately do not.
 *
 * THE REDIRECT IS BUILD ONLY, on a measurement. Under the dev server the
 * runtime lookup resolves by itself, so there is nothing to fix - and a
 * redirect there splits the library. With the package installed (so Vite's
 * optimizer pre-bundles it), the wired root's `export *` reaches the
 * pre-bundled root while its `import 'vapor-chamber/vue'` is served
 * unbundled: the optimizer never pre-bundles an import made from a module
 * filed under node_modules, which a virtual module carrying the real root's
 * path is. Two chamber modules, and the wiring lands on the one the app does
 * not use. The documented pattern (bus from the root, composables from /vue)
 * stays at one. tests/vite-wire-plugin.test.ts pins both counts on a real dev
 * server.
 *
 * Under serve the plugin does one thing instead: it defines `__VC_WIRED__`.
 * chamber.ts's DEV probe-path hint reads it and stays quiet, because its
 * advice - import from `vapor-chamber/vue` - is what this plugin already does
 * to the build. The define arrives as a GLOBAL (Vite leaves dependency code
 * untouched in dev; its client env module assigns every define to
 * `globalThis`, and vitest does the same in its test runtime), so it is read
 * wherever those run. It does not reach SSR with the package externalized -
 * measured; Node loads the dist as it is. No `apply` for that reason: Vite
 * drops a plugin before its `config` hook runs, and the dev half lives there.
 * `vaporChamberHMR()` is unchanged and still serve-only; the two compose.
 *
 * Costs nothing in the library (it runs in Vite's process and is never
 * bundled into an app). What it adds to an app is exactly what importing the
 * static entry adds. Pinned by tests/vite-wire-plugin.test.ts, which runs a
 * real Vite build of a root-only consumer with and without it.
 *
 * @example
 * // vite.config.ts
 * import vue from '@vitejs/plugin-vue';
 * import { vaporChamberWire } from 'vapor-chamber/vite';
 *
 * export default defineConfig({
 *   plugins: [vue(), vaporChamberWire({ entry: 'vapor' })],
 * });
 */
export function vaporChamberWire(options: VaporChamberWireOptions = {}): any {
  const wiring = options.entry === 'vapor' ? 'vapor-chamber/vapor' : 'vapor-chamber/vue';
  // Set by `config`, which Vite calls before any resolve hook runs.
  let serve = false;

  return {
    name: 'vapor-chamber-wire',
    enforce: 'pre' as const,

    config(_config: unknown, env: { command: 'build' | 'serve' }) {
      serve = env.command === 'serve';
      return serve ? { define: { __VC_WIRED__: 'true' } } : undefined;
    },

    async resolveId(this: any, id: string, importer: string | undefined) {
      if (serve || id !== 'vapor-chamber') return;
      const real = await this.resolve(id, importer, { skipSelf: true });
      // Unresolvable, or the consumer made the package external (a library
      // build): leave it alone - there is no graph here to wire into.
      if (!real || real.external) return;
      return WIRED_ROOT_PREFIX + real.id;
    },

    load(id: string) {
      if (!id.startsWith(WIRED_ROOT_PREFIX)) return;
      const real = id.slice(WIRED_ROOT_PREFIX.length);
      return `import '${wiring}';\nexport * from ${JSON.stringify(real)};\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// vaporChamberTest - the Vitest plugin
// ---------------------------------------------------------------------------

export type VaporChamberTestOptions = {
  /**
   * The shared-bus lifecycle `vapor-chamber/vitest` runs before each test.
   * `exclude` lists test files, as globs relative to the project root (`*`,
   * `**` and `?`), that it leaves alone: a file asserting the library's own
   * one-shot Vue detection from a clean start needs nothing to have imported
   * the library first.
   */
  sharedBus?: { exclude?: string[] };
  /**
   * The island project: files named `*.island.test.*` / `*.island.spec.*`, or
   * under `test/islands/` or `tests/islands/`, run in a project of their own
   * with a DOM environment, and the other files keep the project they had. It
   * inherits the rest of your config - aliases, setup files, plugins - which
   * is Vitest 5's default for projects. `false` injects nothing.
   * Default environment: 'happy-dom'.
   */
  islands?: false | { environment?: string };
};

/** The setup file, by package specifier: Vitest resolves setupFiles as paths from the root, never through plugins. */
const TEST_SETUP = 'vapor-chamber/vitest';
// The key the setup file reads with inject(). Duplicated in src/vitest.ts;
// tests/vitest-plugin.test.ts keeps the two equal.
const TEST_PROVIDED = 'vaporChamber';
/** Name of the injected project, which is also how the plugin recognises it when the project inherits it. */
const ISLAND_PROJECT = 'vapor-chamber-islands';
const ISLAND_INCLUDE = ['**/*.island.{test,spec}.*', '{test,tests}/islands/**'];
/** The Vitest majors this release was verified against. */
const VITEST_MAJORS = ['5'];
// The VC_TEST_VITEST_MAJOR diagnostic, as src/vitest-pure.ts's VcTestError
// would print it. Duplicated for the same reason as TEST_PROVIDED, and kept
// equal by the same test file.
const vitestMajorWarning = (version: string) =>
  '[vapor-chamber/vitest] VC_TEST_VITEST_MAJOR: vapor-chamber/vitest was released against Vitest 5 and is running ' +
  `on a major it does not know (Vitest ${version})\n  fix: nothing if the suite passes; report the break if it does not\n` +
  '  docs: https://github.com/lucianofedericopereira/vapor-chamber/blob/main/docs/api/vitest-pure.md#vctestdiagnostic';

// ---------------------------------------------------------------------------
// The vc-vitest-plugin line: vapor-chamber's mark on top of a run
// ---------------------------------------------------------------------------

/** Built-in reporters that print Vitest's own banner (its BaseReporter family). The line shows only beside that banner. */
const BANNER_REPORTERS = ['default', 'minimal', 'agent', 'verbose', 'dot', 'tree'];
// Vue's brand colors, 24-bit and as the nearest xterm-256 index (nearest by
// RGB distance over the 6x6x6 cube and the gray ramp): green #42B883, slate #35495E.
const VUE_GREEN = { rgb: '66;184;131', xterm: '72' };
const VUE_SLATE = { rgb: '53;73;94', xterm: '239' };
// Vitest instances that already printed it: once per run, whatever the number
// of projects, and whether one plugin instance or several (the island project
// re-reads the config file) see the run.
const branded = new WeakSet<object>();

/**
 * The line, colored when Vitest colors its own output. The rules are those of
 * tinyrainbow, Vitest's color library, read from the environment:
 * NO_COLOR wins; else FORCE_COLOR, CI, or a terminal that is not dumb (unless
 * FORCE_TTY=false). 24-bit where COLORTERM says so, xterm-256 otherwise.
 * The mark `\\//` is Vue's nested V: green outside, white inside, on slate.
 */
function brandLine(): string {
  const env = process.env;
  const on = !('NO_COLOR' in env) && ('FORCE_COLOR' in env || 'CI' in env || (env.FORCE_TTY !== 'false' && env.TERM !== 'dumb'));
  if (!on) return ' \\\\//  powered by vc-vitest-plugin';
  const deep = env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit';
  const fg = (c: typeof VUE_GREEN) => `\x1b[${deep ? `38;2;${c.rgb}` : `38;5;${c.xterm}`}m`;
  const bg = (c: typeof VUE_SLATE) => `\x1b[${deep ? `48;2;${c.rgb}` : `48;5;${c.xterm}`}m`;
  const green = fg(VUE_GREEN);
  const badge = `${bg(VUE_SLATE)}\x1b[1m ${green}\\\x1b[97m\\/${green}/ \x1b[0m`;
  return `${badge} \x1b[2mpowered by\x1b[22m ${green}\x1b[1mvc-vitest-plugin\x1b[0m`;
}

/** A root-relative glob as a RegExp source matching the absolute path Vitest gives a test file. */
function globToSource(root: string, glob: string): string {
  const escapeRegExp = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = escapeRegExp(glob).replace(/\*\*\/|\*\*|\*|\?/g, (t) => (t === '**/' ? '(?:.*/)?' : t === '**' ? '.*' : t === '*' ? '[^/]*' : '[^/]'));
  return `^${escapeRegExp(root.replace(/\/$/, ''))}/${body}$`;
}

/**
 * vaporChamberTest - `vapor-chamber/vitest` with configuration.
 *
 * The setup file alone (`setupFiles: ['vapor-chamber/vitest']`) is the whole
 * integration for most suites. The plugin adds what needs config:
 *
 * - it puts that setup file FIRST in `test.setupFiles`, once, keeping yours - a
 *   string is kept too, where Vite's own merge would have left ours last;
 * - `sharedBus.exclude`, handed to the setup file with `provide`;
 * - the island project (see `islands`);
 * - a one-time warning, `VC_TEST_VITEST_MAJOR`, on a Vitest major this release
 *   does not know. A warning, never a failure.
 * - one line on top of a run, `\\//  powered by vc-vitest-plugin`, in Vue's
 *   green and slate where the terminal has colors: on stderr, once per run,
 *   and only beside Vitest's own banner (not with json, junit or tap alone).
 *
 * The public type stays structural and names no `vitest` module, like the two
 * plugins above: this declaration file is what every `vapor-chamber/vite` user
 * loads, most of them without Vitest.
 *
 * @example
 * // vitest.config.ts
 * import { defineConfig } from 'vitest/config';
 * import { vaporChamberTest } from 'vapor-chamber/vite';
 *
 * export default defineConfig({
 *   plugins: [vaporChamberTest({ sharedBus: { exclude: ['tests/vue-detection.test.ts'] } })],
 * });
 */
export function vaporChamberTest(options: VaporChamberTestOptions = {}): any {
  const exclude = options.sharedBus?.exclude ?? [];
  const islands = options.islands;
  let warned = false;

  return {
    name: 'vapor-chamber-test',

    config(config: {
      test?: { setupFiles?: string | string[]; name?: string; include?: string[]; benchmark?: { include?: string[] } };
    }) {
      const test = (config.test ??= {});
      const theirs = test.setupFiles === undefined ? [] : ([] as string[]).concat(test.setupFiles);
      test.setupFiles = [TEST_SETUP, ...theirs.filter((file) => file !== TEST_SETUP)];
      // The island project inherits the declaring config file, and Vitest merges
      // a project's options into it with Vite's merge, which EXTENDS arrays: a
      // suite with its own `include` ran every test file twice, once in the DOM
      // environment (measured on this repository: 348 file runs for 174, and 5
      // Node-arm tests failed). This hook runs inside that project too, so it
      // replaces the include there.
      // Benchmark files have their own include, inherited the same way, and
      // `vitest bench` ran each one again in this project: measured on this
      // repository, tests/perf.bench.ts twice and the CI bench job 89s -> 179s.
      // The island project runs no benchmarks; emptying the include is how.
      if (test.name === ISLAND_PROJECT) {
        test.include = [...ISLAND_INCLUDE];
        test.benchmark = { ...test.benchmark, include: [] };
      }
    },

    async configureVitest({ vitest, project, injectTestProjects }: any) {
      // configureVitest runs before Vitest creates its reporters, so this is the
      // first line of the run. On stderr: a JSON report or `vitest list --json`
      // written to stdout stays parseable.
      if (!branded.has(vitest) && vitest.config.reporters.some((r: unknown) => Array.isArray(r) && BANNER_REPORTERS.includes(r[0]))) {
        branded.add(vitest);
        vitest.logger.error(brandLine());
      }
      if (!warned && !VITEST_MAJORS.includes(String(vitest.version).split('.')[0])) {
        warned = true;
        vitest.logger.warn(vitestMajorWarning(vitest.version));
      }
      project.provide(TEST_PROVIDED, { exclude: exclude.map((glob) => globToSource(project.config.root, glob)) });

      if (islands === false || project.name === ISLAND_PROJECT) return;
      // A new array, not a push: the injected project's resolved `exclude` is
      // this same array object, so pushing excluded every island file from the
      // island project too (measured: it ran none).
      project.config.exclude = [...project.config.exclude, ...ISLAND_INCLUDE];
      await injectTestProjects({
        test: { name: ISLAND_PROJECT, include: [...ISLAND_INCLUDE], environment: islands?.environment ?? 'happy-dom' },
      });
    },
  };
}
