---
'@kuralle-agents/cli': patch
---

`kuralle send --store` now persists traces to the `<file>.traces.json` sidecar.

`send` passed a file-backed `SessionStore` but no `TraceStore`, and the loader defaults to `MemoryTraceStore` whenever a session store is supplied — so every trace was discarded when the one-turn process exited and `kuralle trace --store` reported "No traces found" for any session driven by `send`. `chat --store` already wired the sidecar; `send` now does the same, which is what the CLI guide always described for both.
