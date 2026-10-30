/**
 * emitDOMEvent (src/widget.ts): a component's emit() as a real DOM CustomEvent on the widget tag.
 * Why: Vue's emit stays inside Vue's event system, and a host page subscribes with addEventListener.
 * Shows: name and detail arrive; the return reports preventDefault; bubbles and composed by default, overridable; no CustomEvent or no element is a no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { emitDOMEvent } from '../src/widget';

// Node's own EventTarget and CustomEvent stand in for an element: no DOM environment is needed.
describe('emitDOMEvent', () => {
  let host: Element;

  beforeEach(() => {
    host = new EventTarget() as unknown as Element;
  });

  afterEach(() => {
    // Nothing to clean up - the EventTarget is GC'd.
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

  it('passes detail of any type - primitives, arrays, objects, null', () => {
    const captured: any[] = [];
    host.addEventListener('any', (e) => captured.push((e as CustomEvent).detail));

    emitDOMEvent(host, 'any', 42);
    emitDOMEvent(host, 'any', 'string');
    emitDOMEvent(host, 'any', [1, 2, 3]);
    emitDOMEvent(host, 'any', { nested: { value: true } });
    emitDOMEvent(host, 'any', null);
    emitDOMEvent(host, 'any', undefined);

    // CustomEvent coerces an undefined detail to null: platform behaviour, not ours.
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
