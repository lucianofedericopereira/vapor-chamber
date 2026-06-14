/**
 * vapor-chamber - Vite HMR plugin
 *
 * v1.6.0 — CODE CHANGE: the injected shim now primes globalThis.__VUE__ from the
 *           consumer's 'vue' (via a companion virtual module that evaluates before
 *           'vapor-chamber') so the lib's synchronous Vue/Vapor detection works in
 *           Vite dev. Before this, the shim's top-of-module injection guaranteed
 *           vapor-chamber evaluated before any user code could prime detection, and
 *           the async probe (bare-specifier dynamic import) always fails in
 *           browsers — so createVaporChamberApp() threw on every dev page load
 *           whenever this plugin was active. Found by browser-verifying the
 *           vapor-sfc example. Non-Vue consumers unaffected (the priming module is
 *           emitted only when 'vue' resolves).
 * v1.5.0 — Vue 3.6.0-beta.14 HMR alignment:
 *           • dedupe HMR parent reloads (hmr: dedupe HMR parent reloads) — Vue now
 *             deduplicates parent reload events at the runtime level; the dispose
 *             shim mirrors this with a per-cycle guard so the bus is persisted at
 *             most once per HMR update regardless of how many parent reload events
 *             fire.
 *           • align child/parent reload timing (hmr: align child component HMR
 *             reload with parent rerender) — child component HMR reload is now
 *             synchronised with the parent rerender; bus restoration happens after
 *             the full parent subtree has settled.
 *           • preserve setup effects (runtime-vapor: preserve setup effects during
 *             hmr rerender) — watchers and computed effects created in setup() are
 *             maintained across HMR rerenders; bus handlers registered via
 *             watchEffect inside setup() survive a hot reload without re-registration.
 *           • restore HMR context on errors (runtime-vapor: restore hmr context on
 *             errors) — HMR context is recovered when an error occurs mid-reload;
 *             the shim wraps bus persistence in try/catch so a failed getCommandBus()
 *             call doesn't leave the module in an unrecoverable state.
 *           • update app instance on root reload (runtime-vapor: update app instance
 *             on root hmr reload) — the app instance on the root component is
 *             refreshed after a root HMR cycle; callers of createVaporChamberApp()
 *             no longer need to re-acquire the app reference after a root reload.
 * v1.1.0 — Vapor↔VDOM mode switching: tracks __vapor state during HMR reloads
 *           so components switching between Vapor and VDOM modes preserve bus state.
 * v0.5.0 — State-preserving hot module replacement.
 *
 * Preserves the shared command bus (handlers, plugins, hooks) across Vite HMR
 * updates so that application state survives component hot-reloads.
 *
 * Without this plugin, each HMR update re-creates the bus from scratch,
 * clearing all registered handlers and registered state.
 *
 * Tested against:
 *   • Vite ≥ 7.0.0 (programmatic build API + library mode)
 *   • @vitejs/plugin-vue ≥ 5.0.0 (Vue 3.6 Vapor SFC support — earlier
 *     plugin-vue versions only handle 3.5 VDOM and silently skip vapor blocks)
 *   • Vue ≥ 3.5.0 (composables) or ≥ 3.6.0-beta.14 (full Vapor surface)
 *
 * If you're on plugin-vue v4 the HMR plugin still works for VDOM SFCs but
 * you'll miss Vapor support entirely — Vapor `<script setup vapor>` blocks
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
 * // main.ts — no changes required; HMR is transparent
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
// Track whether the last active component was Vapor or VDOM — used for mode switch detection.
const HMR_MODE_KEY = '__VAPOR_CHAMBER_MODE__';

/**
 * vaporChamberHMR — Vite plugin for state-preserving hot reload.
 *
 * Injects a small runtime shim that:
 * 1. Stores the command bus on `globalThis[HMR_GLOBAL_KEY]` after creation.
 * 2. On HMR accept, restores the previously stored bus instance instead of
 *    creating a new one — preserving all registered handlers and plugins.
 */
