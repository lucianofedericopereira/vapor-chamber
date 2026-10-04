#!/usr/bin/env bash
# scripts/ab/build-dists.sh <out-dir> <commit...>
#   npm run ab:dists -- <out-dir> <commit...>
# One real build per commit, in a scratch worktree, copied to <out-dir>/<commit>:
# the arms of scripts/ab/ab.mjs. Never a hand-edited dist (docs/V8-RULES.md,
# "Build it the way a consumer does"). The worktree shares this checkout's
# node_modules. After the builds, the dist files that differ between
# consecutive commits are listed: a change only moves the paths that run it
# (rule 12), so this names what a measurement can attribute to it.
set -euo pipefail
OUT=$1
shift
REPO=$(cd "$(dirname "$0")/../.." && pwd)
mkdir -p "$OUT"
WT="$OUT/.wt"
prev=""
for c in "$@"; do
  if [ ! -d "$OUT/$c" ]; then
    # git's own error is the message: hidden, a missing commit exited 128 with none.
    if ! err=$(git -C "$REPO" worktree add --detach "$WT" "$c" 2>&1); then
      echo "cannot check out $c: $err"
      exit 1
    fi
    ln -s "$REPO/node_modules" "$WT/node_modules"
    if ! (cd "$WT" && npm run build >"$OUT/build-$c.log" 2>&1); then
      echo "build failed: $c (log $OUT/build-$c.log)"
      git -C "$REPO" worktree remove --force "$WT"
      exit 1
    fi
    cp -R "$WT/dist" "$OUT/$c"
    git -C "$REPO" worktree remove --force "$WT"
    echo "built $c"
  else
    echo "have $c"
  fi
  if [ -n "$prev" ]; then
    echo "  differs from $prev:"
    diff -rq "$OUT/$prev" "$OUT/$c" | grep -v '\.map \|\.d\.ts ' | awk '{ print "    " $2 }' || true
  fi
  prev=$c
done
