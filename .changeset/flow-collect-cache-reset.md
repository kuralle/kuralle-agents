---
'@kuralle-agents/core': patch
---

Re-entering a completed flow no longer replays the previous run's collected data.

A collect node caches its extraction under `__collect_<nodeId>`. That cache is meant to survive turn boundaries — it is how fields accumulate over several user turns mid-flow — but it also survived the flow itself. Re-entering the same flow found the cache already complete, finished the collect node instantly with the previous run's values, and the action node acted on them.

Observed live: three maintenance reports for three different units produced three copies of the *first* work order, and the units actually reported were never touched.

The cache is now cleared on **fresh entry** (`!run.activeNode`), not on completion. Clearing at completion also worked for the duplicate, but broke mid-flow accumulation — `continuity.test.ts` and the G14 slot-correction test both encode that the cache must cross a turn boundary.
