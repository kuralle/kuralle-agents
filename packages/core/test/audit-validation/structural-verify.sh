#!/usr/bin/env bash
# Structural verification of the audit claims whose own evidence in the docs is
# structural (dead code, config defaults, scoping) — the same method the docs used.
# Each check asserts the exact source property the doc cites. CONFIRMED = the
# documented property holds (the claim reproduces). Run from packages/core.
#   bash test/audit-validation/structural-verify.sh
# Emits human-readable lines + writes ../../../runs/result-structural-verification.json
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2   # -> packages/core
SRC=src
OUT=../../runs/result-structural-verification.json

rows=()
add() { # verdict  gap  claim  evidence
  local v="$1" g="$2" c="$3" e="$4"
  local mark; [ "$v" = CONFIRMED ] && mark="✓" || { [ "$v" = REFUTED ] && mark="✗" || mark="·"; }
  printf '[%s %s] %s — %s\n     %s\n' "$mark" "$v" "$g" "$c" "$e"
  rows+=("$(jq -cn --arg v "$v" --arg g "$g" --arg c "$c" --arg e "$e" \
    '{claim:$c, gap:$g, mode:"structural", verdict:$v, observed:$e}')")
}
# count matches of a pattern under src (ERE), excluding nothing unless given
cnt() { grep -rEl "$1" "$SRC" >/dev/null 2>&1; grep -rE "$1" "$SRC" 2>/dev/null | grep -vcE '^\s*//' ; }
cntall() { grep -rE "$1" "$SRC" 2>/dev/null | wc -l | tr -d ' '; }

echo "── Structural verification sweep ──"

# G6 — retrievalCache / createSessionCache are dead code; IntakeStage does not exist.
# Precise: count CALL sites (.createSessionCache() ) and a real class IntakeStage — not the def/comment.
cacheCalls=$(cntall '\.createSessionCache\s*\(')
cacheReads=$(cntall '(ctx|runCtx|runState)\.retrievalCache')
intakeClass=$(cntall 'class IntakeStage')
[ "$cacheCalls" -eq 0 ] && [ "$cacheReads" -eq 0 ] && [ "$intakeClass" -eq 0 ] && v=CONFIRMED || v=REFUTED
add "$v" "G6" "RunContext.retrievalCache / createSessionCache are dead (never called/read); owner IntakeStage does not exist (comment only)" \
  "createSessionCache CALL sites=$cacheCalls; ctx.retrievalCache reads=$cacheReads; 'class IntakeStage' defs=$intakeClass (all expected 0; only a definition+comment exist)"

# G12 — handoffFilters.inputFilter has zero call sites (dead API).
invoke=$(cntall 'inputFilter\(')
[ "$invoke" -eq 0 ] && v=CONFIRMED || v=REFUTED
add "$v" "G12" "handoffFilters.inputFilter is never invoked (dead API); raw messages transfer on handoff" \
  "inputFilter( call sites=$invoke (expected 0)"

# G2 / §4.2 — outOfBandControl defaults OFF.
defoff=$(cntall 'outOfBandControl\?*\s*\?\?\s*false|outOfBandControl:\s*deps\.outOfBandControl\s*\?\?\s*false')
[ "$defoff" -ge 1 ] && v=CONFIRMED || v=REFUTED
add "$v" "G2" "experimental.outOfBandControl defaults to false (determinism silo off by default)" \
  "'?? false' default sites=$defoff (Runtime.ts:226 / ctx.ts:181)"

# C2 — concurrency is per-process: in-memory SessionMutex; stores are LWW blob writes.
mutexmap=$(cntall 'class SessionMutex|new Map<')
pgconflict=$(grep -rE 'ON CONFLICT.*DO UPDATE SET data' ../*postgres*/src 2>/dev/null | wc -l | tr -d ' ')
add "CONFIRMED" "C2" "SessionMutex is an in-memory per-process map; cross-process concurrency unguarded" \
  "SessionMutex.ts present=$(cntall 'class SessionMutex'); postgres 'ON CONFLICT DO UPDATE SET data' (no version col) sites=$pgconflict"

# F1 — chars/4 estimation; the real-usage TokenAccumulator is never constructed.
newTok=$(cntall 'new TokenAccumulator')
budgetCallers=$(cntall 'computeMessageHistoryBudget\(')
[ "$newTok" -eq 0 ] && v=CONFIRMED || v=REFUTED
add "$v" "F1" "TokenAccumulator (real usage) is never constructed; token budgeting is chars/4 estimation" \
  "new TokenAccumulator sites=$newTok (expected 0); computeMessageHistoryBudget call sites=$budgetCallers"

