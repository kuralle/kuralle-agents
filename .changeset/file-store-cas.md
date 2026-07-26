---
'@kuralle-agents/cli': patch
---

`fileSessionStore` now implements compare-and-swap, fixing lost journal steps.

Its `save()` was a read-all / mutate / write-all with no version check, while `MemoryStore` throws `StaleWriteError` on a version mismatch. The durable journal appends through `mutateSessionWithRetry`, which exists to retry on exactly that error — so against the file store two concurrent appends both read the same version, both wrote, and the losing append vanished. Its `finalizeStep` then failed with `Step not found for run …`, surfacing mid-conversation as a client-facing error.

Observed live at 3/3 with parallel `replay: false` tools; 0/5 after the fix.
