#!/usr/bin/env bash
# Emit a line per terminal state for one dispatch, and — the point of this file —
# detect a HUNG worker from CPU that stops moving, not from a process that has exited.
#
# A hung worker is alive. Watching liveness alone reports "still running" forever; this run
# lost 99 minutes to exactly that before the stall was noticed by hand.
#
# Usage: stall-watch.sh <label> <result-file> <watch-dir> [flat-samples] [interval]
set -uo pipefail
label=$1; result=$2; dir=$3; max_flat=${4:-4}; interval=${5:-30}
flat=0; prev=""
leaf_cpu() { ps -eo time,command | grep -E "cursor-agent|codex exec|pi -p" | grep -v grep | awk '{print $1}' | head -1; }

while true; do
  if [ -f "$result" ]; then
    echo "$label -> $(jq -r '.status // .verdict // "unparseable"' "$result" 2>/dev/null)"; exit 0
  fi
  cpu=$(leaf_cpu)
  if [ -z "$cpu" ]; then
    echo "$label DIED without a result file"; exit 0
  fi
  # touched anything under the watch dir since the last sample? (excludes build output)
  touched=$(find "$dir" -newermt "$((interval + 5)) seconds ago" -type f 2>/dev/null \
            | grep -vE "/(dist|node_modules|\.git)/" | head -1)
  if [ "$cpu" = "$prev" ] && [ -z "$touched" ]; then
    flat=$((flat + 1))
    if [ "$flat" -ge "$max_flat" ]; then
      echo "$label STALLED — cpu flat at $cpu for $((flat * interval))s and no file written; kill and re-scope"
      exit 0
    fi
  else
    flat=0
  fi
  prev=$cpu
  sleep "$interval"
done
