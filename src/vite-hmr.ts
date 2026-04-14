/**
 * vapor-chamber - Vite HMR plugin
 *
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

  return {
    name: 'vapor-chamber-hmr',
    enforce: 'pre' as const,

    resolveId(id: string) {
      if (id === virtualModuleId) return resolvedVirtualModuleId;
    },

    load(id: string) {
      if (id !== resolvedVirtualModuleId) return;

      // This module is injected into the app bundle.
      // It patches setCommandBus/getCommandBus to persist across HMR.
      return `
// vapor-chamber HMR shim — injected by vaporChamberHMR() Vite plugin
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
    ${verbose ? "console.log('[vapor-chamber] HMR: module updated, bus preserved');" : ''}
  });

  // On dispose, persist the current bus and mode for the next module version
  import.meta.hot.dispose(() => {
    globalThis[KEY] = getCommandBus();
    globalThis[MODE_KEY] = isVaporAvailable() ? 'vapor' : 'vdom';
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
