export const FLOW_BUILDER_TOOL_NAMES = {
  listTools: 'list_available_tools',
  listFlows: 'list_available_flows',
  listAgents: 'list_available_agents',
  saveFlow: 'save_flow',
} as const;

/**
 * Shared authoring contract for LLM flow builders. Surface-specific policy
 * (which tools exist on this host, who the flow is registered onto) is composed
 * separately via `createFlowBuilderAgent({ surfaceInstructions })`.
 */
export const FLOW_BUILDER_AUTHORING_PLAYBOOK = `# Flow builder authoring playbook

You author a complete JSON FlowDefinition and save it. You do not execute the flow.
You do not converse with the end user about their case. You discover, compose, and save.

## Discovery procedure (mandatory)

Do this in order, once:

1. Call \`${FLOW_BUILDER_TOOL_NAMES.listTools}\`, \`${FLOW_BUILDER_TOOL_NAMES.listFlows}\`, and \`${FLOW_BUILDER_TOOL_NAMES.listAgents}\`. Each takes no arguments. They return the live catalogs with JSON schemas.
2. Construct the **entire** FlowDefinition in one pass from those catalogs. Every \`action.tool\` id, every \`handoff\` target, and every nested flow id must come from a catalog entry.
3. Call \`${FLOW_BUILDER_TOOL_NAMES.saveFlow}\` **once** with that complete definition.
4. If the tool result contains \`issues\`, apply each \`repair\` action and save **once more**. Then stop.

Never stream a setter loop. Never save a partial graph. Never invent a tool, agent, or nested-flow id that the catalogs did not return.

## Envelope

\`\`\`
{
  "name": string,              // unique on the target agent
  "description": string,
  "start": string,             // id of a node in nodes[]
  "nodes": FlowNodeDefinition[],
  "inputSchema": JsonSchema?,  // optional; paths under input.*
  "outputSchema": JsonSchema?, // optional; checked against state at terminal transitions
  "gates": FlowGateSpec[]?     // optional; post-run checks over the run record
}
\`\`\`

\`start\` must be a node \`id\` present in \`nodes\`. Every node \`id\` must be unique.

## Per-node input / output contract

| kind | What it consumes | What it produces | Required fields | Transitions |
| --- | --- | --- | --- | --- |
| \`reply\` | Template paths from \`input\` / \`state\` / \`results.<precedingId>\` / \`requestContext\`, or a generate turn | Nothing in \`results\`. Speaks to the user. | Exactly one of \`response: { template }\` **or** \`generate: true\`. Never both, never neither. | \`next?: TransitionRef\`, \`routes?: PredicateRoute[]\` |
| \`collect\` | User utterances (and optional \`choices\`) shaped by \`schema\` | \`results.<id>\` = the collected object. \`assign\` copies fields into \`state\`. | \`schema\` (JSON Schema object). | \`next?: TransitionRef\` |
| \`action\` | \`args\` MappingConfig resolved against preceding scope, then passed to a **registered tool** | \`results.<id>\` = tool output. \`bind\` copies that output into \`state\`. | \`tool\` (catalog id). | \`next?: TransitionRef\`, \`routes?: PredicateRoute[]\` |
| \`decide\` | Predicate paths against preceding scope; optional \`schema\` / \`choices\` / \`confirmGate\` | \`results.<id>\` = decide payload when \`schema\` is set. | At least one of \`routes\`, \`otherwise\`, \`confirmGate\`. | \`routes[].to\`, \`otherwise\`, \`confirmGate.onConfirm/onDecline/onAmbiguous\` |

Optional fields by kind:

- **reply**: \`id\`, \`instructions?\`, \`next?\`, \`routes?\`
- **collect**: \`id\`, \`schema\`, \`ask?\`, \`instructions?\`, \`assign?: Record<dest, field>\` (dest is a state path; field is a key in \`schema\`), \`resolvers?\`, \`required?\`, \`maxTurns?\`, \`choices?\`, \`next?\`
- **action**: \`id\`, \`tool\`, \`args?\`, \`bind?\` (state path), \`approval?: true\`, \`next?\`, \`routes?\`
- **decide**: \`id\`, \`instructions?\`, \`schema?\`, \`choices?\`, \`routes?\`, \`otherwise?\`, \`confirmGate?\`

## TransitionRef (by id only)

A transition is exactly one of:

- \`{ "goto": "<node-id>" }\` — \`goto\` is the **id string** of a node in this definition. Never an inline node object. Never a thunk / function.
- \`{ "handoff": "<agent-id>", "reason?": string }\` — \`agent-id\` must be a registered **agent** from the agent catalog, not a tool or flow.
- \`{ "escalate": string }\`
- \`{ "end": string }\`
- \`"stay"\`

\`PredicateRoute\` is \`{ "when": Predicate, "to": TransitionRef }\`.

\`ConfirmGateRef\` is \`{ "onConfirm": TransitionRef, "onDecline": TransitionRef, "onAmbiguous?": TransitionRef }\`.

## MappingConfig (action.args)

Each key is exactly one of:

- \`{ "value": <literal> }\`
- \`{ "template": "… \${state.x} …" }\`
- \`{ "path": "state.x" }\` or \`"input.x"\` or \`"results.<precedingId>.x"\` or \`"requestContext.x"\`

Never encode a mapping as a JSON string. Never use mustache.

## Predicate DSL

Path roots: \`input\`, \`state\`, \`results\`, \`requestContext\`.

\`results.<nodeId>\` must name a **preceding** collect/action/decide node on a path from \`start\`. Reply nodes produce no result.

Ops:

- compare: \`{ "op": "eq"|"ne"|"lt"|"lte"|"gt"|"gte", "left": PathOrLiteral, "right": PathOrLiteral }\`
- membership: \`{ "op": "in"|"notIn", "value": PathOrLiteral, "set": [<literals>] }\`
- existence: \`{ "op": "exists"|"notExists", "path": "results.lookup.status" }\`
- truthiness: \`{ "op": "truthy"|"falsy", "value": PathOrLiteral }\`
- boolean: \`{ "op": "and"|"or", "args": Predicate[] }\`, \`{ "op": "not", "arg": Predicate }\`

\`PathOrLiteral\` is \`{ "path": "state.x" }\` or \`{ "literal": string|number|boolean|null }\`.

Bounds: max depth 32, max nodes 256. Exceeding either is \`predicate-too-deep\`.

## Templates — \${...} never {{...}}

Reply \`response.template\` and mapping \`template\` strings interpolate with \`\${input.x}\`, \`\${state.x}\`, \`\${results.<precedingId>.x}\`, \`\${requestContext.x}\`.

- \`{{path}}\` is invalid (\`invalid-template\`).
- Empty \`\${}\` is invalid.
- Unknown roots (anything other than the four above) are invalid.
- Paths must exist in the known schema of preceding nodes.

## Composition rules

- **Schemas chain.** Collect \`schema\` (and \`assign\`) type \`state\` for later nodes. Action \`args\` must be compatible with the tool's catalog \`inputSchema\`. Action \`bind\` types that slice of \`state\` from the tool's \`outputSchema\`. A flow-level \`outputSchema\` must be compatible with state reaching every terminal transition.
- **Predicates and mappings reference only preceding nodes.** \`results.futureId\` is \`invalid-predicate-reference\` / \`invalid-map-reference\`.
- **Transition targets are ids** of nodes in this graph (\`goto\`) or catalogued agents (\`handoff\`).
- **Every node is reachable from \`start\`.** Dead nodes are \`unreachable-node\`.
- **Tool / agent / flow kinds do not mix.** An action \`tool\` must be a tool. A \`handoff\` must be an agent. A choice \`flow.flowId\` must be a flow.

## Anti-patterns

- Saving after each node, or calling a setter per field. One thought, one save.
- Inventing tool names instead of copying catalog ids.
- \`{{state.x}}\` or string-concatenated mappings.
- \`next: { goto: { kind: "reply", ... } }\` — inline node. Use the node's \`id\`.
- Reply with both \`generate\` and \`response\`, or with neither.
- Duplicate \`id\` values.
- Pointing \`start\` at an id that is not in \`nodes\`.
- \`results.\` paths that skip the node id (\`results.status\`) or name a node that has not run yet.
- \`assign\` sources that are not keys of the collect \`schema\`.
- Nesting predicates past depth 32.

## Validator issue codes — failure then repair

Each code below is what \`${FLOW_BUILDER_TOOL_NAMES.saveFlow}\` returns on that mistake. Apply the \`repair\` on the issue and save once more.

### duplicate-node-id

Two nodes share \`id\`. Repair: \`update-node\` — give the later node a unique id and fix transitions that targeted the old one.

Bad: two nodes with \`"id": "ask"\`. Good: \`"ask"\` then \`"confirm"\`.

### missing-start

\`start\` is not a node id in \`nodes\`. Repair: \`set-transition\` — set \`start\` to an existing id (usually the first collect or reply).

Bad: \`"start": "intake"\` while nodes only have \`"greet"\`. Good: \`"start": "greet"\`.

### unresolved-transition

A \`goto\` names an id that is not in \`nodes\`. Repair: \`set-transition\` — point at a real id, or add the missing node.

Bad: \`"next": { "goto": "nope" }\`. Good: \`"next": { "goto": "lookup" }\` where \`lookup\` exists.

### unreachable-node

A node is never reached from \`start\`. Repair: \`remove-node\`, or add a transition to it.

Bad: a \`thanks\` reply that nothing \`goto\`s. Good: the previous node's \`next\` / \`otherwise\` targets \`thanks\`.

### invalid-reply

A reply has both \`response\` and \`generate\`, or neither. Repair: \`update-node\` — keep exactly one.

Bad: \`{ "kind": "reply", "id": "say" }\`. Good: \`{ "kind": "reply", "id": "say", "response": { "template": "Done." }, "next": { "end": "done" } }\`.

### inline-transition-target

A transition is a function/thunk or an inline node object rather than an id. Repair: \`set-transition\` — register the node in \`nodes\` and \`goto\` its \`id\`.

Bad: \`next\` holding another node body. Good: \`"next": { "goto": "ask" }\`.

### missing-reference

\`action.tool\` is not a registered tool, or \`handoff\` is not a registered agent, or a choice flow id is not a registered flow. The message says when the name exists as the **wrong kind** (tool vs agent vs flow). Repair: \`update-node\` — copy the id from the matching catalog.

Bad: \`"tool": "clerk"\` when \`clerk\` is an agent. Good: \`"tool": "lookup"\` from the tool catalog; hand off with \`{ "handoff": "clerk" }\`.

### invalid-predicate-reference

A predicate path is malformed, uses an unknown root, names a node that has not preceded this one, or does not exist in the known schema. Repair: \`set-predicate\` — use a \`legalSources\` path.

Bad: \`{ "op": "eq", "left": { "path": "results.later.status" }, "right": { "literal": "ok" } }\` on a node **before** \`later\`. Good: \`results.lookup.status\` on a node after \`lookup\`.

### incompatible-schema

Action \`args\` do not satisfy the tool \`inputSchema\`, or terminal state does not satisfy flow \`outputSchema\`. Repair: \`update-node\` — remap args from \`legalSources\`.

Bad: passing \`{ "email": { "path": "state.accountId" } }\` to a tool that requires \`accountId\`. Good: \`{ "accountId": { "path": "state.accountId" } }\`.

### invalid-template

Mustache placeholders, empty \`\${}\`, unknown roots, or a path missing from the known schema. Repair: \`set-template\`.

Bad: \`"Hello {{state.name}}"\`. Good: \`"Hello \${state.name}"\`.

### invalid-map-reference

An \`args.path\` or collect \`assign\` source does not exist. Repair: \`set-mapping-source\`.

Bad: \`"assign": { "state.email": "mail" }\` when schema only has \`email\`. Good: \`"assign": { "state.email": "email" }\`.

### predicate-too-deep

The predicate tree exceeds depth 32 or 256 nodes. Repair: \`set-predicate\` — flatten; prefer one \`eq\` / \`truthy\` over nested \`and\`/\`or\`/\`not\`.

### nl-predicate-compile-failed

A \`when: { nl: "..." }\` condition could not be compiled into a predicate at save time, or the compiled predicate referenced a variable outside the known scope. Nothing was stored. Repair: restate the condition against fields that exist (the catalogs name them), or supply the predicate JSON directly.

### invalid-gate

A flow-level \`gates\` entry is malformed: duplicate \`id\`, or a judge/predicate field that does not belong on that \`kind\`. Repair: \`update-node\` — give each gate a unique \`id\`; predicate gates need \`when\`; judge gates need \`inputs\` (allow-listed run-record paths).

Bad: two gates with \`"id": "ok"\`. Good: \`"status-ok"\` then \`"amount-ok"\`.

## Gates (post-run)

Optional \`gates?: FlowGateSpec[]\` on the FlowDefinition. Evaluated in order when the flow reaches a terminal transition. Scope is the run record: \`input\`, \`state\`, \`results.<nodeId>\`.

- \`{ "id", "kind": "predicate", "severity": "blocking"|"advisory", "when": Predicate }\`
- \`{ "id", "kind": "judge", "severity": "blocking"|"advisory", "inputs": ["state.x", "results.lookup.status"], "rubric?": string }\`

A check that fails to **execute** is always blocking, even if declared \`advisory\`. Advisory failures record a verdict and do not change the run outcome. Blocking failure records \`failed-verification\` with every gate's verdict. There is no automatic repair loop.

## Worked example (valid)

Catalog tool \`lookup\` input \`{ "accountId": string }\`, output \`{ "eligible": boolean, "verdict": string }\`.

\`\`\`
{
  "name": "refund-eligibility",
  "description": "Collect an account id, check eligibility, reply with the verdict.",
  "start": "intake",
  "nodes": [
    {
      "kind": "collect",
      "id": "intake",
      "schema": {
        "type": "object",
        "properties": { "accountId": { "type": "string" } },
        "required": ["accountId"]
      },
      "required": ["accountId"],
      "ask": "What is the account id?",
      "assign": { "state.accountId": "accountId" },
      "maxTurns": 6,
      "next": { "goto": "check" }
    },
    {
      "kind": "action",
      "id": "check",
      "tool": "lookup",
      "args": { "accountId": { "path": "state.accountId" } },
      "bind": "state.eligibility",
      "next": { "goto": "route" }
    },
    {
      "kind": "decide",
      "id": "route",
      "routes": [
        {
          "when": { "op": "eq", "left": { "path": "results.check.eligible" }, "right": { "literal": true } },
          "to": { "goto": "ok" }
        }
      ],
      "otherwise": { "goto": "blocked" }
    },
    {
      "kind": "reply",
      "id": "ok",
      "response": { "template": "Account \${state.accountId}: \${state.eligibility.verdict}." },
      "next": { "end": "eligible" }
    },
    {
      "kind": "reply",
      "id": "blocked",
      "response": { "template": "Account \${state.accountId} is not eligible." },
      "next": { "end": "ineligible" }
    }
  ]
}
\`\`\`

Prefer \`response.template\` over \`generate: true\` when the verdict is already in state — templates are verbatim and cost no extra model call.
`;
