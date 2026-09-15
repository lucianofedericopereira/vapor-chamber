/**
 * VC_CORE_NO_HANDLER in DEV: the other cause, when a plugin could have taken it.
 *
 * A transport plugin forwards only the actions its `actions` filter matches;
 * any other falls through `next()` to the handler lookup, which then says
 * "Call bus.register(...) first" - the wrong fix when the action was meant for
 * the transport (rc-alignment-work s10.1, B2). In DEV, a bus with at least one
 * plugin installed now names that cause too. Production keeps the shipped
 * string: the addition sits behind DEV, which the IIFEs fold at build and a
 * consumer's production build folds.
 *
 * The real bridge, not a stand-in: its filter is what decides whether the
 * dispatch reaches the handler lookup at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const HINT = "a transport plugin's `actions` filter did not match";
const SHIPPED = 'No handler registered for "orderCancel". Call bus.register("orderCancel", handler) first.';

/** Fresh modules, so DEV is re-evaluated against the NODE_ENV of the case. */
async function fresh() {
  vi.resetModules();
  const { createAsyncCommandBus, createCommandBus } = await import('../src/command-bus');
  const { createHttpBridge } = await import('../src/transports');
  return { createAsyncCommandBus, createCommandBus, createHttpBridge };
}

/** An async bus whose only plugin is a bridge that forwards `cart*` and nothing else. */
async function bridgedMiss() {
  const { createAsyncCommandBus, createHttpBridge } = await fresh();
  const fetchStub = vi.fn();
  vi.stubGlobal('fetch', fetchStub);
  const bus = createAsyncCommandBus();
  bus.use(createHttpBridge({ endpoint: '/api/vc', actions: ['cart*'] }));
  const result = await bus.dispatch('orderCancel', { id: 1 });
  return { result, fetchStub };
}

describe('VC_CORE_NO_HANDLER message', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('DEV, a bridge whose filter misses: the message names the filter', async () => {
    const { result, fetchStub } = await bridgedMiss();
    // Harness guard: the filter really let it through to the handler lookup.
    expect(fetchStub).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect((result.error as { code?: string }).code).toBe('VC_CORE_NO_HANDLER');
    expect(result.error?.message.startsWith(SHIPPED)).toBe(true);
    expect(result.error?.message).toContain(HINT);
  });

  it('DEV, no plugin installed: the register() advice is the whole story', async () => {
    const { createCommandBus } = await fresh();
    const result = createCommandBus().dispatch('orderCancel', null);
    expect(result.error?.message).toBe(SHIPPED);
  });

  it('production: the shipped string, unchanged', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { result } = await bridgedMiss();
    expect(result.error?.message).toBe(SHIPPED);
  });
});
