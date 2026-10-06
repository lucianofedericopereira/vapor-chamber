# V8 rules

What this library has settled about V8, for anyone changing a hot path or
measuring one. A rule is here only with evidence in this repository: a test, a
measured A/B, or a recorded log section, named at the rule. What V8's design
suggests but nothing here has measured yet is under "Open" at the end, and
becomes a rule when it is measured. The full record, with the numbers, is
[performance.md](./performance.md).

## Writing code

1. **One hidden class per read-many object.** `Command`, `CommandResult`,
   `CommandMeta` and the bus state are built by one literal or one factory,
   same fields, same order, so every reader's inline cache stays monomorphic.
   A result is always `okResult` / `errResult` (`{ ok, value, error }`, the
   unused slot `undefined`), never a hand-built literal.
   (`tests/v8-shapes.test.ts` compares maps with `%HaveSameMap` and fails on a
   hand-built result literal in `src/`; [performance.md, "Hot-path shape consistency"](./performance.md#hot-path-shape-consistency))
2. **No late field writes on a read-many object.** All fields in the literal
   that creates it; a field added later is a map transition. Measured on
   `meta.idempotencyKey` (written by `idempotent` and the retry runner): the
   two maps differ (`%HaveSameMap` false). The cost was first inside the
   control band (log s35.44); log s35.81 then put the slot in every meta
   literal (`idempotencyKey: undefined`), one map for every command
   (`tests/v8-shapes.test.ts`). A call inside the literal is a late write
   too: the object is allocated before the call runs. Inside a try region,
   the call's exception edge then sees the object half built, and escape
   analysis keeps an object nothing reads. Measured 2026-10-06, v1.27, Node
   24.21.0 (log s35.204). Sync dispatch built
   `{ ..., meta: stampMeta(payload) }` inside the depth's try/finally, and
   every bare dispatch kept a dead meta.
   Built before the try, the meta went: bare dispatch 0.62-0.71x (7-12 ns).
   Move the build out of the try. A one-use `const` does not do it: the
   bundler folds it back into the literal.
3. **Decide a mode once, not on every call.** Choose behaviour at factory or
   build time and keep the branch off the hot path. The fast lane picks its
   `removal` mode at factory time; unifying the sync and async commands was
   declined because it puts a `signal` store on the sync dispatch path.
   ([performance.md, "Copy-on-write listener buckets"](./performance.md#copy-on-write-listener-buckets-fast-lane-emit-shipped-as-an-opt-in))
4. **No closure per call on a hot path.** A closure that captures a call's
   arguments is an allocation V8 did not remove in either case measured: the
   composable dispatch thunk (removed: 0.915-0.934x, 2.7-3.9 ns) and a
   filter's `patterns.some(p => matchesPattern(p, action))` (removed:
   0.979-0.986x, 4.6-6.6 ns, on a chain of four scoped plugins and a
   listener). The one kept, `buildRunner`'s `next` per plugin
   level, is kept for correctness with its cost recorded in its PERF NOTE
   (`src/command-bus.ts`). A new one needs a measured reason like that.
   (log s35.44, s35.53)
5. **Call the target directly, not through a generic helper.** A helper that
   takes a function (`untracked(fn)`) and calls it at one site serves every
   caller from that site. `runDispatch` calls `bus.dispatch` / `bus.query`
   itself between the tracking slots; passing the method and calling it with
   `.call` gained nothing, for a reason not yet settled (see Open).
   (log s35.44)
6. **No `typeof` of an undefined global on a per-call path.** It found
   nothing to cache: `warnUnwired`'s build-flag guard, checked on every
   composable creation, cost creation 7-9%. Put a cheap module-variable test
   first, and keep the `typeof` inside the condition whose block a define
   must fold away: a module-level `const` copy of the flag broke the fold in
   a Vite build (+609 B brotli on the vapor-sfc demo). (log s35.44)
7. **Shape rules are for read-many paths.** A write-once, serialize-once
   object (the HTTP envelope) stays idiomatic: making it shape-stable was
   measured and gained nothing. ([performance.md, "HTTP envelope shape"](./performance.md#http-envelope-shape))
8. **No loop-syntax micro-optimizations.** Cached `length`, index loops
   against `for...of`: TurboFan handles these, and the few index loops kept
   are documented where they are. Rule 4 is not this: a callback that
   captures per-call state is an allocation, not syntax.
   ([performance.md, "Philosophy"](./performance.md#philosophy))

## Measuring

9. **Measure the real path.** An isolated, deterministic loop is
   constant-folded: V8 removes work with no observable effect and the ratio is
   garbage. Run the change through the real dispatch path.
   (`tests/signal-shallow-ab.test.ts`; [performance.md, finding 5](./performance.md#reactive-runtime-notes-vue-36))
10. **Interleave, and control the harness.** Alternate the two arms round by
    round in one process and compare medians; run the same build against
    itself, in both load orders, and count only a difference beyond that
    band. Two byte-identical copies once read up to 1.425x apart.
    (`tests/clock-source-ab.test.ts`, `tests/vue-version-ab.test.ts`;
    [performance.md, the note under "Reactive runtime notes"](./performance.md#reactive-runtime-notes-vue-36))
11. **Use the real chain's shape.** One function at every plugin level keeps a
    call site near-monomorphic and understates the cost; measure with distinct
    functions. (`tests/plugin-throw-ab.test.ts`)
12. **A change only moves the paths that run it.** Diff the two arms and
    attribute a movement only to a timed path that executes the changed code.
    Each arm is its own copy of every function, so an edit elsewhere can move
    an untouched loop a few percent, and the same-bundle control cannot show
    it. The signature is a sign that flips between workloads on the same
    untouched code: in one process per comparison, a change to `warnUnwired`
    only read 0.93-0.98x on one workload and 1.05x on another; replicated over
    10 processes (rule 16) the same untouched path read 1.000. Which mechanism
    moved it is a hypothesis (see Open). ([performance.md, "Reading an A/B"](./performance.md#reading-an-ab-what-a-change-can-and-cannot-move), log s35.44)
13. **An isolated win is a lead; a mixed workload and the bench decide.**
    One call site with one shape is monomorphic; an app is not. Confirm on a
    mixed workload (both callers of a shared helper, several actions, sync and
    async bus, hits and misses), then `npm run bench` against the previous
    version. The filter loop read no effect with one one-pattern plugin
    (0.994) and 0.979-0.986x on four different plugins and a listener (log
    s35.53); a mixed workload can
    also fail as an instrument (both composables interleaved over a Vue graph:
    its own control spread up to 1.36x across processes), and then it decides
    nothing. (`stampMeta` and `handleMissing` in `src/command-bus.ts` record
    the same trap; log s35.44)
14. **Report the saving in ns, not only the ratio.** A change saves a time per
    call; the ratio depends on what surrounds it. The filter loop saved about
    12 ns per dispatch with five patterns alone (109-125 ns; a lead, that
    row's short-call control was too wide to count) and 4.6-6.6 ns in a
    four-plugin chain with a listener (303-341 ns). (log s35.44, s35.53)
15. **A ratio between two libraries is a host fact.** The bench's in-run
    peer ratios moved with no code change: the fast lane's fan-out against
    mitt read 1.79-1.92 over 5 runs, where the docs stamped 2.33 from an
    earlier run (log s35.56). A one-name micro-loop also flatters a peer keyed
    by a plain object: ahead on one repeated name, half our speed over four
    varying names (log s35.57). Compare this library with itself, version against version, on
    one host; read a peer ratio as a band for that host and Node version.
    The docs print it that way: `npm run bench:bands` stamps a peer ratio as
    the min-max over N runs, with the Node and peer versions, and an own
    ratio as the median (`tests/bench-ratios.test.ts`). (log s35.44, s35.69)
16. **The process is the unit of replication.** Both arms in one process share
    one heap, one GC schedule and one tier-up timeline: a single draw, however
    many rounds run. Measure over K processes (10), each with a random load
    order, a timing loop per arm (`new Function`, so the harness call site
    never sees both arms), a fixed young generation and a minor gc before every
    timed call (rule 18); summarize each arm by its 20th percentile over 40
    rounds, take the median log-ratio across processes, its bootstrap 95%
    interval and an exact sign-flip test, and the minimum detectable effect
    from the A/A control's robust spread (1.4826 x MAD). n is pinned per
    function from a WARM call, never under the extra flags, so one n serves
    every flag set; a claim holds at two call lengths (n and 4n) or names its
    n. Count a function only when its own control is within 3% (2 x spread)
    AND centred within 1.5% of 1 (a 0.953 control with a 1.3% spread passed a
    spread-only gate, log s35.48), wall minus main-thread CPU at the 20th
    percentile round is under 1% (descheduling), the interval excludes 1, the
    effect beats the MDE and both load orders agree; report ns beside the
    ratio. Measured: controls of 0.2-1.4% on dispatch paths; the single-process
    1.05x of rule 12 gone (1.000). Wider controls stay wide (creation 2.7-4.0%
    with the minor gc), and the gate then says "no result". The tool is
    `npm run ab -- <distA> <distB> <workload>` (`scripts/ab/`, its gates pinned
    by `tests/ab-tool.test.ts`, each seeded red); the arms come from
    `npm run ab:dists`, workloads in `scripts/ab/workloads/`. CI runs it on
    every push and pull request, base against head (`perf-ab`,
    `npm run ab:ci`): a counted "slower" fails the build, and so does a run
    in which no control passed. (log s35.44, s35.48, s35.50, s35.59)
17. **Measure a session, not a moment, on a shared Mac.** `npm run ab:session`
    demotes the user's other busy processes to background QoS for the session
    (`taskpolicy -b -p`, undone with `-B`), which keeps them on the efficiency
    cores while their work goes on; never the measuring shell's ancestry, whose
    children would inherit it. Keep the machine awake (`caffeinate -i`), on AC
    power. The machine need not be quiet: no load ceiling refuses a session;
    each row judges its own validity (rule 16's gates). Under the user's
    normal work (load 3.3, Time Machine running) the controls read 0.3-0.7% and
    D2 0.855 against 0.864 measured quieter (log s35.49); a load that
    saturates every core is untested. A root process (Time Machine's
    `backupd`) cannot be demoted. And the owner says "go": a measurement does
    not start on this side's initiative. (log s35.44, s35.49; decisions
    2026-10-01)
18. **A minor gc before a timed call, never a full one.** A full `gc()`
    evicts the timing loop's OSR code, so every timed call recompiled it (a
    Maglev OSR, 0.7 ms, then a TurboFan OSR, 1.5 ms, on the compiler threads)
    and its first part ran in lower tiers, on dispatch as on creation
    (`--trace-osr`); that compile and the sweeping after the collection were
    nearly all the background CPU. `gc({ type: 'minor' })` (a scavenge, Node
    24) leaves the code alone: no compile, no deopt, other-thread CPU about 0.
    It removed the flag dependence (D2 0.864 default, 0.876
    `--single-threaded-gc`, against 0.859 / 0.925 with the full gc) and kept
    the ratio flat over call length (0.864-0.878 at 10k-80k iterations).
    (log s35.48)

## Open: not yet settled

From V8's design or an outside review, not measured here yet. Each becomes a
rule when it is measured and recorded.

- **CPU time beside wall time.** SETTLED for the tool (log s35.48): wall
  decides; main-thread CPU is a validity gate (rule 16); other-thread CPU is
  printed as a diagnostic, and with the minor gc of rule 18 it is about 0. The
  record that led there, kept: why they disagreed (log s35.45):
  `process.cpuUsage()` counts every thread, and V8's GC and compiler threads
  add CPU per timed call: about 1.4 ms on dispatch, equal in both arms; on
  creation 2.5x the main thread's own CPU, and there it differed by arm
  (360 / 323 ns per iteration, its A/A control 4%), not settled. On dispatch
  that constant dilutes the process-CPU ratio toward 1: on D2,
  (B + other) / (A + other) from the per-arm medians predicts the measured
  CPU ratio within 0.002 under four flag sets. Main-thread CPU
  (`process.threadCpuUsage()`) equals wall within 0.5% in every job, so
  descheduling plays no part at the 20th percentile. The V-e creation gap
  (0.969 / 0.997) has a CI that includes 1; an outside reading (log s35.47)
  is that there the two clocks measure different things (the main thread's
  work, and a recompile per call that the harness's forced `gc()` causes), to
  verify. Still open: whether the harness should report CPU at all, and in
  which form.
- **`--single-threaded`.** Measured (log s35.45): it moves the background
  work onto the main thread (creation 128 -> 442 ns per iteration) and makes
  the three clocks agree exactly; it also changes the effect measured (D2
  0.859 under default flags, 0.927 under it, n pinned). A browser runs V8's
  background threads, so it is a diagnostic, not the measuring mode.
- **Call length changes a ratio.** Settled as a harness effect (log s35.48):
  D2's ratio moves with n only under `--single-threaded` with the full gc
  (1.034 at 10k down to 0.928 at 40k), where the paired B - A fit gives the
  Map arm a fixed +0.28 ms per call and -18 ns per iteration; under default
  flags it is flat (full gc 0.858-0.875, minor gc 0.864-0.878). What the
  fixed cost is under `--single-threaded` (sweeping or compiling moved onto
  the main thread) is not traced. Fit the PAIRED difference: absolute ns
  drift 10-20% between runs, and a fit of them gave noise.
- **Half of D2's gain needs background GC.** Withdrawn as a property of D2
  (log s35.48): it was the forced full gc's. With a minor gc per call D2
  reads 0.864 default and 0.876 `--single-threaded-gc` (that job's control
  2.2% wide: a lead). With the full gc: 0.859 / 0.925 (log s35.45).
- **D2's table young or old.** The `started` Map is old in a workload that
  builds it at import (`%InYoungGeneration`, log s35.48). Whether a young
  table changes D2 is not measured: the workload that rebuilt it per call
  failed its own A/A control.
- **Idle inside a session.** A 20 ms idle wait before each call slowed
  dispatch and widened the controls in one session (log s35.45) and did
  neither in another (log s35.48), so a busy spin in its place could not be
  compared. The tool neither waits nor spins.
- **Classify a gain.** One that disappears under `--no-opt --no-maglev` is an
  optimizer gain (inlining, escape analysis) and fragile across Node majors;
  one that survives is less work. `--trace-opt` and `--trace-turbo-inlining`
  diffed per arm are the evidence for rule 12's mechanism and for why rule 5's
  `.call` variant gained nothing.
- **Bytecode size and inlining.** Inlining is budgeted in bytecode bytes; a
  hot function past the budget stops being inlined. To measure on
  `runDispatch` and the runners before it becomes a rule. One measured case,
  2026-10-06, v1.27, Node 24.21.0 (log s35.204). Item 2 shrank
  `_syncDispatchInner` from 699 to 225 bytecode bytes, under the 460 budget.
  It then inlined into its caller inside the depth's try/finally, and bare
  dispatch read 5 ns slower. The cause was rule 2's half-built literal, not
  the inlining. Inlining also helped: inside the caller the bus state `s` is
  a constant (the closure's `const` slot). Its arrays, maps and lengths
  fold, where the standalone function loads each. The handler's shape
  decides a row. Where the handler inlines too, a dead Command and meta can
  go. Where it is called, they stay either way. So one action through a site
  read 2-3 ns slower after item 2, and two actions 3 ns faster (one process
  each, leads). A bare workload is the first shape, an app with listeners
  the second.
- **Flags as the control for a mechanism.** A flag that turns one optimizer
  decision off shows whether it is the cause, with no code change. On the case above (2026-10-06, v1.27):
  `--max-inlined-bytecode-size=224` put b15293e back at 845a610's time, so
  the inlining decision was the mechanism. `--no-turbo-escape` cost the
  out-of-line arm more than the inlined one, so escape analysis was what the
  out-of-line arm kept. Read the direction only, in one process.
- **Seeing what V8 kept.** `--trace-turbo` writes Turbolizer JSON per
  optimized function. It holds the allocations left after escape analysis,
  and the merge (Phi) that makes one escape. `--print-opt-code
  --code-comments` shows what a kept object costs: the bump allocation, the
  field stores, the write barriers. That is how rule 2's dead meta was found
  (log s35.204).
- **A double field is a box.** `meta.ts` holds `Date.now()`, above the small
  integer range. So every live meta carries a 16-byte HeapNumber beside its
  own 88 bytes (2026-10-06, v1.27, read off the printed code). Its cost per
  dispatch is not measured. Another representation would change a public
  field.
- **try/catch placement.** `tryCatchHandler` keeps a `try` in a small
  function of its own ("so callers stay optimizable", `src/command-bus.ts`);
  the cost of the other shape is not measured here.
- **Build it the way a consumer does.** Measure a production build of the
  built `dist/` (browser resolution, Vue's esm-bundler build, production
  defines), not Node's CommonJS Vue and not a hand-edited `dist`. Used for
  every A/B since the 1.26 evaluation, where the other harness read a false
  1.2x; to be committed as a test and recorded.
