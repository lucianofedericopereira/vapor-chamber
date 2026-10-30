// @vitest-environment happy-dom
/**
 * A plugin part (rule or step) of an id-less plugin that throws or answers a rejected promise becomes `plugin:failed:plugin` on the sync, async and test buses.
 * Why: dispatch always returns a result, so a plugin throw must never escape into the caller (a click handler, a read gate) and must reach after-hooks, `on('*')`, the command state and `pending`; `onMissing: 'throw'` is the one error that keeps throwing, by contract.
 * Shows: the result carries the original as `cause` and the part name in `context`; query and request() take the same path; a non-Error throw is kept verbatim; DEV logs the throw and production logs nothing; `onMissing: 'throw'` still throws or rejects `core:missing:handler`, settled once; `pending` returns to false and the shared error observer records the result. Runs on the real buses and the with-vapor browser dist through `configureVue()`.
 * See: log s36.108.
 */

import { afterEach, beforeEach, describe, expect, vi } from 'vitest';
import { configureVue, useSharedCommandState } from '../src/chamber';
import { BusError, type CommandResult, createAsyncCommandBus, createCommandBus, ownerOf } from '../src/command-bus';
import { createTestBus } from '../src/testing';
import { stubEnv } from '../src/vitest-pure';
import { it } from '../src/vitest';

const WITH_VAPOR = 'vue/dist/vue.runtime-with-vapor.esm-browser.js';

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  configureVue(await import(/* @vite-ignore */ WITH_VAPOR));
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { errSpy.mockRestore(); });

const boom = new Error('plugin blew up');
/** A step that throws, and one whose answer rejects. */
const throwing = { admit: () => { throw boom; } };
const rejecting = { reuse: () => Promise.reject(boom) };

function expectThrew(r: CommandResult, action: string, part: string, cause: unknown = boom): void {
  expect(r).toFailWith('plugin:failed:plugin');
  expect(r.error).toBeInstanceOf(BusError);
  const e = r.error as BusError;
  expect(ownerOf(e)).toBe('plugin');
  expect(e.action).toBe(action);
  expect(e.cause).toBe(cause);
  expect(e.context).toEqual({ part });
}

describe('sync bus - a throwing part', () => {
  it('dispatch returns plugin:failed:plugin with the original as cause, and does not throw', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(throwing);
    let r!: CommandResult;
    expect(() => { r = bus.dispatch('act', 1); }).not.toThrow();
    expectThrew(r, 'act', 'admit');
  });

  it('after-hooks and on(*) see the same result', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(throwing);
    let after: CommandResult | undefined;
    let star: CommandResult | undefined;
    bus.onAfter((_c, res) => { after = res; });
    bus.on('*', (_c, res) => { star = res; });
    const r = bus.dispatch('act', 1);
    expectThrew(r, 'act', 'admit');
    expect(after).toBe(r);
    expect(star).toBe(r);
  });

  it('query and request() take the same path', async () => {
    const bus = createCommandBus();
    bus.register('read', () => 'v');
    bus.respond('qa', () => 'answer');
    bus.use(throwing);
    expectThrew(bus.query('read', 1), 'read', 'admit');
    expectThrew(await bus.request('qa', {}), 'qa', 'admit');
  });

  it('a thrown non-Error is kept as the cause verbatim, and a rule throwing names its part', () => {
    const bus = createCommandBus();
    bus.register('act', () => 'ok');
    bus.use({ admit: () => { throw 'a string'; } });
    expectThrew(bus.dispatch('act', 1), 'act', 'admit', 'a string');
    const ruled = createCommandBus();
    ruled.register('act', () => 'ok');
    ruled.use({ validate: () => () => { throw boom; } });
    expectThrew(ruled.dispatch('act', 1), 'act', 'validate');
  });

  it('DEV: console.error names the throw, so the conversion does not hide the bug', ({ bus }) => {
    bus.register('act', () => 'ok');
    bus.use(throwing);
    bus.dispatch('act', 1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('plugin:failed:plugin'), boom);
    expect(String(errSpy.mock.calls[0][0])).toContain('"act"');
  });

  it('production (DEV off): the same result, and nothing logged', async () => {
    using _NODE_ENV = stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    const fresh = await import('../src/command-bus');
    const bus = fresh.createCommandBus();
    bus.register('act', () => 'ok');
    bus.use(throwing);
    const r = bus.dispatch('act', 1);
    expect((r.error as { code?: string }).code).toBe('plugin:failed:plugin');
    expect(r.error?.cause).toBe(boom);
    expect(errSpy).not.toHaveBeenCalled();
    vi.resetModules();
  });

  it("onMissing: 'throw' is NOT relabeled: it still throws NO_HANDLER past a step, settled once", () => {
    const bus = createCommandBus({ onMissing: 'throw' });
    const landed: CommandResult[] = [];
    bus.use({ begin: () => ({ landed: (r: CommandResult) => { landed.push(r); } }) });
    const star: CommandResult[] = [];
    bus.on('*', (_c, r) => { star.push(r); });
    let caught: unknown;
    try { bus.dispatch('nobody', 1); } catch (e) { caught = e; }
    expect((caught as BusError).code).toBe('core:missing:handler');
    expect(star.map((r) => (r.error as BusError).code)).toEqual(['core:missing:handler']);
    expect(landed.map((r) => (r.error as BusError).code)).toEqual(['core:missing:handler']);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('pending settles back to false and the shared error observer records it', () => {
    const bus = createCommandBus();
    bus.register('svcRestart', () => 'up');
    const shared = useSharedCommandState({ bus });
    const flag = shared.pending('svcRestart', 'httpd');
    bus.use(throwing);
    const r = bus.dispatch('svcRestart', 'httpd');
    expectThrew(r, 'svcRestart', 'admit');
    expect(flag.value).toBe(false);
    expect(shared.lastError.value).toBe(r.error);
    shared.dispose();
  });

  it('the TestBus runs the same steps, so it converts too', () => {
    const bus = createTestBus({ passthroughHandlers: true });
    bus.register('act', () => 'ok');
    bus.use(throwing);
    expectThrew(bus.dispatch('act', 1), 'act', 'admit');
  });
});

