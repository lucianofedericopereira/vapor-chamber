#!/usr/bin/env bash
# scripts/ab/session.sh <jobs-file> <out-dir>
#   npm run ab:session -- <jobs-file> <out-dir>
# One measurement session (docs/V8-RULES.md rule 17), started on the owner's
# "go": the user's other busy processes are demoted to background QoS for the
# session (macOS `taskpolicy -b`, which keeps them on the efficiency cores;
# their work goes on, slower), never this shell's ancestry, whose children
# would inherit it; restored on any exit. No load ceiling: each row of
# scripts/ab/ab.mjs judges its own validity (decisions, 2026-10-01).
# Jobs file, one per line, '#' comments:
#   <label> <distA> <distB> <workload.mjs> [ab.mjs options...]
# Each job's report goes to stdout and its raw rounds to <out-dir>/<label>.json.
# Not done: Time Machine and Spotlight (root processes, the owner's to pause).
set -uo pipefail
JOBS=$1
OUT=$2
cd "$(dirname "$0")/../.." || exit 2
mkdir -p "$OUT"
DEMOTED=()
if command -v taskpolicy >/dev/null 2>&1; then
  ME=$(id -un)
  ANC=" $$ "
  p=$$
  while [ "$p" -gt 1 ]; do p=$(ps -o ppid= -p "$p" | tr -d ' '); ANC+="$p "; done
  while read -r pid cpu comm; do
    case " $ANC " in *" $pid "*) continue ;; esac
    busy=$(awk -v c="$cpu" 'BEGIN { print (c >= 1.0) ? 1 : 0 }')
    noisy=0
    case "$comm" in *"Siri AI"*) continue ;; esac   # demoted by hand already
    case "$comm" in *claude*|*python*|*node*|*Code\ Helper*|*Waterfox*|*plugin-container*|*php*|*codex*|*Cursor*|*chrome*|*Chrome*) noisy=1 ;; esac
    if [ "$busy" = 1 ] || [ "$noisy" = 1 ]; then
      taskpolicy -b -p "$pid" 2>/dev/null && DEMOTED+=("$pid")
    fi
  done < <(ps -axo pid=,user=,%cpu=,comm= | awk -v u="$ME" '$2 == u { pid = $1; cpu = $3; $1 = $2 = $3 = ""; sub(/^ +/, ""); print pid, cpu, $0 }')
  restore() { for pid in "${DEMOTED[@]}"; do taskpolicy -B -p "$pid" 2>/dev/null; done; echo "session: restored ${#DEMOTED[@]} processes"; }
  trap restore EXIT
  echo "session: demoted ${#DEMOTED[@]} processes to background QoS"
else
  echo "session: no taskpolicy (not macOS), nothing demoted"
fi
echo "session: start $(date +%H:%M:%S), load $(uptime | awk -F "load averages?: " '{ print $2 }')"
while read -r label a b w rest; do
  case "$label" in ''|'#'*) continue ;; esac
  echo "##### $label: $(basename "$a") -> $(basename "$b"), $(basename "$w") $rest ($(date +%H:%M:%S))"
  # shellcheck disable=SC2086
  node scripts/ab/ab.mjs "$a" "$b" "$w" $rest --raw="$OUT/$label.json"
done < "$JOBS"
echo "session: done $(date +%H:%M:%S)"
