/**
 * Supplemental coverage for src/chamber.ts.
 *
 *  - runDispatch: async rejection, async and sync `{ ok:false }` with no
 *    error attached.
 *  - untracked: the `__VC_IIFE__` const-fold guard - at runtime in tests
 *    the identifier resolves via globalThis, so both arms are drivable.
 *  - useSharedCommandState: errorCap tightening, ring-buffer trim
 *, rejected dispatch promise recording.
 *  - useCommandGroup: the 256-entry `_nameCache` FIFO eviction.
 *  - useCommandHistory redo payloads: object payload -> `__origin` spread
 *, array payload -> non-markable identity fallback.
 *  - KeepAlive wiring via a fake Vue namespace handed to configureVue():
 *    tryKeepAliveHooks' hasInjectionContext arm and getCurrentInstance
 *    fallback, and useCommandError's pause/resume closures
 * - reachable without a component tree because the fake
 *    namespace's onDeactivated/onActivated just hand the callbacks back.
 *  - readGlobal's catch via a throwing global getter.
 */
import { describe, expect, vi, afterEach } from 'vitest';
import { runDispatch } from '../src/chamber';
import {
  untracked,
  useSharedCommandState,
  useCommandGroup,
  useCommandHistory,
  setCommandBus,
  resetCommandBus,
  signal,
} from '../src/index';
import { createCommandBus } from '../src/index';
import { it } from '../src/vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  resetCommandBus();
});

// ---------------------------------------------------------------------------
// runDispatch
// ---------------------------------------------------------------------------

