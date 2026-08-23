#!/usr/bin/env bash
# Watch ONE dispatched worker by pid. Emit one line when it stalls or exits.
#
# A hung worker is alive, so watching liveness reports "still running" forever — one dispatch on
# the cli-tui-split goal sat 99 minutes that way. Three fixes were tried here and each was wrong in
# its own way; all three are kept below because the next person will reach for them again.
#
#   1. File mtime alone false-positives. A worker legitimately pauses minutes between write bursts
#      while it reads and thinks. Watching writes only, three healthy workers were flagged at once.
#   2. `ps | head -1` picks the WRAPPER shell, whose CPU sits at 0:00.01 forever. Sampling that
#      reports every worker as stalled from the first poll — and killed a healthy one.
#   3. Scanning `ps` for worker-ish command lines and filtering with `grep -v grep` excludes THE
#      WORKER, because a codex prompt is embedded in its own command line and briefs routinely
#      contain the word "grep". Both watchers then reported DIED while both workers were healthy.
#
# So: no global scan and no pattern matching. The caller knows the pid it launched, so watch that
# pid. That also fixes a quieter bug in the scanning version — two concurrent workers shared one
# max-CPU signal, so a busy worker masked a stalled sibling.
#
# Usage: stall-watch.sh <label> <pid> <watch-dir> [flat-samples] [interval-seconds]
set -uo pipefail
label=$1; pid=$2; dir=$3; max_flat=${4:-10}; interval=${5:-30}
flat=0; prev=""

# CPU time of this pid and every descendant: the wrapper burns none, the leaf burns it all.
tree_cpu() {
  local roots="$pid" next found
  local total=""
  while [ -n "$roots" ]; do
    found=$(ps -eo pid=,ppid=,time= | awk -v r="$roots" '
      BEGIN { n = split(r, a, " "); for (i = 1; i <= n; i++) want[a[i]] = 1 }
      want[$1] || want[$2] { print $1, $3 }
    ')
    [ -z "$found" ] && break
    total="$total$(echo "$found" | awk '{print $2}')
"
    next=$(echo "$found" | awk '{print $1}' | tr '\n' ' ')
    [ "$next" = "$roots " ] || [ "$next" = "$roots" ] && break
    roots="$next"
  done
  echo "$total" | grep -v '^$' | sort -t: -k1,1n -k2,2n | tail -1
}

while true; do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$label EXITED — read its output and verify the claims"; exit 0
  fi

  cpu=$(tree_cpu)
  touched=$(find "$dir" -newermt "$((interval + 10)) seconds ago" -type f 2>/dev/null \
            | grep -vE "/(dist|node_modules|\.git)/" | head -1)

  # Real hang = CPU stops moving AND nothing is written. Thinking = CPU climbs with no writes.
  if [ -n "$cpu" ] && [ "$cpu" = "$prev" ] && [ -z "$touched" ]; then
    flat=$((flat + 1))
    if [ "$flat" -ge "$max_flat" ]; then
      echo "$label STALLED — cpu flat at $cpu and no write for $((flat * interval))s; kill and re-scope"
      exit 0
    fi
  else
    flat=0
  fi
  prev=$cpu
  sleep "$interval"
done
