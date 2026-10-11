/**
 * circuitBreaker - a failed half-open probe opens the circuit again.
 *
 * Past `resetTimeout` the circuit goes half-open and lets a dispatch through
 * to probe the backend. A failed probe raised `failCount`, but the trip was
 * gated on `state === 'closed'`, so the circuit stayed half-open: half-open
 * is not `open`, so every later dispatch went through to the failing backend
 * and the circuit never opened again until one succeeded. A failed probe now
 * opens it for another `resetTimeout`, as the reference model in
 * tests/plugins-utilities-verify.ts does.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BusError } from '../src/command-bus';
import { createCommandBus } from '../src/command-bus';
import { circuitBreaker } from '../src/plugins-extra';

describe('circuitBreaker - half-open probe fails', () => {
  it('opens again, and refuses until resetTimeout passes', () => {
    vi.useFakeTimers();
    try {
      const bus = createCommandBus();
      let calls = 0;
      let opens = 0;
      bus.register('op', () => { calls++; throw new Error('down'); });
      const cb = circuitBreaker({ threshold: 2, resetTimeout: 1000, onOpen: () => { opens++; } });
      bus.use(cb);
      bus.dispatch('op', {});
      bus.dispatch('op', {});
      expect(cb.getState('op')).toBe('open');
      expect(calls).toBe(2);

      vi.advanceTimersByTime(1000);
      bus.dispatch('op', {}); // the probe, fails
      expect(calls).toBe(3);
      expect(cb.getState('op')).toBe('open');
      expect(opens).toBe(2);

      const refused = bus.dispatch('op', {});
      expect(calls).toBe(3);
      expect((refused.error as BusError).code).toBe('circuitBreaker:limited:action');
    } finally {
      vi.useRealTimers();
    }
  });
});