describe('runDispatch error arms', () => {
  it('records a rejected dispatch promise', async () => {
    const loading = signal(false);
    const lastError = signal<Error | null>(null);
    const boom = new Error('rejected');

    const result = await runDispatch(() => Promise.reject(boom), loading, lastError);

    expect(result).toEqual({ ok: false, error: boom });
    expect(loading.value).toBe(false);
    expect(lastError.value).toBe(boom);
  });

  it('stores null when an async failure carries no error', async () => {
    const loading = signal(false);
    const lastError = signal<Error | null>(new Error('stale'));

    await runDispatch(() => Promise.resolve({ ok: false }), loading, lastError);
    expect(lastError.value).toBeNull();
  });

  it('stores null when a sync failure carries no error', () => {
    const loading = signal(false);
    const lastError = signal<Error | null>(new Error('stale'));

    const result = runDispatch(() => ({ ok: false }), loading, lastError);
    expect((result as { ok: boolean }).ok).toBe(false);
    expect(lastError.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// untracked - __VC_IIFE__ guard
// ---------------------------------------------------------------------------

describe('untracked IIFE guard', () => {
  it('passes through when the IIFE flag is unset', () => {
    expect(untracked(() => 7)).toBe(7);
  });

  it('returns fn() directly when __VC_IIFE__ is set', () => {
    vi.stubGlobal('__VC_IIFE__', true);
    expect(untracked(() => 11)).toBe(11);
  });
});

// ---------------------------------------------------------------------------
// useSharedCommandState
// ---------------------------------------------------------------------------

describe('useSharedCommandState', () => {
  it('tightens errorCap when a later caller asks for a smaller buffer', async () => {
    const rejecting = {
      on: () => () => {},
      dispatch: () => Promise.reject(new Error('r')),
    } as any;

    const first = useSharedCommandState({ bus: rejecting, errorCap: 10 });
    const second = useSharedCommandState({ bus: rejecting, errorCap: 2 });

    // Three rejections against a cap of 2 -> ring buffer trims to 2.
    await second.dispatch('a', {});
    await second.dispatch('b', {});
    await second.dispatch('c', {});

    expect(second.errors.value).toHaveLength(2);
    expect(second.errorCount.value).toBe(2);
    // Same shared entry - the first caller observes the same trimmed buffer.
    expect(first.errors.value).toHaveLength(2);

    first.dispose();
    second.dispose();
  });

  it('records a rejected dispatch promise that bypassed the bus fan-out', async () => {
    const boom = new Error('reject');
    const rejecting = {
      on: () => () => {},
      dispatch: () => Promise.reject(boom),
    } as any;

    const shared = useSharedCommandState({ bus: rejecting, errorCap: 5 });
    const result = await shared.dispatch('pay', {});

    expect(result).toEqual({ ok: false, error: boom, value: undefined });
    expect(shared.lastError.value).toBe(boom);
    expect(shared.inFlight.value).toBe(0);
    expect(shared.isAnyLoading.value).toBe(false);
    shared.dispose();
  });
});

// ---------------------------------------------------------------------------
// useCommandGroup - name cache eviction
// ---------------------------------------------------------------------------

describe('useCommandGroup name cache', () => {
  it('evicts the oldest cached name past 256 distinct actions', () => {
    const bus = createCommandBus({ onMissing: 'ignore' });
    setCommandBus(bus);
    const seen: string[] = [];
    bus.onBefore((cmd) => { seen.push(cmd.action); });

    const group = useCommandGroup('shop');
    for (let i = 0; i < 260; i++) group.dispatch(`act${i}`, {});
    // Re-dispatch the first action - evicted from the cache, so this re-derives
    // (and re-caches) the prefixed name rather than hitting a stale entry.
    group.dispatch('act0', {});

    expect(seen[0]).toBe('shopAct0');
    expect(seen[259]).toBe('shopAct259');
    expect(seen[260]).toBe('shopAct0');
  });
});

// ---------------------------------------------------------------------------
// useCommandHistory - redo payload variants
// ---------------------------------------------------------------------------

describe('useCommandHistory redo payload marking', () => {
  it('marks a redo via meta.origin, leaving the payload untouched', () => {
    // Was: asserted the redo payload came through as
    // `{ qty: 2, __origin: 'redo' }`. That pinned the MECHANISM (spreading a
    // marker key into the caller's payload), not the contract. The marker now
    // travels out-of-band via `_withOrigin`, so the replayed payload is the
    // caller's original object - same identity, no injected key - and
    // `meta.origin` carries the attribution the hook actually reads.
    const bus = createCommandBus();
    setCommandBus(bus);
    const payloads: any[] = [];
    const origins: unknown[] = [];
    bus.register('act', (cmd: any) => {
      payloads.push(cmd.payload);
      origins.push(cmd.meta?.origin);
      return 1;
    });

    const history = useCommandHistory({});
    const original = { qty: 2 };
    bus.dispatch('act', {}, original);
    history.undo();
    history.redo();

    expect(payloads).toHaveLength(2);
    // No marker key smuggled into user data...
    expect(payloads[1]).toEqual({ qty: 2 });
    // ...and the very same object, not a copy of it.
    expect(payloads[1]).toBe(original);
    // The attribution lives on meta, where the history hook reads it.
    expect(origins).toEqual([undefined, 'redo']);
  });

  it('redispatches a non-markable array payload as-is', ({ bus }) => {
    setCommandBus(bus);
    const payloads: any[] = [];
    bus.register('act', (cmd: any) => { payloads.push(cmd.payload); return 1; });

    const history = useCommandHistory({});
    const arr = [1, 2, 3];
    bus.dispatch('act', {}, arr);
    history.undo();
    history.redo();

    expect(payloads).toHaveLength(2);
    // Cannot carry the marker - the handler must see the original array.
    expect(payloads[1]).toBe(arr);
    // The one-shot identity match consumed the redo: undo still walks back one step.
    expect(history.canUndo.value).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// KeepAlive hooks + error capture via a fake Vue namespace
// ---------------------------------------------------------------------------

describe('KeepAlive wiring through configureVue', () => {
  it('registers hooks via hasInjectionContext and pauses/resumes error capture', async () => {
    vi.resetModules();
    const chamber = await import('../src/chamber');
    const { createCommandBus: freshCreateBus } = await import('../src/command-bus');

    let pause: (() => void) | undefined;
    let resume: (() => void) | undefined;
    chamber.configureVue({
      ref: <T>(v: T) => ({ value: v }),
      hasInjectionContext: () => true,
      onDeactivated: (cb: () => void) => { pause = cb; },
      onActivated: (cb: () => void) => { resume = cb; },
    });

    const bus = freshCreateBus();
    chamber.setCommandBus(bus as any);
    bus.register('fail', () => { throw new Error('handler down'); });

    const capture = chamber.useCommandError({ errorCap: 2 });
    expect(pause).toBeTypeOf('function');
    expect(resume).toBeTypeOf('function');

    bus.dispatch('fail', {});
    expect(capture.errors.value).toHaveLength(1);

    // Deactivated - errors are not captured.
    pause!();
    bus.dispatch('fail', {});
    expect(capture.errors.value).toHaveLength(1);

    // Reactivated - capture resumes; overflow trims to errorCap.
    resume!();
    bus.dispatch('fail', {});
    bus.dispatch('fail', {});
    expect(capture.errors.value).toHaveLength(2);
    expect(capture.latestError.value?.message).toBe('handler down');

    chamber.resetCommandBus();
  });

  it('falls back to getCurrentInstance when hasInjectionContext is absent', async () => {
    vi.resetModules();
    const chamber = await import('../src/chamber');

    let pause: (() => void) | undefined;
    chamber.configureVue({
      ref: <T>(v: T) => ({ value: v }),
      getCurrentInstance: () => ({}),
      onDeactivated: (cb: () => void) => { pause = cb; },
      onActivated: () => {},
    });

    chamber.tryKeepAliveHooks(() => {}, () => {});
    expect(pause).toBeTypeOf('function');
  });
});

// ---------------------------------------------------------------------------
// readGlobal - throwing global getter
// ---------------------------------------------------------------------------

describe('IIFE flag at module load', () => {
  it('wireUntracked returns early when __VC_IIFE__ is set before import', async () => {
    vi.stubGlobal('__VC_IIFE__', true);
    vi.resetModules();
    const chamber = await import('../src/chamber');
    // The module-load probe chain ends in wireUntracked, which must bail on
    // the IIFE guard instead of attempting a bare import() of the peer.
    await chamber.waitForVueDetection();
    expect(chamber.untracked(() => 3)).toBe(3);
  });
});

describe('wireUntracked peer-shape guard', () => {
  it('skips wiring when @vue/reactivity lacks pauseTracking', async () => {
    vi.doMock('@vue/reactivity', () => ({ pauseTracking: undefined, resetTracking: undefined }));
    vi.resetModules();
    try {
      const chamber = await import('../src/chamber');
      await chamber.waitForVueDetection();
      // Not wired - untracked stays a pass-through instead of pausing tracking.
      expect(chamber.untracked(() => 5)).toBe(5);
    } finally {
      vi.doUnmock('@vue/reactivity');
    }
  });
});

describe('readGlobal hardening', () => {
  it('survives a throwing getter on the Vue global slot', async () => {
    vi.resetModules();
    Object.defineProperty(globalThis, '__VAPOR_CHAMBER_VUE__', {
      get() { throw new Error('hostile getter'); },
      configurable: true,
    });
    try {
      const chamber = await import('../src/chamber');
      // Module-load probe already ran readGlobal through the catch; the
      // library stays functional on plain signals.
      await chamber.waitForVueDetection();
      expect(chamber.getVueDeepRefFn()).toBeTypeOf('function'); // async probe found real Vue
    } finally {
      delete (globalThis as any).__VAPOR_CHAMBER_VUE__;
    }
  });
});
