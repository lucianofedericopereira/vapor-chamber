<!--
Thanks for the PR. The checklist below is what CI's `check` job runs, and
`npm run gate` (CONTRIBUTING.md) runs those steps in its own order on a
committed tree, and adds the `docs/BUNDLE-SIZES.md` diff and a clean-tree check
that CI does not run. CI also runs the browser suite, the example builds and the perf A/B
against the base, each as its own job.
-->

## Summary

<!-- 1-3 bullet points. What changed and why. -->

-

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint:check` passes
- [ ] `npm run build` succeeds
- [ ] `npm run test:coverage` and `npm run test:vapor` pass (the coverage floors gate CI)
- [ ] `npm run size:check` passes (or BUDGETS bumped + reasoned in summary)
- [ ] `npm run docs` leaves `docs/api`, `docs/errors.md`, `contract/` and the PHP fixture unchanged (commit the regenerated files)
- [ ] `npm run test:browser` passes, if the change touches focus, keyboard
      activation, live regions or the accessibility tree

## Performance impact (delete if not applicable)

<!--
For any change in src/command-bus.ts, src/transports.ts, src/chamber.ts,
src/plugins-*.ts: run `npm run ab` base against head on a workload that
runs the changed path (CONTRIBUTING.md, "Performance work"). Keep a perf claim only
when a path that runs it reads faster and none reads slower.
-->

| ab workload, row                 | Base (ns)  | Head (ns)  | Verdict |
|----------------------------------|------------|------------|---------|
|                                  |            |            |         |

## API impact (delete if not applicable)

<!-- Any new public exports? Any removed ones? Any changed signatures?
     Variant contents (core/elements/full) are not under semver pre-v2 - see ROADMAP.md.
     ESM main-entry signatures are. -->

## CHANGELOG entry

<!-- Drop a one-paragraph entry under the Unreleased / next-version heading
     in CHANGELOG.md. Name the effect a user sees, not the mechanism. -->
