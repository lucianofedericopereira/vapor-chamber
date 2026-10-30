/**
 * `vaporChamberHMR` (src/vite-hmr.ts), called directly: its hooks, its generated shim, and the shim executed against a fake `import.meta.hot`.
 * Why: dev HMR would lose the command bus across reloads, or the shim would ship in a production bundle or into files that only mention the package.
 * Shows: plugin name and hooks, the virtual shim and Vue-priming modules (order, key, no-op without vue), the files transform injects into or skips, a first-line injection with no sourcemap, and the dispose and accept callbacks persisting the bus once per cycle.
 * See: tests/vite-hmr-pipeline.test.ts, tests/vue-detection-global-clobber.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('loads the HMR shim for the virtual module', async () => {
    const code = await plugin.load('\0virtual:vapor-chamber-hmr');
    expect(code).toContain('__VAPOR_CHAMBER_BUS__');
    expect(code).toContain('getCommandBus');
    expect(code).toContain('setCommandBus');
    expect(code).toContain('import.meta.hot');
  });

  it('shim imports the Vue-priming module BEFORE vapor-chamber', async () => {
    const code: string = await plugin.load('\0virtual:vapor-chamber-hmr');
    const primeIdx = code.indexOf('virtual:vapor-chamber-hmr-vue-prime');
    const vcIdx = code.indexOf("from 'vapor-chamber'");
    expect(primeIdx).toBeGreaterThan(-1);
    expect(vcIdx).toBeGreaterThan(-1);
    expect(primeIdx).toBeLessThan(vcIdx);
  });

  it('prime module writes the library-owned slot, not Vue\'s __VUE__', async () => {
    const ctx = { resolve: async () => ({ id: '/node_modules/vue/index.mjs' }) };
    const code: string = await plugin.load.call(ctx, '\0virtual:vapor-chamber-hmr-vue-prime');
    expect(code).toContain("import * as __VC_VUE__ from 'vue'");
    expect(code).toContain('globalThis.__VAPOR_CHAMBER_VUE__ = __VC_VUE__');

    // `__VUE__` belongs to Vue, which assigns `true` to it when the first app is created. The slot key is duplicated from chamber.ts VUE_GLOBAL_KEY, which the plugin cannot import.
    expect(code).not.toContain('globalThis.__VUE__ =');
  });

  it('prime module is a no-op when vue does not resolve (non-Vue consumers)', async () => {
    const ctx = { resolve: async () => null };
    const code: string = await plugin.load.call(ctx, '\0virtual:vapor-chamber-hmr-vue-prime');
    expect(code).toBe('export {};');
    expect(code).not.toContain('vue');
  });

  it('does not load non-virtual modules', async () => {
    expect(await plugin.load('some-file.ts')).toBeUndefined();
  });

  it('custom moduleId is respected', () => {
    const custom = vaporChamberHMR({ moduleId: 'my-custom-hmr' });
    expect(custom.resolveId('my-custom-hmr')).toBe('\0my-custom-hmr');
    expect(custom.resolveId('my-custom-hmr-vue-prime')).toBe('\0my-custom-hmr-vue-prime');
    expect(custom.resolveId('virtual:vapor-chamber-hmr')).toBeUndefined();
  });

  it('verbose option adds console.log statements', async () => {
    const verbose = vaporChamberHMR({ verbose: true });
    const code = await verbose.load('\0virtual:vapor-chamber-hmr');
    expect(code).toContain('console.log');
    expect(code).toContain('HMR');
  });

  it('non-verbose mode omits console.log statements', async () => {
    const quiet = vaporChamberHMR({ verbose: false });
    const code = await quiet.load('\0virtual:vapor-chamber-hmr');
    expect(code).not.toContain('console.log');
  });

  describe('transform', () => {
    beforeEach(() => {
      vi.stubGlobal('process', { env: { NODE_ENV: 'development' } });
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

    it("declares apply: 'serve' - the guard NODE_ENV cannot fool", () => {
      // `--mode staging` or a programmatic build may never set NODE_ENV; apply: 'serve' keeps the plugin out of build entirely.
      expect(plugin.apply).toBe('serve');
    });

    it('injects on the first line, so no line moves and no map is needed', () => {
      // A line-shift map would flatten every chained downstream map onto column 0; injecting on the same line moves nothing, so Vite's identity default is right.
      const code = "import { createCommandBus } from 'vapor-chamber';\nconst bus = createCommandBus();\nbus.dispatch('x', {});";
      const result = plugin.transform(code, '/src/app.ts');

      expect(result.map).toBeUndefined();
      expect(result.code.split('\n')).toHaveLength(code.split('\n').length);
      expect(result.code.split('\n')[0]).toBe(
        "import 'virtual:vapor-chamber-hmr';import { createCommandBus } from 'vapor-chamber';",
      );
      // Every line after the first is untouched, character for character.
      expect(result.code.split('\n').slice(1)).toEqual(code.split('\n').slice(1));
    });

    it('matches an import, not a passing mention of the package name', () => {
      expect(
        plugin.transform("// TODO: migrate this to vapor-chamber\nexport const x = 1;", '/src/notes.ts'),
      ).toBeUndefined();
      expect(
        plugin.transform("const docsUrl = 'https://example.test/vapor-chamber';", '/src/links.ts'),
      ).toBeUndefined();

      // The real import shapes still match.
      expect(plugin.transform("import 'vapor-chamber';", '/src/a.ts')?.code).toContain('virtual:');
      expect(
        plugin.transform("import { createCommandBus } from 'vapor-chamber';", '/src/b.ts')?.code,
      ).toContain('virtual:');
      expect(
        plugin.transform("export { retry } from 'vapor-chamber/plugins';", '/src/c.ts')?.code,
      ).toContain('virtual:');
      expect(
        plugin.transform("const m = await import('vapor-chamber/router');", '/src/d.ts')?.code,
      ).toContain('virtual:');
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

    // `enforce: 'pre'` means the plugin sees raw SFC text, where a prepended import lands outside every block and compiler-sfc drops it; a real SFC is parsed, not a script fragment.
    it('skips SFCs, because compiler-sfc discards anything outside a block', async () => {
      const { parse } = await import('@vue/compiler-sfc');
      const sfc = [
        '<script setup lang="ts">',
        "import { useCommand } from 'vapor-chamber';",
        'const { dispatch } = useCommand();',
        '</script>',
        '<template><button @click="dispatch()">buy</button></template>',
      ].join('\n');

      expect(plugin.transform(sfc, '/src/ProductCard.vue')).toBeUndefined();
      expect(plugin.transform(sfc, '/src/ProductCard.vapor.vue')).toBeUndefined();

      // A prepended import would sit in no block, so no compiled output would carry it.
      const injected = `import 'virtual:vapor-chamber-hmr';\n${sfc}`;
      const { descriptor } = parse(injected, { filename: '/src/ProductCard.vue' });
      const blocks = [descriptor.script, descriptor.scriptSetup, descriptor.template];
      for (const block of blocks) {
        expect(block?.content ?? '').not.toContain('virtual:vapor-chamber-hmr');
      }
      expect(descriptor.customBlocks).toHaveLength(0);
    });
  });

  describe('beta.14 dispose dedup guard', () => {
    it('generates the per-cycle dedup guard, the accept-side reset, and a try/catch', async () => {
      const code: string = await plugin.load('\0virtual:vapor-chamber-hmr');
      // dispose takes the hot `data` bag and guards on a per-cycle flag
      expect(code).toMatch(/\.dispose\(\s*\(\s*data\s*\)\s*=>/);
      expect(code).toContain('if (data.__vc_disposed) return;');
      expect(code).toContain('data.__vc_disposed = true;');
      // accept clears the flag so the next cycle's dispose runs
      expect(code).toContain('import.meta.hot.data.__vc_disposed = false;');
      // persistence is wrapped so a mid-reload throw can't wedge the module
      expect(code).toMatch(/try\s*\{[\s\S]*getCommandBus\(\)[\s\S]*\}\s*catch/);
    });

    // Reconstructs the generated ESM shim as a function: static import/export lines are stripped (deps are injected as params) and `import.meta` becomes an identifier.
    // Returns the captured accept/dispose callbacks and a stub globalThis.
    async function runShim(deps: {
      getCommandBus: () => any;
      setCommandBus?: (b: any) => void;
      isVaporAvailable?: () => boolean;
      seedGlobal?: Record<string, any>;
    }) {
      const raw: string = await plugin.load('\0virtual:vapor-chamber-hmr');
      const body = raw
        .replace(/import\s*\{[^}]*\}\s*from\s*'vapor-chamber';?/, '')
        .replace(/import\s*'[^']*';?/g, '') // bare side-effect imports (vue-prime)
        .replace(/export\s*\{[^}]*\};?/, '')
        .replace(/import\.meta/g, '__importMeta');

      const stubGlobal: Record<string, any> = { ...(deps.seedGlobal ?? {}) };
      const captured: { accept?: (cb: () => void) => void; dispose?: (data: any) => void; on: Record<string, () => void> } = { on: {} };
      const hotData: Record<string, any> = {};
      const importMeta = {
        hot: {
          data: hotData,
          accept: (cb: any) => { captured.accept = cb; },
          dispose: (cb: any) => { captured.dispose = cb; },
          on: (event: string, cb: any) => { captured.on[event] = cb; },
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

    it('persists the bus on the first dispose but dedupes the second in the same cycle', async () => {
      const getCommandBus = vi.fn(() => ({ id: 'bus' }));
      // Pre-seed the global so module init takes the restore path (setCommandBus),
      // leaving getCommandBus to be called only by dispose.
      const { captured, hotData } = await runShim({
        getCommandBus,
        seedGlobal: { __VAPOR_CHAMBER_BUS__: { id: 'preexisting' } },
      });
      getCommandBus.mockClear();

      // Vite passes import.meta.hot.data as the dispose argument.
      captured.dispose!(hotData);
      expect(getCommandBus).toHaveBeenCalledTimes(1);
      expect(hotData.__vc_disposed).toBe(true);

      // Second dispose in the same cycle is a no-op - the guard short-circuits.
      captured.dispose!(hotData);
      expect(getCommandBus).toHaveBeenCalledTimes(1);
    });

    it('accept() clears the flag so the next cycle persists again', async () => {
      const getCommandBus = vi.fn(() => ({ id: 'bus' }));
      const { captured, hotData } = await runShim({
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

    it('marks a hot update from vite:beforeUpdate to vite:afterUpdate, the window a store carries its state in', async () => {
      const { captured, stubGlobal } = await runShim({ getCommandBus: () => ({}), seedGlobal: { __VAPOR_CHAMBER_BUS__: null } });
      expect(stubGlobal.__VAPOR_CHAMBER_HOT__).toBeUndefined();
      captured.on['vite:beforeUpdate']!();
      expect(stubGlobal.__VAPOR_CHAMBER_HOT__).toBeInstanceOf(WeakMap);
      captured.on['vite:afterUpdate']!();
      expect(stubGlobal.__VAPOR_CHAMBER_HOT__).toBeUndefined();
    });

    it('swallows a getCommandBus() throw and preserves the last-stored bus', async () => {
      const sentinel = { id: 'preexisting' };
      const getCommandBus = vi.fn(() => { throw new Error('mid-reload failure'); });
      const { captured, hotData, stubGlobal, KEY } = await runShim({
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
