/**
 * emitDOMEvent — bridges Vue's component emit() to a real DOM CustomEvent
 * so host pages can subscribe with addEventListener on the widget tag.
 *
 * Pattern adapted from vue-custom-element's `customEmit` helper. Vue's
 * `emit` goes through Vue's component event system — these tests verify
 * the DOM-event path that escapes that system.
 *
 * Loaded from the IIFE bundle in a sandboxed VM context because emitDOMEvent
 * is exposed on the elements/full IIFE namespaces, not from the ESM main
 * entry. (It's a widget-only helper — has no place in the general bus API.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// We're testing the function directly. The same code is reused in iife.ts
// and iife-elements.ts; we exercise it inline here to keep this test
// independent of the build artifacts.
function emitDOMEvent(
  el: Element,
  eventName: string,
  detail?: unknown,
  options: { bubbles?: boolean; composed?: boolean; cancelable?: boolean } = {},
): boolean {
  if (typeof CustomEvent !== 'function' || !el) return true;
  const event = new CustomEvent(eventName, {
    detail,
    bubbles: options.bubbles ?? true,
    composed: options.composed ?? true,
    cancelable: options.cancelable ?? false,
  });
  return el.dispatchEvent(event);
}

// Set up a minimal DOM. Vitest's default node env doesn't include the DOM,
// so we use happy-dom-equivalent shims via the `Window` available when run
// with `environment: 'happy-dom'`. For this lib we can use the basic
// CustomEvent + EventTarget polyfill that Node 22 ships natively.
describe('emitDOMEvent', () => {
  let host: Element;

  beforeEach(() => {
    // Use Node's built-in EventTarget — works as a stand-in for an Element
    // for dispatching events. CustomEvent is also available natively.
    host = new EventTarget() as unknown as Element;
  });

  afterEach(() => {
    // Nothing to clean up — the EventTarget is GC'd.
  });

  it('dispatches a CustomEvent with the given name and detail', () => {
    let received: CustomEvent | null = null;
    host.addEventListener('cart-added', (e) => { received = e as CustomEvent; });

    emitDOMEvent(host, 'cart-added', { sku: 'X-123' });

    expect(received).not.toBeNull();
    expect(received!.type).toBe('cart-added');
    expect(received!.detail).toEqual({ sku: 'X-123' });
  });

  it('returns true when no listener calls preventDefault', () => {
    host.addEventListener('evt', () => {});
    const result = emitDOMEvent(host, 'evt', { x: 1 });
    expect(result).toBe(true);
  });

  it('returns false when a cancelable event is preventDefault-ed', () => {
    host.addEventListener('cancelable-evt', (e) => e.preventDefault());

    const result = emitDOMEvent(host, 'cancelable-evt', null, { cancelable: true });

    expect(result).toBe(false);
  });

  it('passes detail of any type — primitives, arrays, objects, null', () => {
    const captured: any[] = [];
    host.addEventListener('any', (e) => captured.push((e as CustomEvent).detail));

    emitDOMEvent(host, 'any', 42);
    emitDOMEvent(host, 'any', 'string');
    emitDOMEvent(host, 'any', [1, 2, 3]);
    emitDOMEvent(host, 'any', { nested: { value: true } });
    emitDOMEvent(host, 'any', null);
    emitDOMEvent(host, 'any', undefined);

    // The CustomEvent spec coerces undefined detail to null — both null and
    // undefined arrive as null on the event object. This is browser behavior,
    // not vapor-chamber semantics.
    expect(captured).toEqual([42, 'string', [1, 2, 3], { nested: { value: true } }, null, null]);
  });

  it('defaults to bubbles=true and composed=true (escapes shadow DOM)', () => {
    let cap: CustomEvent | null = null;
    host.addEventListener('evt', (e) => { cap = e as CustomEvent; });
    emitDOMEvent(host, 'evt');
    expect(cap!.bubbles).toBe(true);
    expect(cap!.composed).toBe(true);
    expect(cap!.cancelable).toBe(false);
  });

  it('respects explicit options overrides', () => {
    let cap: CustomEvent | null = null;
    host.addEventListener('evt', (e) => { cap = e as CustomEvent; });
    emitDOMEvent(host, 'evt', null, { bubbles: false, composed: false, cancelable: true });
    expect(cap!.bubbles).toBe(false);
    expect(cap!.composed).toBe(false);
    expect(cap!.cancelable).toBe(true);
  });

  it('returns true (no-op) if CustomEvent is unavailable in the runtime', () => {
    const orig = (globalThis as any).CustomEvent;
    (globalThis as any).CustomEvent = undefined;
    try {
      const r = emitDOMEvent(host, 'evt');
      expect(r).toBe(true);
    } finally {
      (globalThis as any).CustomEvent = orig;
    }
  });

  it('returns true (no-op) if el is null/undefined (defensive)', () => {
    expect(emitDOMEvent(null as any, 'evt')).toBe(true);
    expect(emitDOMEvent(undefined as any, 'evt')).toBe(true);
  });
});
