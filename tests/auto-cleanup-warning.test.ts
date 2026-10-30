/**
 * tryAutoCleanup's dev warning: a composable used outside an active Vue scope warns at most once per session.
 * Why: a warning per call floods test and non-component output. Own file, so the module-level once-flag starts fresh.
 * Shows: three calls outside any effectScope give one vue:missing:scope warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  useCommandHistory,
  waitForVueDetection,
  setCommandBus,
  resetCommandBus,
} from '../src/chamber';
import { createCommandBus } from '../src/command-bus';

describe('tryAutoCleanup - dev warning dedup', () => {
  beforeEach(() => setCommandBus(createCommandBus()));
  afterEach(() => resetCommandBus());

  it('warns at most once per session when used outside a Vue scope', async () => {
    await waitForVueDetection(); // ensure onScopeDispose is detected (warning path active)
    using warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Three composable calls outside any effectScope - each hits the no-scope path.
    for (let i = 0; i < 3; i++) {
      useCommandHistory().dispose();
    }

    const scopeWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).startsWith('[vapor-chamber] [ WARN ] vue:missing:scope: ') &&
      String(c[0]).includes('ran outside a Vue'),
    );

    expect(scopeWarnings.length).toBe(1); // fired once, then suppressed
  });
});
