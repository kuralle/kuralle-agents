---
'@kuralle-agents/core': patch
---

A suspend no longer surfaces as a user-facing error from the streaming path.

`speakGated` has two catch sites that turned any exception into a client-channel `error` part. A `SuspendError` unwinds through there on its way to the host loop, so pausing for approval printed `error: Run suspended waiting for __approval` mid-conversation. Both sites now rethrow control-flow signals ahead of the generic handler — the rule `executeModelToolCall` and `runFlow` already applied, on a third path that was missed.
