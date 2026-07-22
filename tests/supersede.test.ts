/**
 * Tests for the `supersede` plugin — auto-abort the previous in-flight
 * dispatch for the same key, so a rapid second dispatch (search-as-you-type,
 * a filter changing mid-fetch) cancels the stale one instead of racing it.
 */
import { describe, it, expect } from 'vitest';
import { createAsyncCommandBus } from '../src/command-bus';
import { supersede } from '../src/plugins-extra';

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

describe('supersede plugin', () => {
  it('aborts the previous in-flight dispatch for the same key', async () => {
    const bus = createAsyncCommandBus();
    const abortedTerms: string[] = [];
    bus.use(supersede());
    bus.register('search', async (cmd) => {
      const term = (cmd.payload as any).term;
      cmd.signal?.addEventListener('abort', () => abortedTerms.push(term));
      await tick(10);
      return term;
    });

    const first = bus.dispatch('search', {}, { term: 'a' });
    await tick(0); // let the first dispatch register its abort listener
    const second = bus.dispatch('search', {}, { term: 'ab' }); // same key ('search:{}') supersedes it

    const [r1, r2] = await Promise.all([first, second]);
    expect(abortedTerms).toEqual(['a']);
    expect(r1.ok && r1.value).toBe('a'); // the aborted dispatch still resolves; abort is advisory
    expect(r2.ok && r2.value).toBe('ab');
  });

  it('different keys race independently — no cross-cancellation', async () => {
    const bus = createAsyncCommandBus();
    const aborted: string[] = [];
    bus.use(supersede());
    bus.register('search', async (cmd) => {
      const field = (cmd.target as any).field;
      cmd.signal?.addEventListener('abort', () => aborted.push(field));
      await tick(5);
      return field;
    });

    const [a, b] = await Promise.all([
      bus.dispatch('search', { field: 'name' }, { term: 'x' }),
      bus.dispatch('search', { field: 'email' }, { term: 'y' }),
    ]);
    expect(aborted).toEqual([]);
    expect(a.ok && a.value).toBe('name');
    expect(b.ok && b.value).toBe('email');
  });

  it('distinct actions never collide, even with the same target — actions are never dropped', async () => {
    const bus = createAsyncCommandBus();
    bus.use(supersede());
    bus.register('search', async () => { await tick(5); return 'searched'; });
    bus.register('save', async () => { await tick(5); return 'saved'; });

    // Same target ({}) but different actions — commandKey includes the
    // action name, so these must never supersede each other.
    const [a, b] = await Promise.all([
      bus.dispatch('search', {}),
      bus.dispatch('save', {}),
    ]);
    expect(a.ok && a.value).toBe('searched');
    expect(b.ok && b.value).toBe('saved');
  });

  it('honors a custom key and skips superseding on a null key', async () => {
    const bus = createAsyncCommandBus();
    let aborts = 0;
    bus.use(supersede({ key: (cmd) => (cmd.target as any).lane ?? null }));
    bus.register('act', async (cmd) => {
      cmd.signal?.addEventListener('abort', () => { aborts++; });
      await tick(5);
      return 1;
    });

    const first = bus.dispatch('act', { lane: 'x' });
    await tick(0);
    const second = bus.dispatch('act', { lane: 'x' }); // same lane → supersedes
    await Promise.all([first, second]);
    expect(aborts).toBe(1);

    aborts = 0;
    await Promise.all([
      bus.dispatch('act', { lane: null }),
      bus.dispatch('act', { lane: null }), // null key → never superseded
    ]);
    expect(aborts).toBe(0);
  });

  it('actions filter scopes which commands are superseded', async () => {
    const bus = createAsyncCommandBus();
    let aborts = 0;
    bus.use(supersede({ actions: ['search*'] }));
    bus.register('ping', async (cmd) => {
      cmd.signal?.addEventListener('abort', () => { aborts++; });
      await tick(5);
      return 1;
    });

    const first = bus.dispatch('ping', {});
    await tick(0);
    const second = bus.dispatch('ping', {});
    await Promise.all([first, second]);
    expect(aborts).toBe(0); // 'ping' not in scope → not superseded
  });

  it('merges with a caller-supplied signal — either source can abort', async () => {
    const bus = createAsyncCommandBus();
    let sawAbort = false;
    bus.use(supersede());
    bus.register('search', async (cmd) => {
      cmd.signal?.addEventListener('abort', () => { sawAbort = true; });
      await tick(10);
      return 1;
    });

    const ctrl = new AbortController();
    const p = bus.dispatch('search', {}, {}, { signal: ctrl.signal });
    await tick(0);
    ctrl.abort(); // the CALLER's signal fires — not a supersede — and must still propagate
    await p;
    expect(sawAbort).toBe(true);
  });

  it('a third dispatch after two supersedes still lands cleanly', async () => {
    const bus = createAsyncCommandBus();
    bus.use(supersede());
    bus.register('search', async (cmd) => {
      await tick(5);
      return (cmd.payload as any).term;
    });

    const p1 = bus.dispatch('search', {}, { term: 'a' });
    await tick(0);
    const p2 = bus.dispatch('search', {}, { term: 'ab' });
    await tick(0);
    const p3 = bus.dispatch('search', {}, { term: 'abc' });

    const [, , r3] = await Promise.all([p1, p2, p3]);
    expect(r3.ok && r3.value).toBe('abc');
  });
});
