/**
 * Tests for src/vite-hmr.ts — Vite HMR plugin
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { vaporChamberHMR } from '../src/vite-hmr';

describe('vaporChamberHMR', () => {
  let plugin: ReturnType<typeof vaporChamberHMR>;

  beforeEach(() => {
    plugin = vaporChamberHMR();
  });

  it('returns a Vite plugin with correct name', () => {
    expect(plugin.name).toBe('vapor-chamber-hmr');
    expect(plugin.enforce).toBe('pre');
  });

  it('resolves the virtual module ID', () => {
    expect(plugin.resolveId('virtual:vapor-chamber-hmr')).toBe('\0virtual:vapor-chamber-hmr');
    expect(plugin.resolveId('some-other-module')).toBeUndefined();
  });

  it('loads the HMR shim for the virtual module', () => {
    const code = plugin.load('\0virtual:vapor-chamber-hmr');
    expect(code).toContain('__VAPOR_CHAMBER_BUS__');
    expect(code).toContain('getCommandBus');
    expect(code).toContain('setCommandBus');
    expect(code).toContain('import.meta.hot');
  });

  it('does not load non-virtual modules', () => {
    expect(plugin.load('some-file.ts')).toBeUndefined();
  });

  it('custom moduleId is respected', () => {
    const custom = vaporChamberHMR({ moduleId: 'my-custom-hmr' });
    expect(custom.resolveId('my-custom-hmr')).toBe('\0my-custom-hmr');
    expect(custom.resolveId('virtual:vapor-chamber-hmr')).toBeUndefined();
  });

  it('verbose option adds console.log statements', () => {
    const verbose = vaporChamberHMR({ verbose: true });
    const code = verbose.load('\0virtual:vapor-chamber-hmr');
    expect(code).toContain('console.log');
    expect(code).toContain('HMR');
  });

  it('non-verbose mode omits console.log statements', () => {
    const quiet = vaporChamberHMR({ verbose: false });
    const code = quiet.load('\0virtual:vapor-chamber-hmr');
    expect(code).not.toContain('console.log');
  });

  describe('transform', () => {
    beforeEach(() => {
      vi.stubGlobal('process', { env: { NODE_ENV: 'development' } });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('injects HMR import into files that use vapor-chamber', () => {
      const result = plugin.transform(
        "import { createCommandBus } from 'vapor-chamber';\nconst bus = createCommandBus();",
        '/src/app.ts'
      );
      expect(result?.code).toContain("import 'virtual:vapor-chamber-hmr'");
    });

    it('skips files that do not import vapor-chamber', () => {
      const result = plugin.transform(
        "import { ref } from 'vue';",
        '/src/component.ts'
      );
      expect(result).toBeUndefined();
    });

    it('skips node_modules', () => {
      const result = plugin.transform(
        "import { createCommandBus } from 'vapor-chamber';",
        '/node_modules/some-lib/index.ts'
      );
      expect(result).toBeUndefined();
    });

    it('skips if already injected', () => {
      const result = plugin.transform(
        "import 'virtual:vapor-chamber-hmr';\nimport { createCommandBus } from 'vapor-chamber';",
        '/src/app.ts'
      );
      expect(result).toBeUndefined();
    });

    it('skips in production', () => {
      vi.stubGlobal('process', { env: { NODE_ENV: 'production' } });
      const result = plugin.transform(
        "import { createCommandBus } from 'vapor-chamber';",
        '/src/app.ts'
      );
      expect(result).toBeUndefined();
    });

    it('skips non-script files', () => {
      const result = plugin.transform(
        "vapor-chamber",
        '/src/style.css'
      );
      expect(result).toBeUndefined();
    });

    it('injects HMR import into .vapor.vue files (Vue 3.6+ Vapor SFCs)', () => {
      const result = plugin.transform(
        "import { useVaporCommand } from 'vapor-chamber';\nconst { dispatch } = useVaporCommand();",
        '/src/ProductCard.vapor.vue'
      );
      expect(result?.code).toContain("import 'virtual:vapor-chamber-hmr'");
    });
  });

  // ---------------------------------------------------------------------------
  // beta.14 HMR dedup guard (dedupe HMR parent reloads + restore hmr context on
  // errors). This is the only new shim *logic* the beta.14 alignment introduced,
  // so it gets executable coverage — not just substring checks. The generated
  // shim is reconstructed into a runnable function with injected dependencies so
  // the real dispose/accept callbacks run against a fake import.meta.hot.
  // ---------------------------------------------------------------------------
  describe('beta.14 dispose dedup guard', () => {
    // Structural assertions — lock in that the generation still emits the guard,
    // the accept-side reset, and the try/catch. These would have caught a silent
    // removal of any of the three pieces (the old tests did not).
    it('generates the per-cycle dedup guard, the accept-side reset, and a try/catch', () => {
      const code: string = plugin.load('\0virtual:vapor-chamber-hmr');
      // dispose takes the hot `data` bag and guards on a per-cycle flag
      expect(code).toMatch(/\.dispose\(\s*\(\s*data\s*\)\s*=>/);
      expect(code).toContain('if (data.__vc_disposed) return;');
      expect(code).toContain('data.__vc_disposed = true;');
      // accept clears the flag so the next cycle's dispose runs
      expect(code).toContain('import.meta.hot.data.__vc_disposed = false;');
      // persistence is wrapped so a mid-reload throw can't wedge the module
      expect(code).toMatch(/try\s*\{[\s\S]*getCommandBus\(\)[\s\S]*\}\s*catch/);
    });

    /**
     * Reconstruct the generated ESM shim into an executable function. Strips the
     * static `import`/`export` lines (deps are injected as params) and rewrites
     * `import.meta` to a plain identifier so it can live inside a Function body.
     * Returns the captured accept/dispose callbacks and a stub globalThis.
     */
    function runShim(deps: {
      getCommandBus: () => any;
      setCommandBus?: (b: any) => void;
      isVaporAvailable?: () => boolean;
      seedGlobal?: Record<string, any>;
    }) {
      const raw: string = plugin.load('\0virtual:vapor-chamber-hmr');
      const body = raw
        .replace(/import\s*\{[^}]*\}\s*from\s*'vapor-chamber';?/, '')
        .replace(/export\s*\{[^}]*\};?/, '')
        .replace(/import\.meta/g, '__importMeta');

      const stubGlobal: Record<string, any> = { ...(deps.seedGlobal ?? {}) };
      const captured: { accept?: (cb: () => void) => void; dispose?: (data: any) => void } = {};
      const hotData: Record<string, any> = {};
      const importMeta = {
        hot: {
          data: hotData,
          accept: (cb: any) => { captured.accept = cb; },
          dispose: (cb: any) => { captured.dispose = cb; },
        },
      };

      // eslint-disable-next-line no-new-func
      const fn = new Function(
        '__importMeta', 'getCommandBus', 'setCommandBus', 'resetCommandBus', 'isVaporAvailable', 'globalThisRef',
        `const globalThis = globalThisRef;\n${body}`,
      );
      fn(
        importMeta,
        deps.getCommandBus,
        deps.setCommandBus ?? (() => {}),
        () => {},
        deps.isVaporAvailable ?? (() => false),
        stubGlobal,
      );

      return { captured, hotData, stubGlobal, KEY: '__VAPOR_CHAMBER_BUS__' };
    }

    it('persists the bus on the first dispose but dedupes the second in the same cycle', () => {
      const getCommandBus = vi.fn(() => ({ id: 'bus' }));
      // Pre-seed the global so module init takes the restore path (setCommandBus),
      // leaving getCommandBus to be called only by dispose.
      const { captured, hotData } = runShim({
        getCommandBus,
        seedGlobal: { __VAPOR_CHAMBER_BUS__: { id: 'preexisting' } },
      });
      getCommandBus.mockClear();

      // Vite passes import.meta.hot.data as the dispose argument.
      captured.dispose!(hotData);
      expect(getCommandBus).toHaveBeenCalledTimes(1);
      expect(hotData.__vc_disposed).toBe(true);

      // Second dispose in the same cycle is a no-op — the guard short-circuits.
      captured.dispose!(hotData);
      expect(getCommandBus).toHaveBeenCalledTimes(1);
    });

    it('accept() clears the flag so the next cycle persists again', () => {
      const getCommandBus = vi.fn(() => ({ id: 'bus' }));
      const { captured, hotData } = runShim({
        getCommandBus,
        seedGlobal: { __VAPOR_CHAMBER_BUS__: { id: 'preexisting' } },
      });
      getCommandBus.mockClear();

      captured.dispose!(hotData);
      expect(getCommandBus).toHaveBeenCalledTimes(1);

      // New HMR cycle: accept() resets the per-cycle flag.
      captured.accept!(() => {});
      expect(hotData.__vc_disposed).toBe(false);

      captured.dispose!(hotData);
      expect(getCommandBus).toHaveBeenCalledTimes(2);
    });

    it('swallows a getCommandBus() throw and preserves the last-stored bus', () => {
      const sentinel = { id: 'preexisting' };
      const getCommandBus = vi.fn(() => { throw new Error('mid-reload failure'); });
      const { captured, hotData, stubGlobal, KEY } = runShim({
        getCommandBus,
        seedGlobal: { __VAPOR_CHAMBER_BUS__: sentinel },
      });

      // dispose must not propagate the throw...
      expect(() => captured.dispose!(hotData)).not.toThrow();
      // ...and must not overwrite the previously-stored bus with a failed read.
      expect(stubGlobal[KEY]).toBe(sentinel);
    });
  });
});
