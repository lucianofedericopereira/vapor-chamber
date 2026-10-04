// The timing loop of scripts/ab/child.cjs, built per arm (its own function and
// feedback). With `isAsync` it awaits f(n), so the window closes when the
// workload's promise settles. tests/ab-loop.test.ts.
'use strict';
const AsyncFunction = (async () => {}).constructor;
const mkLoop = (isAsync) =>
  new (isAsync ? AsyncFunction : Function)('f', 'n', 'GCProfiler', [
    'const p = new GCProfiler(); p.start();',
    'const t0c = process.threadCpuUsage();',
    'const c0 = process.cpuUsage();',
    'const t0 = process.hrtime.bigint();',
    isAsync ? 'const r = await f(n);' : 'const r = f(n);',
    'const t1 = process.hrtime.bigint();',
    'const c1 = process.cpuUsage(c0);',
    'const t1c = process.threadCpuUsage(t0c);',
    'const st = p.stop().statistics;',
    'const gc = {};',
    'for (const s of st) { const g = (gc[s.gcType] ??= [0, 0]); g[0]++; g[1] += s.cost; }',
    'return [Number(t1 - t0) / n, (c1.user + c1.system) * 1000 / n, (t1c.user + t1c.system) * 1000 / n, gc, r];',
  ].join('\n'));

module.exports = { mkLoop };
