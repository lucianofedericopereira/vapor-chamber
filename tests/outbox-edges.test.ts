/**
 * Outbox when something is wrong or unusual: flush with no bus, a re-entrant flush, a failed replay with no error, and no `window` (SSR / worker).
 * Why: an offline queue runs on an unreliable network, so a flush without a bus would throw something opaque, two flushes would race and send a record twice, and a missing `window` would crash construction.
 * Shows: flush off a bus rejects with a message naming the fix; a second flush returns the same promise and sends once; a failed replay with no error reaches `isRetryable` as an Error with message 'Unknown error'; listeners bind and unbind once, and without a window dispose() does not throw.
 * See: tests/outbox.test.ts
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createAsyncCommandBus, type CommandResult } from '../src/index';
import { createOutbox } from '../src/outbox';
import { defineTransport } from '../src/transports';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('outbox - flush off a bus', () => {
  it('rejects with an actionable message instead of throwing something opaque', async () => {
    const outbox = createOutbox({ storage: null, autoFlush: false });
    await expect(outbox.flush()).rejects.toThrow(/createAsyncCommandBus\(\{ outbox \}\)/);
  });
});

describe('outbox - flush re-entrancy', () => {
  it('a second flush joins the in-progress one rather than starting a race', async () => {
    let release: (() => void) | null = null as (() => void) | null;
    const gate = new Promise<void>((r) => { release = r; });
    let sends = 0;
    const transport = defineTransport(async () => { sends++; await gate; return { ok: true, value: 'ok', error: undefined }; });

    let online = false;
    const outbox = createOutbox({ storage: null, autoFlush: false, isOnline: () => online });
    const bus = createAsyncCommandBus({ retry: false, transport, outbox });

    await bus.dispatch('sync', 'row-1'); // held while offline
    expect(outbox.pending.value).toBe(1);

    online = true;
    const a = outbox.flush();
    const b = outbox.flush();
    expect(a).toBe(b); // identical promise - the second call joined, it did not re-enter

    release?.();
    await a;
    expect(sends).toBe(1);
  });
});

describe('outbox - without a window', () => {
  it('does not attempt to bind a listener under SSR / workers', () => {
    vi.stubGlobal('window', undefined);
    const outbox = createOutbox({ storage: null, autoFlush: true });
    expect(() => outbox.dispose()).not.toThrow();
  });

  it('binds and unbinds both listeners when a window exists', () => {
    const add = vi.fn();
    const remove = vi.fn();
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });

    const outbox = createOutbox({ storage: null, autoFlush: true });
    expect(add.mock.calls.map((c) => c[0])).toEqual(['online', 'offline']);

    outbox.dispose();
    outbox.dispose(); // idempotent - no second removal
    expect(remove.mock.calls.map((c) => c[0])).toEqual(['online', 'offline']);
  });
});

describe('outbox - a failed replay that carries no error', () => {
  it('is judged with a generic Error, not undefined', async () => {
    let online = false;
    const seen: unknown[] = [];
    const outbox = createOutbox({
      storage: null,
      autoFlush: false,
      isOnline: () => online,
      isRetryable: (error) => { seen.push(error); return true; },
    });
    // The shape a hand-written transport can answer: `ok: false` and no `error`.
    const transport = defineTransport(async () => ({ ok: false, value: undefined }) as unknown as CommandResult);
    const bus = createAsyncCommandBus({ retry: false, transport, outbox });
    await bus.dispatch('sync', 'row-1'); // held while offline

    online = true;
    const summary = await outbox.flush();

    expect(summary).toEqual({ replayed: 0, failed: 1, rejected: 0 });
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toBe('Unknown error');
  });
});
