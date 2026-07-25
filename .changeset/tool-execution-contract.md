---
'@kuralle-agents/core': major
---

Fix control-flow signals being swallowed on the model tool path, and close four tool-execution gaps found comparing against OpenAI Agents JS, LangGraph, Mastra, DeepAgents, and the AI SDK.

**Fixed: a model-issued `needsApproval` tool never paused the run.** `ctx.tool` throws `SuspendError` to suspend, and `executeModelToolCall` caught every error into a tool-error result. The run state said `paused` while the turn continued and handed the model the string `Run suspended waiting for __approval` as a tool failure. Flow `action` nodes were unaffected. Control-flow signals are now returned as a value through the tool dispatcher — preserving its never-rejects contract, which the parallel path depends on — and rethrown once the batch has settled, so no sibling effect is abandoned with its journal step left `running`.

**Fixed: a denied approval crashed the turn.** `ToolApprovalDeniedError` was caught by nobody — it is not degradable, so the rejection escaped `Runtime.run` entirely and neither the model nor the user learned why. On the model path a denial is now a result (`{ __denied: true, toolName, deniedBy, message }`) so the agent can say the request was declined. Flow `action` nodes still throw, since their author chose the call and can catch it or branch on `ctx.approve()`.

**Fixed: `timeoutMs` abandoned the tool instead of cancelling it.** The timeout now reaches the tool as an abort on `ctx.abortSignal`, so a cooperative tool stops working when the runtime stops waiting.

**Added `limits.maxToolConcurrency`.** A parallel batch was unbounded — the model's batch size decided how many tools ran at once. Omitted, behaviour is unchanged.

**Added `onError` to `defineTool`.** Recover from a thrown error by returning a result the model can act on; the recovered value is validated and journaled as a success. Not called for timeouts, aborts, schema violations, or approval decisions.

**Async-generator tools now stream.** Each `yield` is emitted immediately as an internal `tool-result` part with `preliminary: true`. Only the aggregate is journaled, so replay stays deterministic.
