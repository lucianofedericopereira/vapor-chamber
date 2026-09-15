// @vitest-environment happy-dom
/**
 * FIXTURE - a plugin that throws, or returns a rejected promise, becomes an
 * errResult with code `VC_PLUGIN_THREW`.
 *
 * The bus's contract is "dispatch always returns a result". Before this, a
 * plugin that threw in its own body escaped `buildRunner` / `buildAsyncRunner`
 * before the settle, so after-hooks, `on('*')`, the shared error observer and
 * `isLoading` all missed it, and the throw escaped into the caller (a click
 * handler, a read gate). The conversion sits at the invocation boundary of
 * every plugin, so an OUTER plugin receives the failure through `next()` like
 * any other and its cleanup runs.
 *
 * One error is NOT relabeled: `onMissing: 'throw'` throws (sync bus) or
 * rejects (async bus) from below the chain by contract, and must still reach
 * the caller as itself.
 *
 * Everything runs against the real buses and, for the loading and error
 * observers, the real `useSharedCommandState` on the with-vapor browser dist
 * via `configureVue()` - the same setup as command-loading-fixture.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureVue, useSharedCommandState } from '../src/chamber';
import {
  BusError,
  type AsyncPlugin,
  type CommandResult,
  createAsyncCommandBus,
  createCommandBus,
  type Plugin,
} from '../src/command-bus';
import { createTestBus } from '../src/testing';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  configureVue(await import(/* @vite-ignore */ WITH_VAPOR));
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { errSpy.mockRestore(); });

const boom = new Error('plugin blew up');

function expectThrew(r: CommandResult, action: string, cause: unknown = boom): void {
  expect(r.ok).toBe(false);
  expect(r.error).toBeInstanceOf(BusError);
  const e = r.error as BusError;
  expect(e.code).toBe('VC_PLUGIN_THREW');
  expect(e.emitter).toBe('plugin');
  expect(e.action).toBe(action);
  expect(e.cause).toBe(cause);
}

describe('sync bus - a throwing plugin', () => {
  it('dispatch returns VC_PLUGIN_THREW with the original as cause, and does not throw', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(() => { throw boom; });
    let r!: CommandResult;
    expect(() => { r = bus.dispatch('act', 1); }).not.toThrow();
    expectThrew(r, 'act');
  });

  it('an OUTER plugin receives it through next() and its cleanup runs; hooks and on(*) see the same result', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    const seen: string[] = [];
    let viaNext: CommandResult | undefined;
    const outer: Plugin = (_cmd, next) => {
      try { viaNext = next(); return viaNext; }
      finally { seen.push('outer cleanup'); }
    };
    bus.use(outer, { priority: 10 });
    bus.use(() => { throw boom; }, { priority: 1 });
    let after: CommandResult | undefined;
    let star: CommandResult | undefined;
    bus.onAfter((_c, res) => { after = res; });
    bus.on('*', (_c, res) => { star = res; });

    const r = bus.dispatch('act', 1);
    expectThrew(r, 'act');
    expect(viaNext).toBe(r);
    expect(seen).toEqual(['outer cleanup']);
    expect(after).toBe(r);
    expect(star).toBe(r);
  });

  it('query takes the same path', () => {
    const bus = createCommandBus();
    bus.register('read', () => 'v');
    bus.use(() => { throw boom; });
    expectThrew(bus.query('read', 1), 'read');
  });

  it('request() resolves with it', async () => {
    const bus = createCommandBus();
    bus.respond('qa', () => 'answer');
    bus.use(() => { throw boom; });
    expectThrew(await bus.request('qa', {}), 'qa');
  });

  it('a thrown non-Error is kept as the cause verbatim', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(() => { throw 'a string'; });
    expectThrew(bus.dispatch('act', 1), 'act', 'a string');
  });

  it('DEV: console.error names the throw, so the conversion does not hide the bug', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(() => { throw boom; });
    bus.dispatch('act', 1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('VC_PLUGIN_THREW'), boom);
    expect(String(errSpy.mock.calls[0][0])).toContain('"act"');
  });

  it('production (DEV off): the same result, and nothing logged', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const fresh = await import('../src/command-bus');
    const bus = fresh.createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(() => { throw boom; });
    const r = bus.dispatch('act', 1);
    expect((r.error as { code?: string }).code).toBe('VC_PLUGIN_THREW');
    expect(r.error?.cause).toBe(boom);
    expect(errSpy).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("onMissing: 'throw' is NOT relabeled: it still throws NO_HANDLER through a plugin", () => {
    const bus = createCommandBus({ onMissing: 'throw' });
    bus.use((_c, next) => next());
    let caught: unknown;
    try { bus.dispatch('nobody', 1); } catch (e) { caught = e; }
    expect((caught as BusError).code).toBe('VC_CORE_NO_HANDLER');
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("onMissing: 'throw' settles ONCE before it throws; a plugin that recovers it settles with its own result instead", () => {
    const bus = createCommandBus({ onMissing: 'throw' });
    const star: CommandResult[] = [];
    const after: CommandResult[] = [];
    bus.on('*', (_c, r) => { star.push(r); });
    bus.onAfter((_c, r) => { after.push(r); });
    expect(() => bus.dispatch('nobody', 1)).toThrow('No handler');
    expect(star.map((r) => (r.error as BusError).code)).toEqual(['VC_CORE_NO_HANDLER']);
    expect(after).toEqual(star);

    const recovered = { ok: false, value: undefined, error: new Error('recovered') } as CommandResult;
    bus.use((_c, next) => { try { return next(); } catch { return recovered; } });
    expect(bus.dispatch('nobody', 2)).toBe(recovered);
    expect(star).toHaveLength(2);
    expect(star[1]).toBe(recovered);
  });

  it('isLoading settles back to false and the shared error observer records it', () => {
    const bus = createCommandBus();
    bus.register('svcRestart', () => 'up');
    const shared = useSharedCommandState({ bus });
    const flag = shared.isLoading('svcRestart', 'httpd');
    bus.use(() => { throw boom; });
    const r = bus.dispatch('svcRestart', 'httpd');
    expectThrew(r, 'svcRestart');
    expect(flag.value).toBe(false);
    expect(shared.lastError.value).toBe(r.error);
    shared.dispose();
  });

  it('the TestBus shares the runner, so it converts too', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('act', () => 'ok');
    bus.use(() => { throw boom; });
    expectThrew(bus.dispatch('act', 1), 'act');
  });
});

