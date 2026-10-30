/**
 * In Chromium: `_combineSignals`' fallback matches the native `AbortSignal.any`, and a bridge's scope cancels its request without it.
 * Why: the IIFEs target browsers, so the case a browser user meets runs in that engine; the DOM spec reports the first signal to abort.
 * Shows: native and fallback both report the first to abort; disposing the scope cancels a request when the bridge has its own signal, with and without AbortSignal.any.
 * See: log 36.13, tests/combine-signals.test.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsyncCommandBus } from '../../src/command-bus';
import { httpTransport } from '../../src/transports';
import { _combineSignals } from '../../src/http';

const nativeAny = AbortSignal.any;
afterEach(() => {
  AbortSignal.any = nativeAny;
  vi.unstubAllGlobals();
});

/** b aborts, then a, with no read between (Node's native then reports the first input, not the spec's): the reason it reports. */
function reasonAfterTwoAborts(): unknown {
  const a = new AbortController();
  const b = new AbortController();
  const { signal } = _combineSignals(a.signal, b.signal);
  const rb = new Error('b');
  b.abort(rb);
  a.abort(new Error('a'));
  return signal.reason === rb ? 'b' : (signal.reason as Error).message;
}

describe('_combineSignals in Chromium', () => {
  it('native and fallback report the first input to abort', () => {
    expect(typeof AbortSignal.any).toBe('function');
    const native = reasonAfterTwoAborts();
    delete (AbortSignal as { any?: unknown }).any;
    expect([native, reasonAfterTwoAborts()]).toEqual(['b', 'b']);
  });
});

describe.each([['without AbortSignal.any', true], ['native (control)', false]])('httpTransport, %s', (_name, fallback) => {
  it('disposing the scope cancels a request when the bridge has its own signal too', async () => {
    if (fallback) delete (AbortSignal as { any?: unknown }).any;
    const sent: AbortSignal[] = [];
    vi.stubGlobal('fetch', (_u: string, init: { signal: AbortSignal }) => {
      sent.push(init.signal);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(new Response('{"state":"saved"}', { status: 200 })), 300);
        init.signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
      });
    });
    const scope = new AbortController();
    const bus = createAsyncCommandBus({ retry: false, transport: httpTransport({ endpoint: '/api', signal: new AbortController().signal, scopeController: scope }) });
    setTimeout(() => scope.abort(), 5);
    const r = await bus.dispatch('save', {});
    expect([r.ok, (r.error as { code?: string })?.code, sent[0].aborted]).toEqual([false, 'core:aborted:dispatch', true]);
  });
});