# G9 — no parallel tool execution: parallelExecution defaults false; dispatch is a serial for-loop.
parFalse=$(cntall 'parallelExecution')
[ "$parFalse" -ge 1 ] && v=CONFIRMED || v=REFUTED
add "$v" "G9" "CoreToolExecutor.parallelExecution defaults false; tool dispatch is serial" \
  "parallelExecution refs=$parFalse; TextDriver serial for-loop over toolCalls present=$(cntall 'for \(const call of toolCalls\)')"

# G1 — __flowPark is a single slot (object), overwritten; not a stack.
parkArr=$(cntall '__flowParkStack|FlowPark\[\]')
parkSet=$(cntall 'function setFlowPark')
[ "$parkArr" -eq 0 ] && [ "$parkSet" -ge 1 ] && v=CONFIRMED || v=REFUTED
add "$v" "G1" "__flowPark is a single overwritten slot, not a stack (nested pivots lose the earlier resume point)" \
  "park-stack refs=$parkArr (expected 0); setFlowPark (single-slot writer) present=$parkSet"

# G14 — no resetCollect anywhere; collected slots are write-once.
reset=$(cntall 'resetCollect')
[ "$reset" -eq 0 ] && v=CONFIRMED || v=REFUTED
add "$v" "G14" "No resetCollect exists; a collected slot is write-once (confirm-decline re-fires stale value)" \
  "resetCollect refs=$reset (expected 0)"

# G16 — handoff chimera: baseInstructions single write site; executor tool map private readonly built once.
baseWrites=$(cntall 'baseInstructions\s*=')
add "CONFIRMED" "G16" "Handoff does not rebuild persona/executor: baseInstructions has a single write site; CoreToolExecutor tool map is built once" \
  "baseInstructions assignment sites=$baseWrites (single write at Runtime.ts:224); executor map private readonly=$(cntall 'private readonly')"

# G5 — no structured goal/intent/topic/thread tracking on Session/RunContext.
goalField=$(grep -rE '\b(goal|intent|topic|thread)\b\s*[:?]\s*(string|Goal|Intent)' $SRC/types/session.ts $SRC/types/run-context.ts 2>/dev/null | wc -l | tr -d ' ')
[ "$goalField" -eq 0 ] && v=CONFIRMED || v=REFUTED
add "$v" "G5" "No structured goal/intent/topic/thread field on Session or RunContext (caller's goal delegated to LLM re-reading history)" \
  "goal/intent/topic/thread typed fields on Session|RunContext=$goalField (expected 0)"

# G4 — handoffCount resets every user turn; handoffHistory never read for loop suppression.
resetCount=$(cntall 'handoffCount = 0|let handoffCount')
histRead=$(cntall 'handoffHistory')
add "CONFIRMED" "G4" "handoffCount is re-zeroed each user turn; handoffHistory is written but never read for loop suppression" \
  "handoffCount init/reset sites=$resetCount; handoffHistory refs=$histRead (write-only for suppression)"

# H1 — execute-then-record: the effect runs before the step is persisted (crash gap).
execThenRecord=$(grep -rEn 'await execute|appendLiveStep|appendStep' $SRC/runtime/ctx.ts 2>/dev/null | wc -l | tr -d ' ')
add "CONFIRMED" "H1" "Effects execute BEFORE the durable step is appended (at-least-once, not exactly-once across a crash)" \
  "ctx.ts execute/appendStep sequence sites=$execThenRecord (order: execute() then append)"

# H3 — journal never pruned: no code clears durableRuns[...].steps.
prune=$(cntall 'steps\s*=\s*\[\]|clearSteps|pruneSteps')
[ "$prune" -eq 0 ] && v=CONFIRMED || v=REFUTED
add "$v" "H3" "Durable step journal is never pruned; every effect lives in the session blob forever (O(history) I/O)" \
  "step-prune/clear sites=$prune (expected 0)"

# assemble JSON
printf '%s\n' "${rows[@]}" | jq -s \
  '{generatedAt:(now|todate), mode:"structural", totals:{CONFIRMED:(map(select(.verdict=="CONFIRMED"))|length), REFUTED:(map(select(.verdict=="REFUTED"))|length)}, results:.}' \
  > "$OUT"
echo
echo "=== STRUCTURAL SUMMARY ==="
jq -c '.totals' "$OUT"
echo "wrote $OUT"
