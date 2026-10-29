# Testing procedure

How to measure whether a change makes this library faster or slower, step by step.

- The rules behind each step, with their evidence: [V8-RULES.md](./V8-RULES.md).
- How a change is judged:
  [CONTRIBUTING.md](../CONTRIBUTING.md#how-a-change-is-judged).
- Correctness tests and the gate:
  [CONTRIBUTING.md, "Before opening a PR"](../CONTRIBUTING.md#before-opening-a-pr).
- Past measurements: [rc-alignment-log.md](./rc-alignment-log.md).

## 1. Ask what an app pays

- Write the question as an app's: "a tracked dispatch of an object target".
- Name the paths the change runs, and the ones it does not (V8-RULES rule 12).
- Mark each path normal or rare. Normal is the success dispatch most commands take. Undo, abort
  and failure are rare.

## 2. Find the shapes apps use

- Read how `examples/` set up their buses: which plugins, and which declare `actions`.
- Give each shape the examples use its own row. A shape no example has is a lead, never a
  verdict (rule 13).
- Use the library's real plugins where they are safe. A pass-through stand-in is a lead.
- Add one control row on a path the change does not run. It should read 1.000.
- For an async change, add the async control: the same operations with no library code, behind
  an async function with one await each (`app_async_control` in
  `scripts/ab/workloads/app-session.mjs`). It shows what the workload's own promises cost, so the
  library's share is the rest.[^f44]

[^f44]: Log 36.F44.

## 3. Build the arms

- A library change: `npm run ab:dists -- <dir> <base> <head>`. The base is the current `main`,
  never a release with the bugs the change fixes.
- An app-shape question, such as an option against a plugin: one build, copied twice. A one-line
  marker module beside each copy picks the shape, so the library bytes are identical.
- Compare the arms first. Only the files the change touches may differ.
- Grep the head's dist for the intended shape. A bundler can fold a change away (rule 2).

## 4. Write the workload

- Export `N` and one function per row, as the header of `scripts/ab/ab.mjs` says.
- Print nothing. A child returns its result on stdout, so a stray line corrupts it.
- Leave no timer running after the rounds. A child waits for pending timers before it exits, so
  unref any timer the setup starts.
- Self-check at setup: each arm does what its row claims, or the workload throws.
- Vary what an app varies: targets, actions, value types. One repeated value gets folded or
  speculated (rules 9 and 19).
- A row whose call leaves work queued (another tab's messages, an unconfirmed write) exports
  `SETTLE = { row: async () => {} }`. The child awaits it after each call, outside the timed
  window, so no call times a backlog the calls before it built.[^settle]
- Give each row its own loop. One loop that calls `bus[method]` serves every row from one call
  site.

[^settle]: `scripts/ab/child.cjs`, log 36.F44.

## 5. Smoke test, in seconds

- Bundle the workload for each arm with the tool's own bundler (`bundler()` in
  `scripts/ab/ab.mjs`).
- Run each bundle once in a child process and call `check()`. Both arms must return the same
  values.
- Count the child's stdout writes: none. Time its whole life: it exits at once.

## 6. Pilot, in seconds

- Run `npm run ab -- <A> <B> <workload> --k=2 --lengths=1 --only=<row>`.
- Read its run time. It runs five processes. A full job runs forty-one, half of them four times
  as long.
- A pilot reading is never a verdict.

## 7. State the cost, then run

- Before any job over a minute, say how long it takes, how many processes it starts and whether
  any app is demoted.
- Run one row per job, `--k=10`, two lengths. Report each verdict as it lands.
- Run plain `npm run ab`. Use `npm run ab:session` only when asked, because it demotes other
  apps.

## 8. Read the result

- A row counts only when its control passes and both lengths agree (rule 16).
- A "no result" stays a no result. Never re-run a row for a quieter machine.
- Report the ns beside the ratio (rule 14).
- A counted slower on a normal path stops a design.
- A counted slower of about 5 ns or less is noise, not a veto. A real regression is larger and
  shows on every shape that runs the code.
- A rare path may pay a measured cost. State it.
- Decide on the shapes the examples use, never on one partial row.

## 9. Measure bytes the way a consumer ships them

- Build each piece of a change on its own, and table raw and brotli per piece.
- Report the core ESM and a tree-shaken consumer bundle. The IIFE builds never decide a design.
- Size a consumer bundle inside a package root. Outside it, `package.json`'s `sideEffects` does
  not apply, and the bundle keeps code a consumer drops.
- Check your harness against a known figure first, such as the ceiling in
  `tests/esm-treeshake.test.ts`.

## 10. Probe a change against the suite

- Run a probe in the main tree, then put the file back with git and rebuild `dist`. A worktree
  outside the repository cannot resolve the fixtures' Vapor build of Vue, and 116 tests fail
  there with no change at all.
- Run the same harness with no change first. A failure both runs share belongs to the harness,
  not to the change.

## 11. Count the turns of an async change

- A change that removes an async frame, a `.then` or a thenable resolve (V8-RULES rule 20) has a
  red test before any A/B. The test counts the microtask turns from the call to its settling,
  against a path without that step. It fails on the commit before and passes after.
- Give it a control that shows the counter sees a turn: one more `await` in a handler costs one.
  Count microtasks only, since a timer never fires while the counter spins.
- A path the change no longer awaits by default still needs a case that makes it
  await.[^f45]

[^f45]: Log 36.F45, the five hook sites coverage found.

## 12. The bench

- `tests/perf.bench.ts` builds every bus and store in its group's setup. A row whose state grows
  resets it in its own `beforeEach`, outside the timing. Only the `create.*` rows time a
  construction.
- Each row has a stable id (`dispatch.sync.bare`), the same in every release, so one release's
  bench reads against the next by id. `tests/bench-harness.test.ts` pins the list.
- Stamps come from `npm run bench:bands` on the bench host, in a clean committed checkout, never
  beside an A/B. `benchProvenance` names the host.

## 13. Record it

- Write a log section: the question, the shapes, a table of rows with verdict, B/A and ns, the
  reading and the decision.
- Commit the workload with it, so the next measurement reuses it.
- A new V8 rule needs evidence in this repository. Until then it goes under "Open" in
  V8-RULES.md.
- A number a run can compute is a stamp. A measured ns in prose carries its date, host and Node
  version.
