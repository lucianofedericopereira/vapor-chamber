/**
 * The default command id: <time36>-<random36>-<counter36>, with a consecutive counter.
 * Why: an id of another shape (a prefix without its '-', a non-base-36 counter) would break anything that relies on the documented format.
 * Shows: forty ids have three base-36 parts, one shared prefix and a consecutive counter that crosses z to 10, and
 * _resetUid() after configureUid gives the default generator back.
 * See: docs/rc-alignment-log.md s35.213, tests/perf.bench.ts
 */
import { describe, expect, it, vi } from 'vitest';

async function idsFromFreshModule(n: number, reset = false): Promise<string[]> {
  vi.resetModules();
  const mod = await import('../src/command-bus');
  if (reset) {
    mod.configureUid(() => 'swapped');
    mod._resetUid();
  }
  const bus = mod.createCommandBus();
  const ids: string[] = [];
  bus.register('x', () => 1);
  bus.onAfter((cmd) => { ids.push(cmd.meta!.id); });
  for (let i = 0; i < n; i++) bus.dispatch('x', i);
  return ids;
}

function shape(ids: string[]) {
  const parts = ids.map((id) => id.split('-'));
  const counters = parts.map((p) => Number.parseInt(p[2], 36));
  return {
    threeBase36Parts: parts.every((p) => p.length === 3 && p.every((x) => /^[0-9a-z]+$/.test(x))),
    samePrefix: new Set(parts.map((p) => `${p[0]}-${p[1]}`)).size === 1,
    consecutive: counters.every((c, i) => i === 0 || c === counters[i - 1] + 1),
  };
}

describe('the default id', () => {
  it('forty ids: three base-36 parts, one prefix, a consecutive counter across z -> 10', async () => {
    const ids = await idsFromFreshModule(40);
    expect(shape(ids)).toEqual({ threeBase36Parts: true, samePrefix: true, consecutive: true });
    expect(ids.some((id) => id.endsWith('-z')) && ids.some((id) => id.endsWith('-10'))).toBe(true);
  });

  it('_resetUid() after configureUid gives the default back', async () => {
    const ids = await idsFromFreshModule(3, true);
    expect(shape(ids)).toEqual({ threeBase36Parts: true, samePrefix: true, consecutive: true });
  });
});