export function vaporChamberHMR(options: VaporChamberHMROptions = {}): any {
  const { verbose = false } = options;
  const virtualModuleId = options.moduleId ?? 'virtual:vapor-chamber-hmr';
  const resolvedVirtualModuleId = '\0' + virtualModuleId;
  // Vue-priming companion module — see load() below for why it must exist.
  const primeModuleId = virtualModuleId + '-vue-prime';
  const resolvedPrimeModuleId = '\0' + primeModuleId;

  return {
    name: 'vapor-chamber-hmr',
    enforce: 'pre' as const,

    resolveId(id: string) {
      if (id === virtualModuleId) return resolvedVirtualModuleId;
      if (id === primeModuleId) return resolvedPrimeModuleId;
    },

    async load(id: string) {
      // ── Vue-priming module ──────────────────────────────────────────────
      // The HMR shim import is injected at the TOP of every transformed
      // module, so vapor-chamber evaluates before ANY user code — including
      // any user attempt to set globalThis.__VUE__. And in the browser the
      // lib's async probe (`import(/* @vite-ignore *​/ 'vue')`) is a bare
      // specifier import that always fails without an import map. Net effect
      // (pre-v1.6.0): with this plugin active, Vue/Vapor detection could
      // NEVER succeed in Vite dev — createVaporChamberApp() threw on every
      // dev page load. This module fixes it at the right layer: it sets
      // globalThis.__VUE__ from the consumer's own 'vue' BEFORE the shim
      // imports 'vapor-chamber' (its module body runs first in DFS order),
      // so the lib's synchronous probe finds the real Vue module — alias
      // and all. Emitted only when 'vue' resolves, so non-Vue Vite apps
      // using this plugin are unaffected.
      if (id === resolvedPrimeModuleId) {
        const vueResolved = await (this as any).resolve?.('vue');
        if (!vueResolved) return 'export {};';
        return `
// vapor-chamber HMR shim — Vue priming (must evaluate before 'vapor-chamber')
import * as __VC_VUE__ from 'vue';
if (!globalThis.__VUE__ || typeof globalThis.__VUE__.ref !== 'function') {
  globalThis.__VUE__ = __VC_VUE__;
}
export {};
        `.trim();
      }

      if (id !== resolvedVirtualModuleId) return;

      // This module is injected into the app bundle.
      // It patches setCommandBus/getCommandBus to persist across HMR.
      return `
// vapor-chamber HMR shim — injected by vaporChamberHMR() Vite plugin
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
  // Detect vapor↔vdom mode switch (Vue 3.6.0-beta.10 tracks __vapor state)
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
      // Preserve whatever was last stored — do not overwrite with a failed read.
    }
    ${verbose ? "console.log('[vapor-chamber] HMR: bus persisted for next reload');" : ''}
  });
}

export { getCommandBus, setCommandBus, resetCommandBus };
      `.trim();
    },

    // Transform: inject HMR shim import into the app entry point
    transform(code: string, id: string) {
      // Only inject into the app entry (files that import vapor-chamber directly)
      // and only in development mode
      if (process.env.NODE_ENV === 'production') return;
      if (!code.includes('vapor-chamber')) return;
      if (id.includes('node_modules')) return;
      if (id.includes(resolvedVirtualModuleId)) return;
      // Match standard Vue files + Vapor SFCs (.vapor.vue compiled by
      // @vitejs/plugin-vue-vapor) and virtual modules from vue-vapor plugin
      if (!id.match(/\.(ts|js|vue|tsx|jsx)$/) && !id.includes('.vapor.vue')) return;

      // Avoid double-injection
      if (code.includes(virtualModuleId)) return;

      // Prepend the HMR shim import
      return {
        code: `import '${virtualModuleId}';\n${code}`,
        map: null,
      };
    },
  };
}
