/**
 * The A/B tool's statistics and verdict, kept free of I/O so tests can feed
 * it synthetic replicates (tests/ab-stats.test.ts). The specification is
 * docs/V8-RULES.md rule 16; the reasons for each gate are log s35.44, s35.45
 * and s35.48.
 *
 * A REPLICATE is one child process: { order: ['A','B'] or ['B','A'], fns: {
 * fn: { n, A: arm, B: arm } } }, an arm being per-round arrays of ns per
 * iteration: `wall`, `thr` (main-thread CPU), `cpu` (process CPU), and `gc`
 * (per round, { gcType: [count, us] }).
 *
 * Per replicate and function, each arm is summarized by the 20th percentile
 * of its wall times (the round closest to an uncontended run), d = log(B / A).
 * Across replicates: the median of d, its bootstrap 95% interval, an exact
 * sign-flip test, and the spread 1.4826 x MAD. The A/A CONTROL run of the
 * same session gives each function its spread and centre.
 */

/** Deterministic PRNG (mulberry32), so a bootstrap is reproducible. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const median = (xs) => {
  const s = [...xs].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const mad = (xs) => {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
};
/** Index of the p-quantile round (lower), so other clocks can be read at that same round. */
export const pctIndex = (xs, p) => {
  const idx = xs.map((_, i) => i).sort((i, j) => xs[i] - xs[j]);
  return idx[Math.min(xs.length - 1, Math.floor(p * xs.length))];
};
const T975 = [0, 12.71, 4.3, 3.18, 2.78, 2.57, 2.45, 2.36, 2.31, 2.26, 2.23, 2.2, 2.18, 2.16, 2.14, 2.13, 2.12, 2.11, 2.1, 2.09, 2.09];
export const t975 = (df) => T975[Math.min(Math.max(df, 1), T975.length - 1)];

export function bootCI(d, random = rng(7), reps = 4000) {
  const b = Array.from({ length: reps }, () => median(d.map(() => d[Math.floor(random() * d.length)]))).sort((x, y) => x - y);
  return [b[Math.floor(0.025 * reps)], b[Math.ceil(0.975 * reps) - 1]];
}

/** Exact two-sided sign-flip test of the median (2^K patterns; K is small). */
export function signFlipP(d) {
  const obs = Math.abs(median(d));
  const total = 2 ** d.length;
  let worse = 0;
  for (let m = 0; m < total; m++) {
    if (Math.abs(median(d.map((v, i) => (Math.floor(m / 2 ** i) % 2 ? -v : v)))) >= obs - 1e-15) worse++;
  }
  return worse / total;
}

/** One arm of one replicate: the p20 round of wall, and the other clocks at that same round. */
export function armSummary(arm) {
  const i = pctIndex(arm.wall, 0.2);
  const wall = arm.wall[i];
  const thr = arm.thr[i];
  const gcRounds = {};
  for (const g of arm.gc ?? []) for (const [t, [n]] of Object.entries(g)) if (n > 0) gcRounds[t] = (gcRounds[t] ?? 0) + 1;
  return {
    wall,
    thr,
    off: (wall - thr) / wall, // descheduling: in wall, not in the thread's CPU (log s35.45)
    other: (arm.cpu[i] - thr) / thr, // CPU of V8's other threads, relative to the main thread's
    gcRounds,
    rounds: arm.wall.length,
  };
}

/** Per function: one row per replicate. @returns {Record<string, any[]>} */
export function collect(replicates) {
  /** @type {Record<string, any[]>} */
  const per = {};
  for (const r of replicates) {
    for (const [fn, v] of Object.entries(r.fns)) {
      const a = armSummary(v.A);
      const b = armSummary(v.B);
      (per[fn] ??= []).push({ n: v.n, first: r.order[0], a, b, d: Math.log(b.wall / a.wall) });
    }
  }
  return per;
}

export const DEFAULTS = {
  gate: 0.03, // a control's 2 x spread must be within this
  centre: 0.015, // and its median within this of 1 (log s35.48: a 0.953 control with a 1.3% spread passed a spread-only gate)
  offCpu: 0.01, // wall - main-thread CPU at the p20 round, per arm (Fable's falsifier, log s35.47)
  background: 0.2, // other-thread CPU above this share of main-thread CPU: reported, not refused
};

/**
 * The control's verdict for one function: { spread, centre, ok, why }.
 * Refused when it is wide, off-centre, or descheduled.
 */
