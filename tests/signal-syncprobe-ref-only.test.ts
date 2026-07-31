/**
 * Covers src/signal.ts's OWN standalone syncProbe() — both branches of
 * `if (shallowRef) ... else if (ref) ...`. chamber.ts's applyVueModule wires
 * Vue's shallowRef in via configureSignal() directly, bypassing signal.ts's
 * internal syncProbe()/_vueRef entirely — that path only ever runs when
 * signal.ts is used standalone (transports/plugins/form, no chamber.ts
 * loaded). Every other test either has no __VUE__ (signal-race-warning.test.ts)
 * or goes through chamber.ts's own wiring, so neither branch here was
 * previously exercised on signal.ts's own probe.
 *
 * Imports src/signal directly (not chamber) and stubs __VUE__ purely
 * synchronously — no async Vue-detection race involved, unlike chamber.ts's
 * probe. Module-level counters make this order-sensitive, so (like
 * signal-race-warning.test.ts) it lives in its own file.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('signal() sync probe — src/signal.ts\'s own __VUE__ detection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('prefers vue.shallowRef when both shallowRef and ref are present', async () => {
    const fakeShallowRef = vi.fn(<T>(v: T) => ({ value: v, __fromShallowRef: true }));
    const fakeRef = vi.fn(<T>(v: T) => ({ value: v, __fromRef: true }));
    vi.stubGlobal('__VUE__', { shallowRef: fakeShallowRef, ref: fakeRef });
    vi.resetModules();

    const { signal } = await import('../src/signal');
    const s = signal(1) as any;

    expect(fakeShallowRef).toHaveBeenCalledWith(1);
    expect(fakeRef).not.toHaveBeenCalled();
    expect(s.__fromShallowRef).toBe(true);
  });

  it('falls back to vue.ref when shallowRef is absent', async () => {
    const fakeRef = vi.fn(<T>(v: T) => ({ value: v, __fromRef: true }));
    vi.stubGlobal('__VUE__', { ref: fakeRef }); // no shallowRef on this global
    vi.resetModules();

    const { signal } = await import('../src/signal');
    const s = signal(1) as any;

    expect(fakeRef).toHaveBeenCalledWith(1);
    expect(s.__fromRef).toBe(true);
  });
});
