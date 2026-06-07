export const meta = {
  name: 'tools-vs-effecttools',
  description: 'Why does kuralle AgentConfig have BOTH tools and effectTools (and globalTools)? Map the split across AI SDK / OpenAI Agents / Pi / Mastra / Temporal-style durability; verdict: keep, unify, or rename.',
  phases: [
    { title: 'Read', detail: 'parallel readers: kuralle internals, AI-SDK/OpenAI model, peer harnesses, durable-execution prior art' },
    { title: 'Synthesize', detail: 'one analyst writes the grounded verdict doc' },
  ],
}

const ROOT = '/Users/mithushancj/Documents/asyncdot/openscoped/aria-flow'
const R = ROOT + '/research'
const AT = 'general-purpose'

const COMMON = `
GROUNDED source research. Cite \`relative/path.ts:line\` or doc URLs for every claim; read the actual files, do not guess from names. Be concrete, minimal, honest. Note Node-vs-Cloudflare-Workers portability where relevant.
Kuralle context: monorepo at ${ROOT}, core = packages/kuralle-core. AgentConfig (packages/kuralle-core/src/types/agentConfig.ts) has THREE tool-ish fields: tools?: ToolSet (from 'ai'), effectTools?: Record<string,AnyTool>, globalTools?: Record<string,AnyTool>. Durable tool primitive = defineTool() in tools/effect/defineTool.ts.
`

const rKuralle = `${COMMON}
TASK: Pin down EXACTLY what tools vs effectTools vs globalTools mean in kuralle-core and how each is executed.
Read in ${ROOT}/packages/kuralle-core/src:
- types/agentConfig.ts (the three fields + comments), types/effectTool.ts (Tool interface), tools/effect/defineTool.ts (defineTool, toolToAiSdk strips execute @49-63, buildToolSet schema-only + rawToolsBySet WeakMap @65-87)
- runtime/Runtime.ts (~110-145: effectTools merge into CoreToolExecutor), tools/effect/ToolExecutor.ts (CoreToolExecutor), runtime/channels/executeModelTool.ts, and how recorded steps give exactly-once: grep loadRecordedSteps, SessionRunStore, runtime/durable/*
- runtime/channels/TextDriver.ts (~200-227) + extractionTurn.ts (how agent.tools vs built effect tools reach the MODEL as visible schema)
- flow/nodeBuilders.ts (~55-90 rawToolsFromSet in-flow execution)
- Search the repo for the ADR / comment explaining the split (grep 'effect log','exactly-once','ADR 0001').
ANSWER precisely: (1) what is the model-VISIBLE surface vs the EXECUTED surface; (2) does agent.tools (raw AI SDK ToolSet) get auto-executed by the AI SDK, and is that durable? (3) what exactly does effectTools buy (exactly-once on retry/replay — when does replay happen: voice? CF DO? crash?); (4) why globalTools is separate (ADR 0001). Give the execution path for each field with file:line.`

const rAiSdk = `${COMMON}
TASK: How do the Vercel AI SDK and OpenAI Agents SDK model tools — one concept or two? Do they offer durable/exactly-once execution?
Use Context7 MCP (resolve 'ai' / Vercel AI SDK, and 'openai-agents') and web for the canonical tool API. Capture: AI SDK tool({description,inputSchema,execute}) — execute is OPTIONAL; what happens when execute is omitted (manual tool-call loop / you run it); does generateText/streamText auto-execute tools in a loop (maxSteps)? Is there any built-in idempotency/exactly-once/replay? OpenAI Agents SDK / function-calling: same question.
ANSWER: the native duality (schema-only vs with-execute) already exists in the AI SDK; durability does NOT. Quote the docs (URLs). This tells us whether kuralle's effectTools is adding something the AI SDK lacks, or duplicating something it has.`

