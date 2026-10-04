/** isLoading's unread slots under the build profile: performance keeps up to 256 per action, lean prunes at 0. The long note is at the end. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build as vite } from 'vite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { useSharedCommandState } from '../src/chamber';
import { type CommandBus, createCommandBus } from '../src/command-bus';
import { vaporChamberWire } from '../src/vite-hmr';
import { requireDist } from './require-dist';

const g = globalThis as { __VC_LEAN__?: boolean };

afterEach(() => {
  delete g.__VC_LEAN__;
});

type Bucket = Map<string, { flag: unknown }>;

/**
 * Run `fn` and return every isLoading bucket it created: the Maps a slot was
 * set into, found by the slot's own `bucket` field. No library hook needed.
 */
function bucketsDuring(fn: () => void): Bucket[] {
  const set = Map.prototype.set;
  const found = new Set<Bucket>();
  Map.prototype.set = function (this: Bucket, k: unknown, v: unknown) {
    if (v !== null && typeof v === 'object' && (v as { bucket?: unknown }).bucket === this) found.add(this);
    return set.call(this, k, v) as never;
  };
  try {
    fn();
  } finally {
    Map.prototype.set = set;
  }
  return [...found];
}

/** The bucket holding `key`, or the one that held it (now empty). */
const bucketWith = (buckets: Bucket[], key: string) => buckets.find((b) => b.has(key)) ?? buckets[buckets.length - 1];

/** A sync bus with tracking armed by another action, so `x` is counted but not read. */
function armed(): { bus: CommandBus; s: ReturnType<typeof useSharedCommandState> } {
  const bus = createCommandBus();
  const s = useSharedCommandState({ bus });
  s.isLoading('other');
  return { bus, s };
}

describe('performance (the default): unread slots kept, bounded per action', () => {
  it('one unread settle keeps its slot at 0; read later, it starts dark and lights on its next dispatch', () => {
    const { bus, s } = armed();
    let probe: (() => void) | null = null;
    bus.register('x', () => probe?.());
    const [b] = bucketsDuring(() => bus.dispatch('x', 'a'));
    expect([b.size, b.has('a')]).toEqual([1, true]);
    const flag = s.isLoading('x', 'a');
    expect(flag.value).toBe(false);
    let during: boolean | undefined;
    probe = () => { during = flag.value; };
    bus.dispatch('x', 'a');
    expect([during, flag.value]).toEqual([true, false]);
    s.dispose();
  });

  it('more than 256 distinct unread targets of one action: the bucket stops at 256, 257 at most in flight', () => {
    const { bus, s } = armed();
    let b: Bucket | undefined;
    let max = 0;
    bus.register('x', () => { if (b) max = Math.max(max, b.size); });
    b = bucketWith(bucketsDuring(() => bus.dispatch('x', 't0')), 't0');
    for (let i = 1; i < 300; i++) bus.dispatch('x', `t${i}`);
    expect(b!.size).toBe(256);
    expect(max).toBe(257);
    // The first 256 are the ones kept; the rest were pruned at their settle.
    expect([b!.has('t0'), b!.has('t255'), b!.has('t256'), b!.has('t299')]).toEqual([true, true, false, false]);
    s.dispose();
  });
});

describe('lean (`__VC_LEAN__` true): every unread slot pruned at 0', () => {
  it('one unread settle leaves the bucket empty; 300 leave it empty', () => {
    g.__VC_LEAN__ = true;
    const { bus, s } = armed();
    bus.register('x', () => {});
    const [b] = bucketsDuring(() => bus.dispatch('x', 'a'));
    expect(b.size).toBe(0);
    for (let i = 0; i < 300; i++) bus.dispatch('x', `t${i}`);
    expect(b.size).toBe(0);
    expect(s.isLoading('x', 'a').value).toBe(false);
    s.dispose();
  });

  it('the profile is read when tracking starts, not per dispatch', () => {
    const { bus, s } = armed(); // performance
    g.__VC_LEAN__ = true;
    bus.register('x', () => {});
    const [b] = bucketsDuring(() => bus.dispatch('x', 'a'));
    expect(b.size).toBe(1);
    s.dispose();
  });
});

describe.each([
  ['performance', false],
  ['lean', true],
])('%s: a read key is never pruned', (_name, lean) => {
  it('its slot and signal survive 300 unread targets and a settle while the bucket is over the bound', () => {
    if (lean) g.__VC_LEAN__ = true;
    const { bus, s } = armed();
    let flag!: ReturnType<typeof s.isLoading>;
    const buckets = bucketsDuring(() => { flag = s.isLoading('x', 'r'); });
    const b = bucketWith(buckets, 'r');
    let during: boolean | undefined;
    bus.register('x', (cmd) => {
      // Settle `r` inside another unread key's dispatch: the bucket is at
      // its fullest (257 in performance), so a prune that ignored the flag
      // would take `r` here.
      if (cmd.payload === 'nest') bus.dispatch('x', 'r');
      if (cmd.target === 'r') during = flag.value;
    });
    for (let i = 0; i < 300; i++) bus.dispatch('x', `t${i}`);
    bus.dispatch('x', 'fresh', 'nest');
    expect(during).toBe(true);
    expect(b.has('r')).toBe(true);
    expect(s.isLoading('x', 'r')).toBe(flag);
    expect(flag.value).toBe(false);
    expect(b.size).toBe(lean ? 1 : 256);
    s.dispose();
  });
});

