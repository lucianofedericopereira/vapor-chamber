/**
 * Dev warning for the signal()-before-detection race (v1.6.0).
 *
 * Vue detection is async (dynamic import in chamber.ts). A signal() created
 * before configureSignal() lands is a plain { value } object FOREVER — writes
 * to it never trigger reactivity, while later signals do. signal.ts now warns
 * (dev, once) when a reactive backing arrives after plain signals were created.
 *
 * Imports src/signal directly (NOT chamber) so chamber's auto-probe can't call
 * configureSignal at an unpredictable moment. Module-level counters make this
 * order-sensitive, so it lives in its own file (vitest isolates per file).
 */
import { describe, it, expect, vi } from 'vitest';

describe('signal() pre-detection race warning', () => {
  it('warns once when configureSignal arrives after plain signals were created', async () => {
    // Ensure the sync probe finds no Vue global — forces the plain fallback.
    const hadVue = '__VUE__' in globalThis;
    const savedVue = (globalThis as any).__VUE__;
    delete (globalThis as any).__VUE__;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { signal, configureSignal } = await import('../src/signal');

      const early = signal(0); // plain { value } — created before any backing
      expect(early.value).toBe(0);
      expect(warn).not.toHaveBeenCalled(); // creation itself is silent

      // Reactive backing arrives late (what chamber.ts does after its async probe).
      const fakeRef = <T>(v: T) => ({ value: v });
      configureSignal(fakeRef);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0][0])).toContain('before a reactive backing');

      configureSignal(fakeRef); // deduped — once per module
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
      if (hadVue) (globalThis as any).__VUE__ = savedVue;
    }
  });
});
