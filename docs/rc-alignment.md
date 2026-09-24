# Aligning with a new Vue RC

What to do when a new Vue 3.6 release candidate lands. One cycle per RC, on its
own branch, until 3.6 is stable. The record of past cycles is
[rc-alignment-log.md](./rc-alignment-log.md); this page is the procedure.

## What a cycle is for

vapor-chamber must work with Vue Vapor, with Vue vDOM, with mixed trees, and with
no Vue at all (Blade, IIFE from a CDN, Node). A cycle asks what changed **in
Vue** and how that lets this library be aligned, improved or simplified.
"Unaffected" is where the reading starts, not the result.

## Before you start

1. Branch: `git switch -c rc<N>`.
2. Read, in full: this page, the previous cycle's section at the end of the log,
   the top of `CHANGELOG.md`, `ROADMAP.md` and whitepaper section 9. The rc.9
   cycle made sixteen commits before reading any of it; log s34.4 lists the
   gates that were skipped as a result.

## The steps

**1. Read every Vue commit in the range.** `git log v3.6.0-rc.<prev>..v3.6.0-rc.<N>`
in a clone of `vuejs/core`, the full log rather than first-parent. Put every
commit in one of two columns:

- **V**: the diff was read in full, or a probe or a committed test answered it.
- **TV**: not read in full yet.

A commit is **contact** when it touches a file whose behaviour this library
reaches, when its diff (read *with* context) mentions a symbol we use, or when it
changes an API `src/vapor.ts` re-exports. A grep can order the queue; it cannot
close a row. Closing a TV row on a grep needs the owner's sign-off.

**2. Bump.** `vue` and every direct `@vue/*` devDependency, the peer range, and
the pins in each example. Rebuild all three examples and run `npm run check:example`,
which clicks a real button in a built page.

**3. Run the suites.** `npm run build`, then `npm run test:run` and
`npm run test:vapor`. Build first: several guards read `dist/` and skip
themselves without it.

**4. Run the gates.** `npm run typecheck`, `npm run lint:check`,
`npm run size:check`, `npm run test:coverage` (100% on all four). Read their
full output; do not pipe a gate through `| tail`, which hides its exit code.

**5. Measure against the previous Vue.** Diff the two dists first; if the
reactivity sources are byte-identical there is nothing to measure. Otherwise
`npm run ab:vue -- <prev>`, which runs both versions in one process.

**6. Answer open questions with probes.** A probe is a throwaway test in
`.probes/` (gitignored), run with `npx vitest run --config vitest.probes.config.ts`.
What it finds goes into a commit message, a comment or a real test; the probe
itself never joins the suite.

**7. Regenerate.** `npm run docs` after any change under `src/`, comments
included; `npm run size:doc` when a size can move; `MCP_SERVER_VERSION` in
`src/mcp.ts` follows the package version; `npm run docs:stamp` last.

**8. Document the cycle in four places.** A `CHANGELOG.md` entry (under the
current unreleased heading), a row in the whitepaper section 9 alignment table,
the header of each module the cycle changed, and `ROADMAP.md` (last reviewed
version, RC dates, peer-range statements, the support matrix and the version
targets table).

**9. Check the `vue36` reopen condition.** `tests/vue-bundler-vapor-exports.test.ts`
decides whether the withdrawn `vue36` build flavour should come back. It passing
means the answer is unchanged.

Close with `npm run gate`, on a clean tree.

## Rules that hold throughout

- **Read files in full before concluding.** No conclusion from a grep or a
  number alone; mark every claim verified or to-verify until it is one or the
  other.
- **Fixtures run compiler output.** A Vapor test compiles its template on the
  installed Vue (`tests/compile-vapor.ts`). A hand-written directive tuple
  records one compiler release: rc.9 changed the argument to a getter, and
  `v-vc:command` went dead with all 2,431 tests green.
- **Write the decision when it is taken.** One dated row in `docs/decisions.md`,
  not a backfill at the end.
- **Measure bytes per change**, the IIFE variants and the Blade consumer bundle
  both, and say which build a number came from.
- **Bench before a performance change**, interleaved A/B, and no claim without a
  committed bench.
- **Nothing is deleted for having zero consumers.**
- **Scripts that edit files go in a file**, not an inline heredoc: the shell
  eats backticks and quotes, and an edit that prints "ok" can change nothing.

## When the cycle is done

Every commit in the range is V, or TV with the owner's sign-off. The four places
in step 8 say the new version. The gate passes. The log gets a section for the
cycle: what the RC was, what it broke or enabled, what was measured, and what was
left open and why.
