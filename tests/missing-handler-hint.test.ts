/**
 * core:missing:handler in DEV: the other cause, when a plugin could have taken it.
 *
 * A transport is the work only for the actions its pattern covers; any other
 * goes to the handler lookup, which then says "Call bus.register(...) first" -
 * the wrong fix when the action was meant for the transport
 * (docs/rc-alignment-log.md s10.1, B2). In DEV, a bus with a transport names
 * that cause too. Production carries the fact
 * alone: all advice sits behind DEV, which the IIFEs fold at build and a
 * consumer's production build folds, and the fix text is the catalogue's
 * (ERROR_CODE_REGISTRY).
 *
 * The real transport map, not a stand-in: its pattern decides whether the
 * dispatch reaches the handler lookup at all.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const HINT = 'Or declare a transport pattern that covers it.';
const FACT = 'No handler registered for "orderCancel".';
const SHIPPED = `${FACT} Call bus.register("orderCancel", handler) first.`;

/** Fresh modules, so DEV is re-evaluated against the NODE_ENV of the case. */
async function fresh() {
  vi.resetModules();
  const { createAsyncCommandBus, createCommandBus } = await import('../src/command-bus');
  const { httpTransport } = await import('../src/transports');
  return { createAsyncCommandBus, createCommandBus, httpTransport };
}

/** An async bus whose one transport covers `cart*` and nothing else. */
async function bridgedMiss() {
  const { createAsyncCommandBus, httpTransport } = await fresh();
  const fetchStub = vi.fn();
  vi.stubGlobal('fetch', fetchStub);
  const bus = createAsyncCommandBus({ transport: { 'cart*': httpTransport({ endpoint: '/api/vc' }) } });
  const result = await bus.dispatch('orderCancel', { id: 1 });
  return { result, fetchStub };
}

describe('core:missing:handler message', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('DEV, a transport pattern that misses: the message names it', async () => {
    const { result, fetchStub } = await bridgedMiss();
    // Harness guard: the pattern really let it through to the handler lookup.
    expect(fetchStub).not.toHaveBeenCalled();
    expect(result).toFailWith('core:missing:handler');
    expect(result.error?.message.startsWith(SHIPPED)).toBe(true);
    expect(result.error?.message).toContain(HINT);
  });

  it('DEV, no transport declared: the register() advice is the whole story', async () => {
    const { createCommandBus } = await fresh();
    const result = createCommandBus().dispatch('orderCancel', null);
    expect(result.error?.message).toBe(SHIPPED);
  });

  it('production: the fact alone, the fix is the catalogue\'s (docs/contract.md rule 5)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { result } = await bridgedMiss();
    expect(result.error?.message).toBe(FACT);
  });
});
