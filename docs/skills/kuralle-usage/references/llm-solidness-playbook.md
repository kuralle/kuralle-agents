# LLM Agent Solidness Playbook

This playbook captures what consistently worked across Line/Pipecat/Dograh style systems and what to enforce in Aria.

## 1) Prompt architecture: global + local agenda

Use prompt composition, not one giant system prompt.

- Global role prompt: stable policy, tone, non-negotiables.
- Node/step agenda: what to do now.
- Transition contract: when it is valid to move.

In Aria:
- Use `defaultRolePrompt` + node `prompt`.
- Keep SOP in flow nodes.
- Add transition contracts (`label`, `conditionText`, `toolOnly`, `requiresUserTurn`).

## 2) Constrain behavior with contracts

For non-flow LLM agents, treat tools as contracts.

- Input schemas must be strict.
- Tool outputs must be data-only and deterministic.
- Do not let tools produce user-facing prose.

## 3) Make side effects idempotent

Any external write (CRM/webhook/DB) must be idempotent.

Aria runtime injects `experimental_context.idempotencyKey` into tool options.

```ts
execute: async (input, options) => {
  const key = options?.experimental_context?.idempotencyKey;
  await saveToCrm(input, { idempotencyKey: key });
  return { ok: true };
}
```

`createHttpTool` also forwards this as `Idempotency-Key` for non-GET requests.

## 4) Persist the right events, not token noise

Use message-level observability by default.

Recommended:
- `input`
- `tool-call` / `tool-result` / `tool-error`
- `flow-transition` / `handoff`
- terminal `done`/`error` with final text

Avoid token-delta persistence by default unless debugging.

```ts
streamCallback: {
  eventMode: 'message',
  emitTextDeltas: false,
  emitToolEvents: true,
  emitTransitionEvents: true,
  emitFinalText: true,
}
```

## 5) Keep replay/debug state in session

For every turn, keep replayable event history.

In Aria:
- `session.workingMemory.runtimeEventLog` stores:
  `user`, `assistant_final`, `tool_call`, `tool_result`, `tool_error`, `transition`.
- Runtime checkpoints on `tool-result`, `tool-error`, `flow-transition`, and handoff state changes.

## 6) Routing discipline for multi-agent systems

- Always use structured triage when routing matters.
- Triage should route, not chat.
- Non-triage agents should only handoff if explicitly allowed.

## 7) Context discipline

- Keep recent short-term conversation in the window.
- Summarize older context with explicit budgets.
- Persist verified facts only; do not persist speculation.

## 8) Deterministic test stack

Production confidence requires both:

- Scenario tests: happy path + edge/error paths.
- Replay tests: re-run stored transcripts and assert behavior stability.

Minimum scorecard:
- task completion
- tool-call correctness
- transition correctness
- safety regressions
- latency budget

## 9) What to avoid

- Monolithic prompts carrying SOP steps.
- Free-text transitions without explicit contracts.
- Side-effect tools without idempotency.
- No event trail for debugging/replay.
- Using model upgrades as a substitute for runtime controls.
