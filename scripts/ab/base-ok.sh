#!/usr/bin/env bash
# scripts/ab/base-ok.sh <sha>
# Exit 0 when <sha> is a commit this checkout has, on the same package.json
# version as the head, with no release tag for that version, so `perf-ab` can
# build it as the base arm. Otherwise exit 1 and print why on stdout, one line:
# the job then skips with that message instead of failing with none (an
# all-zero `github.event.before` on the push that creates the branch; a base
# dropped by a force-push and absent from the checkout; a base on another
# release; a head whose version is already tagged). Having no comparable base
# is not a regression, so it is not a red build. tests/ab-ci.test.ts.
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
# Across a release the pair measures the fixes' work, not a regression (log s35.203).
version='JSON.parse(require("fs").readFileSync(0, "utf8")).version'
was=$(git show "$sha:package.json" 2>/dev/null | node -p "$version" 2>/dev/null || true)
now=$(node -p "$version" <package.json)
if [ "$was" != "$now" ]; then
  echo "base $sha is ${was:-no} release, head is $now: the new release is the baseline, nothing to compare against"
  exit 1
fi
# A version already released (its tag is here: upstream tags `v1.31`, the
# release steps write `vX.Y.Z`): a later commit on it lands no new release,
# so there is nothing to measure (owner, log 36.32).
short=${now%.*}
for tag in "v$now" "v$short"; do
  if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
    echo "head is $now, already released (tag $tag): no new release, nothing to measure"
    exit 1
  fi
done
exit 0
