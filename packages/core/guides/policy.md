# Tool Policy

Decide whether each tool call runs, asks a human, or is refused — enforced at the gate, not in the prompt.

A `Policy` decides what happens when an agent tries to call a tool: it **runs**, it **asks** a human first, or it is **refused**.

> **Visibility vs authorization**
>
> `toolScope` on a reply node decides what the model **sees**. `Policy` decides whether a call is **allowed to run**. They are separate layers — narrowing visibility does not replace a policy, and a policy does not hide a tool the model should never have been offered. See [Flows → Narrowing tools with toolScope](./flows.md#narrowing-tools-with-toolscope).

```ts
interface Policy {
  decide(req: PolicyRequest): PolicyDecision | Promise<PolicyDecision>;
}

type PolicyDecision =
  | { kind: 'allow' }
  | { kind: 'ask'; title?: string }
  | { kind: 'deny'; reason: string };

interface PolicyRequest {
  toolName: string;
  args: unknown;   // the arguments the model supplied
  def?: AnyTool;   // the tool definition, when resolvable
}
```

One method, deliberately. Everything a policy needs is in the request and the only output is the decision — so a policy cannot execute the tool, mutate the run, or become a second place where control flow lives.

## Why not just `needsApproval`

`needsApproval: true` answers exactly one question — *pause for a human?* — and it still does, unchanged. But it cannot express the things a governed run actually needs:

- a worker that may **read but not write**
- an **allowlist** of shell commands
- a spend cap that gates **above a threshold** and not below it
- any rule that depends on the **arguments** rather than the tool name

That last one is the clearest case. A `dispatch_vendor` call at $180 and the same call at $320 are the same tool and need different answers. A boolean on the tool definition has nowhere to put that.

> **Nothing changes until you opt in**
>
> The default policy returns `ask` for a tool marked `needsApproval` and `allow` for everything else — exactly the behaviour every existing agent already has. `needsApproval` is now sugar over `Policy`, not a separate mechanism.

## Setting a policy

Set it on the runtime as a default, or on an agent to override it. Per-agent is what a delegated worker needs — a read-only explorer and a writing executor are the same runtime with different policies.

`tool-policy.ts`:

```typescript
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';
import {
  ALLOW,
  composePolicies,
  createRuntime,
  defineAgent,
  defineTool,
  readOnlyPolicy,
  type Policy,
} from '@kuralle-agents/core';

const read_file = defineTool({
  name: 'read_file',
  description: 'Read a file from the project.',
  replay: false,
  parallelSafe: true,
  input: z.object({ path: z.string() }),
  execute: async ({ path }) => ({ path, content: '…' }),
});

const write_file = defineTool({
  name: 'write_file',
  description: 'Overwrite a file in the project.',
  input: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path }) => ({ written: true, path }),
});

const dispatch_vendor = defineTool({
  name: 'dispatch_vendor',
  description: 'Dispatch a vendor to a unit.',
  input: z.object({ unitId: z.string(), estimateUsd: z.number() }),
  execute: async ({ unitId, estimateUsd }) => ({ dispatched: true, unitId, estimateUsd }),
});

// A rule the model cannot argue with, and that `needsApproval` cannot express: the same
// tool is allowed or gated depending on the arguments it was called with.
const spendCap: Policy = {
  decide: ({ toolName, args }) => {
    if (toolName !== 'dispatch_vendor') return ALLOW;
    const { estimateUsd } = args as { estimateUsd: number };
    return estimateUsd > 250
      ? { kind: 'ask', title: `Approve $${estimateUsd} — over the $250 cap` }
      : ALLOW;
  },
};

// A worker that may look but not touch. write_file stays registered and model-visible;
// the gate is what stops it, not the prompt.
export const explorer = defineAgent({
  id: 'explorer',
  model: openai('gpt-4.1-mini'),
  instructions: 'Inspect the codebase and answer questions.',
  globalTools: { read_file, write_file },
  policy: readOnlyPolicy(['write_file']),
});

export const dispatcher = defineAgent({
  id: 'dispatcher',
  model: openai('gpt-4.1-mini'),
  instructions: 'Handle maintenance requests.',
  globalTools: { read_file, dispatch_vendor },
  // Composition can only ever be MORE restrictive: a `deny` from either policy wins, and
  // no later policy can turn it back into an allow.
  policy: composePolicies(spendCap, readOnlyPolicy([])),
});

export const runtime = createRuntime({
  agents: [explorer, dispatcher],
  defaultAgentId: 'dispatcher',
  // Runtime default for any agent that does not set its own.
  policy: { decide: () => ALLOW },
});
```

## What the model sees

A denial reaches the model as a readable tool result, not a crash:

```json
{ "__denied": true, "toolName": "write_file", "deniedBy": "policy",
  "message": "The \"write_file\" action was not approved by policy. Reason: write_file is not available to a read-only agent. Tell the user it was declined; do not retry it." }
```

This reuses the approval-denied path on purpose — *"was not approved, do not retry"* is the correct instruction for a rule as well as for a human saying no. The `reason` your policy returns is included, so the model can explain the refusal rather than guessing at it.

Observed live against `gpt-4.1-mini` with the `explorer` agent above:

> I am unable to modify the file as the action to write to the file is not permitted. I can only read files in this environment. If you need, I can help you with instructions on how to update the version.

The tool's `execute` never ran.

## Built-in policies

- **`needsApprovalPolicy`** — the default. Asks for `needsApproval` tools, allows the rest.
- **`readOnlyPolicy(mutatingTools)`** — denies the named tools, and honours `needsApproval` on everything else.
- **`composePolicies(...policies)`** — first non-allow decision wins, in order.

`composePolicies` is constrained so composition can only ever be **more** restrictive: a `deny` from any policy wins, and no later policy can turn it back into an allow. That is the property that makes composing policies safe to reason about.

## Policy and handoffs

A policy is swapped when the run hands off to another agent, the same way the tool executor is. Without that, a delegated read-only worker would inherit the coordinator's write permission — which would defeat the point of giving it one.

> **A policy is not a sandbox**
>
> `Policy` governs which **tool calls** are permitted. It does not constrain what a permitted tool then does. A shell tool allowed by policy can still reach anything the OS user can — scope that inside the tool, or run the process in an isolated environment.

## Related

- [Tools](./tools.md) — defining the tools a policy governs
- [Dynamic Flows](./dynamic-flows.md) — the same `Policy.decide` gate on `stored-flows:read` / `stored-flows:write` HTTP routes
- [Durable Execution](./durable-execution.md) — what an `ask` decision does: a durable pause that survives process death, and how the decision is delivered
- [Release Governance Agent](https://github.com/kuralle/kuralle-agents/tree/main/apps/examples/release-governance-agent) — a complete custom policy that rejects writes to an immutable repository mount and asks before draft publication
