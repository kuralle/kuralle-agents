#!/usr/bin/env bash
# Emit one line per terminal state for a dispatch, and detect a HUNG worker.
#
# A hung worker is alive, so watching liveness reports "still running" forever — one dispatch on
# this goal sat 99 minutes that way. But the naive fixes are both wrong, and both were tried here:
#
#   * File mtime alone false-positives. A worker legitimately pauses minutes between write bursts
#     while it reads and thinks. Watching writes only, three healthy workers were flagged at once.
#   * `ps | head -1` picks the WRAPPER shell, whose CPU sits at 0:00.01 forever. Sampling that
#     reports every worker as stalled from the first poll.
#
# So: take the MAX cpu across matching processes (the leaf, not the wrapper), and require CPU flat
# AND no writes together before calling it. Real hang = CPU stops moving; thinking = CPU climbs.
#
# Usage: stall-watch.sh <label> <result-file> <watch-dir> [flat-samples] [interval-seconds]
set -uo pipefail
label=$1; result=$2; dir=$3; max_flat=${4:-10}; interval=${5:-30}
flat=0; prev=""

# Max CPU across every worker-ish process — the leaf burns CPU, the wrapper does not.
leaf_cpu() {
  ps -eo time,command \
    | grep -E "cursor-agent|codex exec|pi -p" | grep -v grep \
    | awk '{print $1}' | sort -t: -k1,1n -k2,2n | tail -1
}

while true; do
  if [ -f "$result" ]; then
    echo "$label -> $(jq -r '.status // .verdict // "unparseable"' "$result" 2>/dev/null)"; exit 0
  fi
  cpu=$(leaf_cpu)
  [ -z "$cpu" ] && { echo "$label DIED without a result file"; exit 0; }

  touched=$(find "$dir" -newermt "$((interval + 10)) seconds ago" -type f 2>/dev/null \
            | grep -vE "/(dist|node_modules|\.git)/" | head -1)

  if [ "$cpu" = "$prev" ] && [ -z "$touched" ]; then
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