export function judgeControl(rows, opt = DEFAULTS) {
  const d = rows.map((x) => x.d);
  const spread = mad(d);
  const centre = median(d);
  const off = Math.max(median(rows.map((x) => x.a.off)), median(rows.map((x) => x.b.off)));
  const why = [];
  if (2 * spread > opt.gate) why.push(`control spread ${pct(2 * spread)} > ${pct(opt.gate)}`);
  if (Math.abs(centre) > opt.centre) why.push(`control centre ${Math.exp(centre).toFixed(3)} off 1 by > ${pct(opt.centre)}`);
  if (off > opt.offCpu) why.push(`control off-CPU ${pct(off)} > ${pct(opt.offCpu)}`);
  return { spread, centre, off, ok: why.length === 0, why };
}

/**
 * B against A for one function, given its control. Returns the numbers and a
 * verdict: 'faster' | 'slower' | 'no result', with the reasons for 'no result'.
 */
export function judge(rows, control, opt = DEFAULTS) {
  const K = rows.length;
  const d = rows.map((x) => x.d);
  const m = median(d);
  const ci = bootCI(d);
  const p = signFlipP(d);
  const mde = (t975(K - 1) * control.spread) / Math.sqrt(K);
  const aF = rows.filter((x) => x.first === 'A').map((x) => x.d);
  const bF = rows.filter((x) => x.first === 'B').map((x) => x.d);
  const orders = aF.length >= 2 && bF.length >= 2 ? [median(aF), median(bF)] : null;
  const a = median(rows.map((x) => x.a.wall));
  const b = median(rows.map((x) => x.b.wall));
  const delta = median(rows.map((x) => x.b.wall - x.a.wall));
  const off = Math.max(median(rows.map((x) => x.a.off)), median(rows.map((x) => x.b.off)));
  const other = [median(rows.map((x) => x.a.other)), median(rows.map((x) => x.b.other))];
  const why = [];
  if (!control.ok) why.push(...control.why);
  if (off > opt.offCpu) why.push(`off-CPU ${pct(off)} > ${pct(opt.offCpu)}`);
  if (!(ci[0] > 0 || ci[1] < 0)) why.push('CI includes 1');
  if (Math.abs(Math.expm1(m)) <= mde) why.push(`effect ${pct(Math.abs(Math.expm1(m)))} within MDE ${pct(mde)}`);
  if (orders && Math.sign(orders[0]) !== Math.sign(orders[1])) why.push('load orders disagree');
  const verdict = why.length ? 'no result' : m < 0 ? 'faster' : 'slower';
  const notes = [];
  if (Math.max(...other) > opt.background) notes.push(`background CPU ${pct(Math.max(...other))} of main thread`);
  return { K, ratio: Math.exp(m), ci: ci.map(Math.exp), p, mde, orders: orders?.map(Math.exp) ?? null, a, b, delta, off, other, verdict, why, notes };
}

/**
 * Least-squares line through (n, y): the paired B - A ns per CALL against n.
 * Absolute ns drift between runs; the paired difference cancels the drift
 * (log s35.48), so this is the fit to make: slope = ns per iteration the
 * change saves, intercept = a fixed cost per call.
 */
export function fitLine(points) {
  const k = points.length;
  const mx = points.reduce((s, p) => s + p.n, 0) / k;
  const my = points.reduce((s, p) => s + p.y, 0) / k;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.n - mx) * (p.y - my);
    sxx += (p.n - mx) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const maxResidual = Math.max(...points.map((p) => Math.abs(p.y - (intercept + slope * p.n))));
  return { slope, intercept, maxResidual };
}

/** Per replicate (B - A) ns per call, median across replicates: one point of the fit. */
export const pairedPerCall = (rows) => median(rows.map((x) => (x.b.wall - x.a.wall) * x.n));

/**
 * The claim across call lengths: every length must give the same counted
 * verdict; otherwise 'no result' (log s35.45: a ratio that moved with n).
 */
export function combineLengths(verdicts) {
  const counted = verdicts.map((v) => v.verdict);
  if (counted.every((v) => v === counted[0])) return { verdict: counted[0], why: counted[0] === 'no result' ? ['no length counted'] : [] };
  return { verdict: 'no result', why: [`lengths disagree: ${counted.join(' / ')}`] };
}

export const pct = (x) => `${(100 * x).toFixed(1)}%`;
