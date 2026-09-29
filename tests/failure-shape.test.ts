// @vitest-environment happy-dom
/**
 * The failure shape of docs/plan-failures-and-contract.md 4.5, from the outside.
 *
 * - `toJSON()` is the failure as an RFC 9457 problem with the members it needs:
 *   `detail`, `code`, `action`, the context as extensions, `type` implicit.
 * - `code` is read-only: the owner is the wiring's and the condition is the
 *   raiser's, so no holder can rewrite either.
 * - Production messages state the fact; the fix sentence is DEV's, and the
 *   catalogue (`ERROR_CODE_REGISTRY` `fix`) is where a production reader finds
 *   it (plan settled item 5). Each gated site is read here in production.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BusError, createCommandBus, conditionOf, ownerOf } from '../src/command-bus';
import { stubEnv } from '../src/vitest-pure';

afterEach(() => {
  vi.resetModules();
});

/** The modules again, evaluated with DEV folded to false. */
async function production() {
  vi.resetModules();
  return {
    bus: await import('../src/command-bus'),
    io: await import('../src/plugins-io'),
    vapor: await import('../src/chamber-vapor'),
  };
}

describe('toJSON: the members a problem needs', () => {
  it('detail, code, action and the context as extensions; no type', () => {
    const bus = createCommandBus();
    bus.register('save', () => 'ok', { throttle: 10_000 });
    bus.dispatch('save', 1);
    const refused = bus.dispatch('save', 1).error as BusError;

    const problem = JSON.parse(JSON.stringify(refused));
    expect(problem).toEqual({
      detail: refused.message,
      code: 'core:limited:handler',
      action: 'save',
      retryIn: expect.any(Number),
      wait: 10_000,
    });
    expect(problem).not.toHaveProperty('type');
  });

  it('a failure with no action or context serializes without them', () => {
    const e = new BusError('invalid:payload', 'bad');
    expect(JSON.parse(JSON.stringify(e))).toEqual({ detail: 'bad', code: 'app:invalid:payload' });
  });
});

describe('a code outside the vocabulary', () => {
  it('warns in DEV, naming the code, and still builds the error', () => {
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const e = new BusError('VC_CORE_HANDLER_THREW' as never, 'from plain JS');
    expect(e.code).toBe('app:VC_CORE_HANDLER_THREW');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"VC_CORE_HANDLER_THREW" is not condition:subject'));
  });

  it('is silent for a code in the vocabulary, and a subject may hold colons', () => {
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new BusError('limited:quota', 'x');
    new BusError('refused:gitea:signin' as never, 'x');
    expect(warn).not.toHaveBeenCalled();
  });

  it('is silent in production', async () => {
    using _env = stubEnv('NODE_ENV', 'production');
    const { bus } = await production();
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    new bus.BusError('VC_CORE_HANDLER_THREW' as never, 'x');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the code is read-only', () => {
  it('cannot be rewritten, so neither the owner nor the condition can', () => {
    const e = createCommandBus().dispatch('missing', 1).error as BusError;
    expect(() => { (e as { code: string }).code = 'core:limited:handler'; }).toThrow(TypeError);
    expect(e.code).toBe('core:missing:handler');
    expect(ownerOf(e)).toBe('core');
    expect(conditionOf(e)).toBe('missing');
  });
});

describe('production messages carry the fact, not the fix', () => {
  it('a sealed bus', async () => {
    using _env = stubEnv('NODE_ENV', 'production');
    const { bus } = await production();
    const b = bus.createCommandBus();
    b.seal();
    expect(() => b.register('x', () => 1)).toThrow(/^Cannot call register\(\) on a sealed bus\.$/);
  });

  it('the dispatch depth', async () => {
    using _env = stubEnv('NODE_ENV', 'production');
    const { bus } = await production();
    const b = bus.createCommandBus();
    b.register('loop', () => b.dispatch('loop', 1));
    let r = b.dispatch('loop', 1);
    // Each level hands back the one below it; the innermost is the refusal.
    while (r.ok) r = r.value as typeof r;
    expect(r.error?.message).toMatch(/^Maximum dispatch depth \(\d+\) exceeded for "loop"\.$/);
  });

  it('a request that times out', async () => {
    using _env = stubEnv('NODE_ENV', 'production');
    const { bus } = await production();
    const b = bus.createCommandBus();
    b.respond('slow', () => new Promise((resolve) => setTimeout(() => resolve('done'), 200)));
    const r = await b.request('slow', {}, undefined, { timeout: 10 });
    expect(r.error?.message).toBe('Request "slow" timed out after 10ms.');
  });

  it('a naming violation', async () => {
    using _env = stubEnv('NODE_ENV', 'production');
    const { bus } = await production();
    const b = bus.createCommandBus({ naming: { pattern: /^[a-z]+$/, onViolation: 'throw' } });
    expect(() => b.register('Bad', () => 1)).toThrow(/^\[vapor-chamber\] Action "Bad" does not match naming pattern \/\^\[a-z\]\+\$\/\.$/);
  });

  it('createVaporChamberApp without Vapor keeps the diagnosis, drops the advice', async () => {
    using _env = stubEnv('NODE_ENV', 'production');
    const { vapor } = await production();
    expect(() => vapor.createVaporChamberApp({})).toThrow(/Pass it: configureVue\(Vue\)\.$/);
  });

  it('persist: a stored value that fails validation', async () => {
    using _env = stubEnv('NODE_ENV', 'production');
    const { io } = await production();
    const storage = { getItem: () => '{"n":1}', setItem() {}, removeItem() {} };
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = io.persist({ key: 'k', storage: storage as never, getState: () => ({}), validate: () => false });
    expect(p.load()).toBeNull();
    expect(warn).toHaveBeenCalledWith('[vapor-chamber] persist: validation failed for key "k" - returning null.');
  });
});