const rPeers = `${COMMON}
TASK: Do peer agent frameworks split tool-declaration from durable-execution?
Read: ${R}/pi/packages/coding-agent/src/core/tools/ (how Pi defines+executes a tool; is there any exactly-once/idempotency?), ${R}/pi/packages/agent/src/harness/agent-harness.ts (tool exec in the loop). Mastra: ${R}/mastra — grep for createTool / tool execute / and any 'idempot'/'durable'/'replay'/'resumable' tool execution. cloudflare-agents: ${R}/cloudflare-agents-sdk/packages/agents (how tools run inside a Durable Object; does DO durability cover tool side-effects or just state?).
ANSWER: for each, ONE tool concept or two? Where does durability live (the framework? the DO? nowhere)? Cite file:line. This shows whether kuralle's two-field split is unique or shared.`

const rDurable = `${COMMON}
TASK: Distill the canonical "side effects must run exactly-once across retries/replay" pattern from durable-execution prior art and map it to kuralle's effectTools.
Web/Context7: Temporal (Workflow code vs Activities — why side effects are Activities; determinism/replay), Effect-TS (Effect as a description of an effect), Inngest / DBOS / Restate (durable steps), LangGraph (checkpointer + tool nodes — are tool calls re-executed on resume?). Keep it tight — the PRINCIPLE, with 1-2 source URLs each.
ANSWER: the universal model = a deterministic replayable control-flow + a logged set of non-deterministic side-effecting STEPS that are memoized so replay returns the recorded result instead of re-running. Map kuralle: effectTools = Activities/Steps (logged, exactly-once via recorded steps); the agent/flow loop = the deterministic workflow; raw AI SDK tools-with-execute = un-logged side effects (the footgun). State whether the tools/effectTools split is the SAME pattern as Temporal activities (essential) or accidental.`

const SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    path: { type: 'string' },
    verdict: { type: 'string', enum: ['keep-both', 'unify-to-one', 'rename-or-restructure', 'keep-both-but-document'] },
    one_paragraph_answer: { type: 'string' },
    proposed_changes: { type: 'array', items: { type: 'string' } },
    citation_count: { type: 'number' },
  },
  required: ['path', 'verdict', 'one_paragraph_answer'],
}

phase('Read')
const findings = (await parallel([
  () => agent(rKuralle, { label: 'read:kuralle-tools', phase: 'Read', agentType: AT }),
  () => agent(rAiSdk, { label: 'read:ai-sdk', phase: 'Read', agentType: AT }),
  () => agent(rPeers, { label: 'read:peers', phase: 'Read', agentType: AT }),
  () => agent(rDurable, { label: 'read:durable-prior-art', phase: 'Read', agentType: AT }),
])).filter(Boolean).join('\n\n========\n\n')

phase('Synthesize')
const out = await agent(`${COMMON}
Write a GROUNDED analysis+verdict to EXACTLY this path with the Write tool: ${R}/tools-vs-effecttools-analysis.md
Match the house style of ${R}/fs-skills-harness-synthesis.md (concrete, file-cited, decision-oriented).

Reader findings:
=== FINDINGS START ===
${findings}
=== FINDINGS END ===

The doc MUST contain:
1. TL;DR — answer "why both tools and effectTools (and globalTools)?" in 4 sentences + the verdict.
2. "What each field actually is" — model-VISIBLE surface vs EXECUTED surface vs durable-vs-not, with the exact execution path for each (file:line). Make crystal clear what toolToAiSdk stripping execute accomplishes.
3. "The mapping table" — columns: kuralle field | AI SDK | OpenAI Agents | Pi | Mastra | Temporal/durable analog. One row per concept (declaration, execution, durability/exactly-once, always-on safe tools).
4. "Why you can't 'just have tools'" — the durability/exactly-once argument (when replay happens in kuralle: voice turns, CF DO, crash recovery) AND the honest counter-argument (could it collapse to ONE field where every tool is durable-by-default + an interop adapter wraps raw AI SDK tools?). Weigh both.
5. "Recommendation" — pick the verdict. If keep-both: how to document/guardrail the footgun (raw execute bypasses durability). If unify: the exact AgentConfig change + migration + how raw AI SDK interop is preserved + Workers portability. Be concrete: name fields, files (agentConfig.ts, defineTool.ts, Runtime.ts).
6. Risks / non-goals.
Cite file:line for every kuralle claim and a URL for every external claim. Quality over length.
Then RETURN the structured object.`,
  { label: 'synth:tools-vs-effecttools', phase: 'Synthesize', agentType: AT, schema: SCHEMA })

return out