const repo = process.cwd();
const dist = (f: string) => resolve(repo, 'dist', f);
requireDist(existsSync(dist('index.js')) && existsSync(dist('vapor-chamber.iife.min.js')));

describe('the profile in builds', () => {
  let dir: string;
  beforeAll(() => {
    const cache = resolve(repo, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    dir = mkdtempSync(join(cache, 'vc-lean-'));
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** A minified Vite app build that reaches isLoading on a live path; every chunk joined. */
  async function viteApp(plugins: unknown[], define?: Record<string, string>) {
    const entry = join(dir, 'main.js');
    writeFileSync(entry, `import { useSharedCommandState, getCommandBus } from 'vapor-chamber';
getCommandBus().register('ping', () => 'pong');
const s = useSharedCommandState();
globalThis.go = () => { getCommandBus().dispatch('ping', 1); return s.isLoading('ping', 1).value; };
`);
    const r = await vite({
      configFile: false, root: dir, logLevel: 'silent', mode: 'production', plugins: plugins as never, define,
      build: { write: false, minify: true, modulePreload: false, rollupOptions: { input: entry, external: ['vue', '@vue/reactivity'] } },
    });
    return (Array.isArray(r) ? r : [r]).flatMap((o) => ('output' in o ? o.output : [])).filter((o) => o.type === 'chunk').map((c) => (c as { code: string }).code).join('\n');
  }

  it('control: without the plugin the guard ships, read once per entry', async () => {
    const code = await viteApp([]);
    expect(code).toContain('typeof __VC_LEAN__');
    expect(code).toContain('pruneAbove:256');
  });

  it("profile: 'lean' folds the guard to the write", async () => {
    const code = await viteApp([vaporChamberWire({ profile: 'lean' })]);
    expect(code).not.toContain('__VC_LEAN__');
    expect(code).toMatch(/\.pruneAbove=0/);
  });

  it('the default plugin build folds the guard out: no flag, no write', async () => {
    const code = await viteApp([vaporChamberWire()]);
    expect(code).not.toContain('__VC_LEAN__');
    expect(code).not.toMatch(/\.pruneAbove=0/);
    expect(code).toContain('pruneAbove:256');
  });

  it("an app's own define wins: `__VC_LEAN__: 'true'` plus the plugin with no option builds lean", async () => {
    const code = await viteApp([vaporChamberWire()], { __VC_LEAN__: 'true' });
    expect(code).not.toContain('__VC_LEAN__');
    expect(code).toMatch(/\.pruneAbove=0/);
  });

  it('the shipped files: ESM carries the guard, the IIFEs define it false and fold it', () => {
    expect(readFileSync(dist('chamber.js'), 'utf8')).toContain('typeof __VC_LEAN__');
    for (const f of ['vapor-chamber.iife.min.js', 'vapor-chamber-core.iife.min.js', 'vapor-chamber-elements.iife.min.js']) {
      const code = readFileSync(dist(f), 'utf8');
      expect([f, code.includes('__VC_LEAN__'), /\.pruneAbove=0/.test(code)]).toEqual([f, false, false]);
    }
    expect(readFileSync(dist('vapor-chamber.iife.min.js'), 'utf8')).toContain('pruneAbove:256');
  });
});

/*
 * The build profile (owner, 2026-10-02, decisions; log s35.61, s35.62). A
 * speed-against-memory trade goes behind ONE build-time toggle:
 * `vaporChamberWire({ profile: 'lean' })` defines `__VC_LEAN__` true; no option,
 * or 'performance', defines it false, and the IIFEs define it false. An app's
 * own define of it is left alone.
 *
 * isLoading option b is the first trade. A key nobody reads used to get a slot
 * on every dispatch and lose it at the settle (an allocation, a Map set and a
 * Map delete per tracked dispatch). Performance keeps that slot at 0 and prunes
 * only when its action's bucket holds more than 256, so a bucket stops at 256
 * at rest and 257 in flight (the slot being settled is counted). Lean prunes at
 * 0, as before. A read slot (one with a signal) is never pruned in either:
 * its readers hold the signal and later dispatches must write that one; the
 * nested settle in the read-key test is where the bucket is fullest.
 *
 * The flag is read once per entry, when tracking starts (trackLoading), never
 * per dispatch: a `typeof` of a global nobody defined is a slow lookup
 * (docs/V8-RULES.md rule 6). The settle compares against `entry.pruneAbove`.
 * Without a define (a bundler without the plugin) that `typeof` ships and runs
 * once per entry; vitest delivers a define as a global, which is how the lean
 * tests set it, and the afterEach removes it so it cannot reach another test.
 *
 * Buckets are found by spying Map.prototype.set for a value whose `bucket` is
 * the Map itself, so no inspection API ships for the test.
 */
