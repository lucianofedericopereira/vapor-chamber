#!/usr/bin/env bash
# scripts/ab/base-ok.sh <sha>
# Exit 0 when <sha> is a commit this checkout has, so `perf-ab` can build it as
# the base arm. Otherwise exit 1 and print why on stdout, one line: the job
# then skips with that message instead of failing with none (an all-zero
# `github.event.before` on the push that creates the branch; a base dropped by
# a force-push and absent from the checkout). A missing base is not a
# regression, so it is not a red build. tests/ab-ci.test.ts.
set -uo pipefail
sha=${1:-}
if [ -z "$sha" ]; then
  echo "no base commit given: nothing to compare against"
  exit 1
fi
case "$sha" in
  *[!0]*) ;;
  *) echo "base $sha is all zeros (the push that creates the branch): nothing to compare against"; exit 1 ;;
esac
if ! git cat-file -e "$sha^{commit}" 2>/dev/null; then
  echo "base $sha is not in this checkout (a force-push dropped it?): nothing to compare against"
  exit 1
fi
exit 0