describe('async bus - a throwing or rejecting plugin', () => {
  it('a synchronous throw resolves to VC_PLUGIN_THREW, never rejects', async () => {
    const bus = createAsyncCommandBus();
    bus.register('act', async () => 'ok');
    bus.use(() => { throw boom; });
    expectThrew(await bus.dispatch('act', 1), 'act');
  });

  it('a rejected promise resolves to VC_PLUGIN_THREW, never rejects', async () => {
    const bus = createAsyncCommandBus();
    bus.register('act', async () => 'ok');
    bus.use(() => Promise.reject(boom));
    expectThrew(await bus.dispatch('act', 1), 'act');
  });

  it('an OUTER plugin sees { ok: false, error } through next().then, its cleanup runs, on(*) fires', async () => {
    const bus = createAsyncCommandBus();
    bus.register('act', async () => 'ok');
    const seen: string[] = [];
    let viaNext: CommandResult | undefined;
    const outer: AsyncPlugin = (_cmd, next) =>
      Promise.resolve(next())
        .then((r) => { viaNext = r; return r; })
        .finally(() => { seen.push('outer cleanup'); });
    bus.use(outer, { priority: 10 });
    bus.use(async () => { throw boom; }, { priority: 1 });
    let star: CommandResult | undefined;
    bus.on('*', (_c, res) => { star = res; });

    const r = await bus.dispatch('act', 1);
    expectThrew(r, 'act');
    expect(viaNext).toBe(r);
    expect(seen).toEqual(['outer cleanup']);
    expect(star).toBe(r);
  });

  it('a pass-through plugin above a rejecting one still resolves VC_PLUGIN_THREW (the inner level converted it)', async () => {
    // The pass-through returns its next() promise unwrapped - the level below
    // already converted - so this pins that skipping the wrap loses nothing.
    const bus = createAsyncCommandBus();
    bus.register('act', async () => 'ok');
    bus.use((_c, next) => next(), { priority: 10 });
    bus.use(() => Promise.reject(boom), { priority: 1 });
    const r = await bus.dispatch('act', 1);
    expectThrew(r, 'act');
    expect((r.error as BusError).context).toEqual({ index: 1 });
  });

  it('query takes the same path', async () => {
    const bus = createAsyncCommandBus();
    bus.register('read', async () => 'v');
    bus.use(() => Promise.reject(boom));
    expectThrew(await bus.query('read', 1), 'read');
  });

  it("onMissing: 'throw' is NOT relabeled: it still rejects NO_HANDLER through a plugin", async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    bus.use((_c, next) => next());
    await expect(bus.dispatch('nobody', 1)).rejects.toMatchObject({ code: 'VC_CORE_NO_HANDLER' });
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("onMissing: 'throw' settles ONCE before it rejects; a plugin that recovers it settles with its own result instead", async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    const star: CommandResult[] = [];
    const after: CommandResult[] = [];
    bus.on('*', (_c, r) => { star.push(r); });
    // An async after-hook: the settle awaits it before re-throwing.
    bus.onAfter(async (_c, r) => { after.push(r); });
    await expect(bus.dispatch('nobody', 1)).rejects.toMatchObject({ code: 'VC_CORE_NO_HANDLER' });
    expect(star.map((r) => (r.error as BusError).code)).toEqual(['VC_CORE_NO_HANDLER']);
    expect(after).toEqual(star);

    const recovered = { ok: false, value: undefined, error: new Error('recovered') } as CommandResult;
    bus.use((_c, next) => (next() as Promise<CommandResult>).catch(() => recovered));
    expect(await bus.dispatch('nobody', 2)).toBe(recovered);
    expect(star).toHaveLength(2);
    expect(star[1]).toBe(recovered);
  });

  it('isLoading settles back to false after a rejecting plugin', async () => {
    const bus = createAsyncCommandBus();
    bus.register('svcRestart', async () => 'up');
    const shared = useSharedCommandState({ bus: bus as any });
    const flag = shared.isLoading('svcRestart', 'httpd');
    bus.use(() => Promise.reject(boom));
    const run = bus.dispatch('svcRestart', 'httpd');
    expect(flag.value).toBe(true);
    expectThrew(await run, 'svcRestart');
    expect(flag.value).toBe(false);
    shared.dispose();
  });
});
