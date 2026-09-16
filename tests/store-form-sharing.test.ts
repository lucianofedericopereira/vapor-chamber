/**
 * Two defects with one shape: a shared thing whose lifetime or namespace was
 * owned by whoever got there first.
 *
 * Neither throws. A store keeps returning `ok: false` forever; two forms write
 * into each other's state. Both were measured through the public API before
 * being fixed, and both are the NORMAL usage of the feature - a store exists to
 * be shared, and `bus` is a documented form option.
 */
import { describe, expect, vi } from 'vitest';
import { effectScope } from 'vue';
import { createCommandBus } from '../src/command-bus';
import { createFormBus } from '../src/form';
import { defineChamberStore } from '../src/store';
import { it } from '../src/vitest';

describe('a store shared by two component scopes', () => {
  const makeStore = () =>
    defineChamberStore('cart', {
      state: () => ({ items: [] as number[] }),
      actions: { add: (s, id: number) => ({ items: [...s.items, id] }) },
    });

  it('survives the FIRST holder unmounting while a second still holds it', () => {
    // Measured before the fix: A's unmount ran $dispose(), unregistering the
    // handlers out from under B. B kept a live object whose every action
    // returned ok:false and whose state never changed again.
    const useCart = makeStore();
    const bus = createCommandBus();

    const scopeA = effectScope();
    let a!: ReturnType<typeof useCart>;
    scopeA.run(() => { a = useCart(bus); });

    const scopeB = effectScope();
    let b!: ReturnType<typeof useCart>;
    scopeB.run(() => { b = useCart(bus); });

    expect(a).toBe(b); // shared by construction - that is what a store is
    a.add(1);
    scopeA.stop();

    expect((b.add(2) as { ok: boolean }).ok).toBe(true);
    expect(b.state.value.items).toEqual([1, 2]);
    scopeB.stop();
  });

  it('disposes once the LAST holder goes', () => {
    const useCart = makeStore();
    const bus = createCommandBus();

    const scopeA = effectScope();
    scopeA.run(() => useCart(bus));
    const scopeB = effectScope();
    let b!: ReturnType<typeof useCart>;
    scopeB.run(() => { b = useCart(bus); });

    scopeA.stop();
    scopeB.stop();
    expect((b.add(1) as { ok: boolean })).toFailWith('VC_CORE_NO_HANDLER');

    // A fresh scope gets a fresh store, not the disposed one.
    const scopeC = effectScope();
    let c!: ReturnType<typeof useCart>;
    scopeC.run(() => { c = useCart(bus); });
    expect(c).not.toBe(b);
    expect((c.add(9) as { ok: boolean }).ok).toBe(true);
    scopeC.stop();
  });

  it('leaves a store created outside any scope to its owner', () => {
    const useCart = makeStore();
    const bus = createCommandBus();
    const store = useCart(bus);
    expect((store.add(1) as { ok: boolean }).ok).toBe(true);
    store.$dispose();
    expect((store.add(2) as { ok: boolean })).toFailWith('VC_CORE_NO_HANDLER');
  });
});

describe('two forms on one injected bus', () => {
  it('refuses the second form rather than hijacking the first', () => {
    // Measured before the fix: login.set('email', 'a@b.c') left login.values
    // EMPTY and put the email in signup.values, because the second form
    // re-registered `formSet` over the first one's handler.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = createCommandBus();
    createFormBus({ fields: { email: '' }, bus });

    expect(() => createFormBus({ fields: { nickname: '' }, bus })).toThrow(/already on this bus/);
  });

  it('keeps two ids isolated, writes and all', ({ bus }) => {
    const login = createFormBus({ fields: { email: '' }, bus, id: 'login' });
    const signup = createFormBus({ fields: { nickname: '' }, bus, id: 'signup' });

    login.set('email', 'a@b.c');
    signup.set('nickname', 'luciano');

    expect(login.values.value).toEqual({ email: 'a@b.c' });
    expect(signup.values.value).toEqual({ nickname: 'luciano' });
  });

  it('keeps the historical action names for a single form', ({ bus }) => {
    // The default id is 'form', so a lone form dispatches exactly what it
    // always did - devtools, metrics and logger see no rename.
    const seen: string[] = [];
    bus.onAfter((cmd) => { seen.push(cmd.action); });
    const form = createFormBus({ fields: { email: '' }, bus });
    form.set('email', 'x');
    form.touch('email');
    form.reset();
    expect(seen).toEqual(['formSet', 'formTouch', 'formReset']);
  });

  it('dispose() frees the prefix so a later form can claim it', ({ bus }) => {
    const first = createFormBus({ fields: { email: '' }, bus });
    first.dispose();
    expect(() => createFormBus({ fields: { email: '' }, bus })).not.toThrow();
  });

  it('an isolated bus never collides, however many forms', () => {
    expect(() => {
      createFormBus({ fields: { a: '' } });
      createFormBus({ fields: { b: '' } });
    }).not.toThrow();
  });
});