describe('async bus - a throwing or rejecting part', () => {
  it('a synchronous throw resolves to plugin:failed:plugin, never rejects', async () => {
    const bus = createAsyncCommandBus();
    bus.register('act', async () => 'ok');
    bus.use(throwing);
    expectThrew(await bus.dispatch('act', 1), 'act', 'admit');
  });

  it('a rejected answer resolves to plugin:failed:plugin, never rejects, and on(*) fires', async () => {
    const bus = createAsyncCommandBus();
    bus.register('act', async () => 'ok');
    bus.use(rejecting);
    let star: CommandResult | undefined;
    bus.on('*', (_c, res) => { star = res; });
    const r = await bus.dispatch('act', 1);
    expectThrew(r, 'act', 'reuse');
    expect(star).toBe(r);
  });

  it('query takes the same path', async () => {
    const bus = createAsyncCommandBus();
    bus.register('read', async () => 'v');
    bus.use(rejecting);
    expectThrew(await bus.query('read', 1), 'read', 'reuse');
  });

  it("onMissing: 'throw' is NOT relabeled: it still rejects NO_HANDLER past a step, settled once", async () => {
    const bus = createAsyncCommandBus({ onMissing: 'throw' });
    bus.use({ begin: () => undefined });
    const star: CommandResult[] = [];
    const after: CommandResult[] = [];
    bus.on('*', (_c, r) => { star.push(r); });
    // The settle awaits an async after-hook before re-throwing.
    bus.onAfter(async (_c, r) => { after.push(r); });
    await expect(bus.dispatch('nobody', 1)).rejects.toMatchObject({ code: 'core:missing:handler' });
    expect(star.map((r) => (r.error as BusError).code)).toEqual(['core:missing:handler']);
    expect(after).toEqual(star);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('pending settles back to false after a rejecting part', async () => {
    const bus = createAsyncCommandBus();
    bus.register('svcRestart', async () => 'up');
    const shared = useSharedCommandState({ bus: bus as any });
    const flag = shared.pending('svcRestart', 'httpd');
    bus.use(rejecting);
    const run = bus.dispatch('svcRestart', 'httpd');
    expect(flag.value).toBe(true);
    expectThrew(await run, 'svcRestart', 'reuse');
    expect(flag.value).toBe(false);
    shared.dispose();
  });
});
