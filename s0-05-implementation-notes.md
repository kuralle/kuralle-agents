# S0-05 implementation notes — A0.5 terminal handoff targets

## Change
`Runtime` accepts optional `terminalHandoffTargets` (default `['human']`). Before agent resolution, terminal handoffs emit `{type:'handoff', targetAgent, reason}`, set `runState.status = 'paused'`, persist, and `break` — fixing the missing-agent throw for `escalate→human`.

## Test path
Primary assertion `escalate_to_human_does_not_throw` uses the full **escalate → `__escalate` suspend → `signalDelivery` resume → handoff** path (not the direct `{handoff:'human'}` shortcut). A second test covers direct handoff and asserts `handoffHistory` stays empty.

## Trade-offs
- **Double emit:** Explicit flow `{handoff:'human'}` still emits in `runFlow.ts` (line 157) and again in `Runtime` for terminal targets. Benign per PLAN §5; left out of scope.
- **Paused vs human-owned:** Run pauses with `activeAgentId` unchanged; Sprint 4 ownership gate is separate (REQ-21 inbound half).
- **Custom targets:** Config is a string set only; no validation that targets are non-agent ids.

## Root cause fixed
`Runtime.ts` treated every `loopResult.kind === 'handoff'` as an agent id lookup; `'human'` is a terminal seam, not an `AgentConfig`.
