<!--
Thanks for the PR. The checklist below mirrors what CI runs - if all boxes
pass locally, CI will too.
-->

## Summary

<!-- 1-3 bullet points. What changed and why. -->

-

## Checklist

- [ ] `npm run typecheck` passes
- [ ] `npm run lint:check` passes
- [ ] `npm run test:run` passes
- [ ] `npm run build` succeeds
- [ ] `npm run size:check` passes (or BUDGETS bumped + reasoned in summary)

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
     in CHANGELOG.md. Mention the user-visible effect, not the implementation. -->
