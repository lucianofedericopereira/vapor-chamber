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
});
