/**
 * Guards the dev-warning dedup in tryAutoCleanup: a composable used outside an
 * active Vue scope warns AT MOST ONCE per session, not once per call (which used
 * to flood test/non-component output). Own file so the module-level once-flag
 * starts fresh (vitest isolates modules per file).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useCommandState,
  waitForVueDetection,
  setCommandBus,
  resetCommandBus,
} from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

describe('tryAutoCleanup — dev warning dedup', () => {
  beforeEach(() => setCommandBus(createCommandBus()));
  afterEach(() => resetCommandBus());

  it('warns at most once per session when used outside a Vue scope', async () => {
    await waitForVueDetection(); // ensure onScopeDispose is detected (warning path active)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Three composable calls outside any effectScope — each hits the no-scope path.
    for (let i = 0; i < 3; i++) {
      useCommandState(0, { noop: (s) => s }).dispose();
    }

    const scopeWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes('Heads-up (not an error)') &&
      String(c[0]).includes('ran outside a Vue'),
    );
    warn.mockRestore();

    expect(scopeWarnings.length).toBe(1); // fired once, then suppressed
  });
});
