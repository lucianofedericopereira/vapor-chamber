/**
 * circuitBreaker: a failed half-open probe opens the circuit again.
 * Why: a circuit left half-open after a failed probe sends every later dispatch to the failing backend until one succeeds.
 * Shows: after resetTimeout the probe runs and fails, the circuit is open again (onOpen twice), and the next dispatch is refused without a call.
 * See: tests/plugins-utilities-verify.ts.
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
