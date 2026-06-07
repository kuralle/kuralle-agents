export const meta = {
  name: 'fs-harness-research',
  description: 'Ground-truth study of FS / Skills-Scripts / agent-harness primitives across Flue, Hare, cloudflare-agents, Mastra, Pi + harness-engineering sources; emit 5 grounded plan .md files for Kuralle',
  phases: [
    { title: 'Read', detail: 'parallel readers extract primitives from each repo/source with file:line citations' },
    { title: 'Synthesize', detail: 'one synthesizer per research task reads kuralle-core, writes its plan .md, returns path+summary' },
  ],
}

const ROOT = '/Users/mithushancj/Documents/asyncdot/openscoped/aria-flow'
const R = ROOT + '/research'
const AT = 'general-purpose'

const COMMON = `
You are a senior framework engineer doing GROUNDED source research. Rules:
- READ the actual files (use Read/Grep/Bash). Do NOT speculate from names. Every claim must cite \`relative/path.ts:line\` or a transcript/web file.
- Deconstruct to PRIMITIVES: the smallest reusable interfaces/abstractions, not feature lists.
- Be concrete and minimal. No fluff, no over-abstraction. Note what is portable (Node AND Cloudflare Workers) vs runtime-specific.
- Kuralle context: monorepo at ${ROOT}. Core agent framework is packages/kuralle-core. AgentConfig (packages/kuralle-core/src/types/agentConfig.ts) currently has tools/effectTools/globalTools/knowledge/memory/flows but NO fs/workspace/skills/scripts/bash. Durable tool primitive is defineTool({name,description,input:zod,execute}) in packages/kuralle-core/src/tools/effect/defineTool.ts. Run/session model in packages/kuralle-core/src/runtime/openRun.ts (RunState.messages/state). Kuralle runs on Node/Bun (@kuralle-agents/hono-server) AND Cloudflare Workers/DO (@kuralle-agents/cf-agent).
`

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'absolute path of the .md file written' },
    summary: { type: 'string', description: '3-6 sentence summary of the plan' },
    proposed_kuralle_changes: { type: 'array', items: { type: 'string' }, description: 'concrete proposed additions (package/file/AgentConfig field)' },
    open_questions: { type: 'array', items: { type: 'string' } },
    citation_count: { type: 'number', description: 'approx number of file:line / source citations in the doc' },
  },
  required: ['path', 'summary', 'proposed_kuralle_changes'],
}

// ---------- READER BRIEFS ----------
const rFlueFS = `${COMMON}
TASK: Extract Flue's filesystem + sandbox + agent-loop primitives.
Read in ${R}/flue:
- packages/runtime/src/sandbox.ts, sandbox-compat.ts, harness.ts, agent.ts, tool.ts
- packages/runtime/src/cloudflare/virtual-sandbox.ts, cloudflare/cf-sandbox.ts
- examples/hello-world/src/workflows/fs-test.ts, fs-surface-test.ts, with-tools.ts, with-sandbox.ts (these import { Bash, InMemoryFs } from 'just-bash')
- package.json (just-bash version)
Also: how does Flue expose FS to the model (as bash tool? as IFileSystem?), how does it pick Node vs CF sandbox, and how does just-bash's IFileSystem interface look (check node_modules/just-bash if present, else infer from usage).
Return: primitive inventory (interface shapes + file:line), Node-vs-CF split, how just-bash is wired, and the 3 best ideas Kuralle should copy.`

const rHareFS = `${COMMON}
TASK: Extract Hare's storage/sandbox approach — the CONTRAST case (CF-native, tools-not-VFS).
Read in ${R}/hare:
- packages/tools/src/sandbox.ts, r2.ts, kv.ts, sql.ts, browser.ts, factory.ts, index.ts
- packages/agent/src/{hare-agent.ts, edge-agent.ts, factory.ts, types.ts}
Answer: does Hare build a virtual filesystem at all, or expose Cloudflare storage primitives (R2/KV/D1/sandbox) directly as tools? What is its agent loop? What does Kuralle learn from the "wire-CF-primitives-as-tools" stance vs a portable VFS?
Return: primitive inventory with file:line + the key architectural lesson/contrast.`

const rCfFS = `${COMMON}
TASK: Extract cloudflare-agents 'shell' filesystem primitives (the cleanest IFileSystem reference).
Read in ${R}/cloudflare-agents-sdk:
- packages/shell/src/fs/interface.ts, in-memory-fs.ts, path-utils.ts, encoding.ts
- packages/shell/src/filesystem.ts, workspace.ts, backend.ts, memory.ts, workers.ts
- packages/shell/src/git/fs-adapter.ts, git/provider.ts, git/index.ts
Capture the EXACT IFileSystem interface (method signatures), how in-memory vs durable (DO/backend) is abstracted, how git rides on top of the FS, and the workspace concept.
Return: the IFileSystem interface verbatim (with file:line), the backend abstraction, and what to copy.`

const rMastraFS = `${COMMON}
TASK: Extract Mastra's workspace/filesystem primitives + skills domain.
Read in ${R}/mastra:
- packages/core/src/workspace/filesystem/{filesystem.ts, local-filesystem.ts, composite-filesystem.ts, mastra-filesystem.ts, mount.ts, file-read-tracker.ts, file-write-lock.ts, index.ts, fs-utils.ts}
- packages/core/src/storage/domains/skills/filesystem.ts, storage/domains/workspaces/filesystem.ts
Capture: Mastra's FileSystem interface, the composite/mount pattern (mounting multiple backends), file-read-tracker & write-lock (why they exist), and how Skills are stored on the FS.
Return: interface shapes (file:line), the composite/mount + read-tracker patterns, and the 3 best ideas for Kuralle.`

const rMintlify = `${COMMON}
TASK: Distill the ChromaFs (knowledge-base-as-filesystem) pattern + just-bash.
Read ${R}/_sources/web/mintlify-chromafs.md fully. If ${R}/flue contains node_modules/just-bash or just-bash types, inspect the IFileSystem interface there too.
Capture: why agents converge on grep/cat/ls/find over a pluggable IFileSystem; the path-tree manifest bootstrap; RBAC-by-tree-pruning; read-only EROFS statelessness; coarse(DB)->fine(in-mem) grep; lazy file pointers. Map each to a Kuralle "support agent over a local knowledge base" use case.
Return: the pattern distilled to primitives + a concrete sketch of a Kuralle "RagFs/KnowledgeFs" adapter over the existing @kuralle-agents/rag stores.`

// Skills/scripts readers
const rFlueSkills = `${COMMON}
TASK: Extract Flue's Skills (and any Scripts) mechanism.
Read in ${R}/flue:
- packages/runtime/src/skill-frontmatter.ts, skill-md.d.ts
- examples/imported-skill/src/skills/review/SKILL.md, CHECKLIST.txt
- examples/imported-skill/src/workflows/with-imported-skill.ts, with-custom-bash.ts
- examples/imported-skill/flue.config.ts, README.md
Capture: the SKILL.md format (frontmatter fields), how a skill is imported/registered, how its scripts/checklists are made available to the agent, and how it relates to the bash sandbox.
Return: the SKILL.md schema (verbatim fields) + the load/exposure mechanism with file:line.`

const rPiSkills = `${COMMON}
TASK: Extract Pi's skills + slash-commands + resource-loading mechanism.
Read in ${R}/pi:
- packages/agent/src/harness/skills.ts
- packages/coding-agent/src/core/skills.ts, slash-commands.ts, resource-loader.ts, system-prompt.ts
Capture: how Pi discovers/loads skills (dirs? frontmatter? progressive disclosure?), how skills/slash-commands inject into the system prompt or tool set, and how scripts are executed.
Return: primitive inventory with file:line + how it differs from Flue's SKILL.md.`

const rSkillsTranscripts = `${COMMON}
TASK: Distill the Anthropic "Agent Skills + Scripts" standard and the "super agent" patterns (OpenClaw/Hermes/Claude Code) from transcripts.
Read fully: ${R}/_sources/transcripts/sSqzg_W8OnA.txt (Agent Skills + Scripts) and ${R}/_sources/transcripts/bxjmFlopZqc.txt (rise of the super agent).
Capture: what a "Skill" is (folder + SKILL.md + scripts), progressive disclosure, when scripts beat tools, the security model, and how OpenClaw/Hermes/Claude Code structure skills. Web-search to confirm the canonical Anthropic Agent Skills spec (SKILL.md frontmatter: name, description; bundled scripts/resources) and cite URLs.
Return: the canonical Skills+Scripts model + what Kuralle must add to support it (conversational, not coding).`

// Pi harness readers
const rPiAgentLoop = `${COMMON}
TASK: Extract Pi's GENERIC agent harness/loop primitives (packages/agent = the reusable core, the part analogous to kuralle-core).
Read in ${R}/pi/packages/agent/src:
- agent-loop.ts, agent.ts, index.ts, types.ts, node.ts
- harness/agent-harness.ts, harness/system-prompt.ts, harness/prompt-templates.ts, harness/messages.ts, harness/types.ts
- harness/env/nodejs.ts (env abstraction), harness/session/{session.ts, jsonl-storage.ts, memory-storage.ts}
- harness/compaction/{compaction.ts, branch-summarization.ts, utils.ts}
Capture: the loop shape (tool-call/exec cycle), tool registry, system-prompt assembly, env abstraction (how IO/fs/exec are injected for portability), session storage, and context compaction. These are the harness primitives.
Return: primitive inventory with file:line + which are conversational-harness essentials.`

const rPiCodingAgent = `${COMMON}
TASK: Extract Pi's coding-agent APPLICATION primitives (the layer built on packages/agent).
Read in ${R}/pi/packages/coding-agent/src/core:
- agent-session.ts, agent-session-runtime.ts, agent-session-services.ts
- bash-executor.ts, exec.ts, tools/ (list + read key tool defs)
- session-manager.ts, event-bus.ts, sdk.ts, model-registry.ts, model-resolver.ts, extensions/, output-guard.ts, compaction/
Capture: how the app composes the generic harness, how bash/tools are executed, the event-bus/streaming, the SDK surface, extensions mechanism. Mark which primitives are coding-specific vs reusable for a CONVERSATIONAL agent.
Return: primitive inventory with file:line + the reusable-vs-coding-specific split.`

const rPiVideo = `${COMMON}
TASK: Distill the Pi architecture from the creator's deep-dive talk.
Read fully: ${R}/_sources/transcripts/gTeujlv8qK0.txt (Pi architecture deep dive: "agent core" loop + "Pi interactive" TUI, RPC/SDK).
Capture the stated architecture, the agent-core/loop design, why it's minimal, the SDK/RPC boundary, and design principles the author emphasizes.
Return: the architecture in primitives + direct quotes (with the claim) that matter for a Kuralle gap analysis.`

// Harness-engineering readers
const rHEWeb = `${COMMON}
TASK: Distill the harness-engineering DISCIPLINE from primary sources.
Read fully: ${R}/_sources/web/openai-harness-engineering.md and ${R}/_sources/web/mindstudio-harness-engineering.md.
Capture: the definition (harness = everything around the model), the component taxonomy (prompts/context/memory/tools/routing/parsing/error-handling), "give the agent a map not a manual" / progressive disclosure, repo-as-system-of-record, agent legibility, enforce-invariants-not-implementations, feedback loops, golden-principles/GC.
Return: a crisp component checklist + the principles, each tied to its source.`

const rHEVideos = `${COMMON}
TASK: Distill harness-engineering lessons from talks.
Read fully these transcripts in ${R}/_sources/transcripts/: KijChx7q2nY.txt (engineering coding harnesses), sFHXYv7ANkc.txt (AI agent harness; Opus model feel), K4-flzsPraE.txt (Omni/Blobby data-analyst harness: error-recovery budget, "consolidate the brain"/avoid split-brain subagents, SQL-parse interface, traces/evals), d33CK8uuji0.txt (using AI right), 7fbY8k9Mz3M.txt (context engineering), Khfiy1lwGPs.txt (build an agent from scratch), hcm5zIWASCM.txt (docs as agent context).
Capture concrete, reusable harness lessons (not hype). Especially: error-recovery loops, single vs multi-agent ("consolidate the brain"), tool-interface design, context/compaction, evals/traces.
Return: lessons list, each with the video id + the specific claim.`

// ---------- SYNTH BRIEFS ----------
function synth(path, goal, findings, kuralleReads, structure) {
  return `${COMMON}
You are writing a GROUNDED research+plan document. Read ${R}/deploy-primitives-plan.md briefly to match the existing house style (concrete, file-cited, "minimal grounded changes").

GOAL: ${goal}

You have these reader findings from teammates (already grounded with citations):
=== READER FINDINGS START ===
${findings}
=== READER FINDINGS END ===

Before writing, READ these kuralle-core files to ground the integration points: ${kuralleReads}

Then WRITE the document to EXACTLY this path using the Write tool: ${path}

Document requirements:
- Open with a 1-paragraph thesis + a "TL;DR proposed changes" bullet list.
- ${structure}
- A "Deconstruction to primitives" section: the minimal interfaces, with a comparison table across the studied systems.
- A "Proposed Kuralle design" section: concrete — name the new package/files, the exact AgentConfig field(s) to add, defineTool() usage, and Node-vs-Cloudflare portability strategy. MINIMAL and grounded; no speculative abstraction. Prefer copying a proven design (say which) over inventing.
- A "Use case walkthrough" section: a customer-support agent with a local knowledge base (and, where relevant, Skills/Scripts) — show the developer-facing API.
- "Open questions" + "Risks / non-goals".
- Cite file:line for every external claim. Keep it tight; quality over length.

After writing, RETURN the structured object (path, summary, proposed_kuralle_changes, open_questions, citation_count).`
}

// ---------- TASKS ----------
async function taskFS() {
  phase('Read')
  const f = (await parallel([
    () => agent(rFlueFS, { label: 'read:flue-fs', phase: 'Read', agentType: AT }),
    () => agent(rHareFS, { label: 'read:hare-fs', phase: 'Read', agentType: AT }),
    () => agent(rCfFS, { label: 'read:cf-fs', phase: 'Read', agentType: AT }),
    () => agent(rMastraFS, { label: 'read:mastra-fs', phase: 'Read', agentType: AT }),
    () => agent(rMintlify, { label: 'read:mintlify-fs', phase: 'Read', agentType: AT }),
  ])).filter(Boolean).join('\n\n========\n\n')
  return await agent(
    synth(
      `${R}/filesystem-primitives-plan.md`,
      'Design a portable virtual filesystem (VFS) primitive for kuralle-core, learning from Flue (just-bash), cloudflare-agents shell/fs, Mastra workspace/filesystem, and Mintlify ChromaFs; contrast with Hare (CF-primitives-as-tools). The VFS must run on both Node and Cloudflare Workers and enable a customer-support agent to explore a local knowledge base via ls/cat/grep/find.',
      f,
      'packages/kuralle-core/src/tools/effect/defineTool.ts, packages/kuralle-core/src/types/agentConfig.ts, and `ls packages/kuralle-core/src/runtime/channels` + `ls packages/` (note @kuralle-agents/rag, cf-agent, hono-server, *-store).',
      'A per-system breakdown (Flue / Hare / cloudflare-agents / Mastra / ChromaFs) — what each does, file-cited.',
    ),
    { label: 'synth:filesystem-primitives-plan', phase: 'Synthesize', agentType: AT, schema: SYNTH_SCHEMA },
  )
}

async function taskSkills() {
  const f = (await parallel([
    () => agent(rFlueSkills, { label: 'read:flue-skills', phase: 'Read', agentType: AT }),
    () => agent(rPiSkills, { label: 'read:pi-skills', phase: 'Read', agentType: AT }),
    () => agent(rSkillsTranscripts, { label: 'read:skills-transcripts', phase: 'Read', agentType: AT }),
  ])).filter(Boolean).join('\n\n========\n\n')
  return await agent(
    synth(
      `${R}/skills-and-scripts-plan.md`,
      'Design Skills + Scripts for kuralle-core (conversational agents), modeled on the Anthropic Agent Skills standard (SKILL.md folder + progressive disclosure + bundled scripts) as implemented by Flue, Pi, Claude Code/OpenClaw/Hermes. Skills/Scripts ride on the VFS from filesystem-primitives-plan.md (reference it). The motivating use case: a support agent that loads a "returns-policy" skill and runs a "lookup-order" script.',
      f,
      'packages/kuralle-core/src/types/agentConfig.ts, packages/kuralle-core/src/tools/effect/defineTool.ts, and `ls packages/kuralle-core/src/prompts` + `ls packages/kuralle-core/src/capabilities`.',
      'A "what is a Skill / what is a Script" definition section grounded in the sources, then the SKILL.md schema comparison (Flue vs Pi vs Anthropic canonical).',
    ),
    { label: 'synth:skills-and-scripts-plan', phase: 'Synthesize', agentType: AT, schema: SYNTH_SCHEMA },
  )
}

async function taskPi() {
  const f = (await parallel([
    () => agent(rPiAgentLoop, { label: 'read:pi-agent-loop', phase: 'Read', agentType: AT }),
    () => agent(rPiCodingAgent, { label: 'read:pi-coding-agent', phase: 'Read', agentType: AT }),
    () => agent(rPiVideo, { label: 'read:pi-video', phase: 'Read', agentType: AT }),
  ])).filter(Boolean).join('\n\n========\n\n')
  return await agent(
    synth(
      `${R}/pi-coding-agent-primitives.md`,
      'Extract the agentic-harness primitives from Pi (packages/agent = reusable loop; packages/coding-agent = app) and map which ones kuralle-core should adopt to become a general agentic CONVERSATIONAL harness. Identify primitives kuralle-core is MISSING (e.g. bash/exec, fs/env injection, compaction strategy, jsonl session log, extensions/SDK, event-bus).',
      f,
      'packages/kuralle-core/src/runtime/openRun.ts, Runtime.ts, `ls packages/kuralle-core/src/runtime/channels`, `ls packages/kuralle-core/src/tools` + tools/effect, `ls packages/kuralle-core/src/session`, `ls packages/kuralle-core/src/processors` + hooks.',
      'A "Pi primitive map" (agent layer vs coding-agent layer, file-cited) then "reusable vs coding-specific" classification.',
    ),
    { label: 'synth:pi-coding-agent-primitives', phase: 'Synthesize', agentType: AT, schema: SYNTH_SCHEMA },
  )
}

async function taskHarness() {
  const f = (await parallel([
    () => agent(rHEWeb, { label: 'read:harness-web', phase: 'Read', agentType: AT }),
    () => agent(rHEVideos, { label: 'read:harness-videos', phase: 'Read', agentType: AT }),
  ])).filter(Boolean).join('\n\n========\n\n')
  return await agent(
    synth(
      `${R}/harness-engineering-plan.md`,
      'Define "harness engineering" for a conversational agent FRAMEWORK and argue the thesis: kuralle-core should be the reusable agent loop / conversational harness that products (like Claude Code/OpenClaw/Hermes on Pi) build on. Map the harness-engineering component taxonomy onto kuralle-core existing layers (prompts, flows=routing, tools/effectTools, sessions/memory, hooks/processors, capabilities/validation, grounding) and produce a prioritized list of MISSING harness primitives.',
      f,
      '`ls packages/kuralle-core/src` (every subdir), packages/kuralle-core/src/types/agentConfig.ts, and skim packages/kuralle-core/src/runtime/Runtime.ts.',
      'A "harness component taxonomy → kuralle-core layer" mapping table (component | source | kuralle has it? | file).',
    ),
    { label: 'synth:harness-engineering-plan', phase: 'Synthesize', agentType: AT, schema: SYNTH_SCHEMA },
  )
}

async function taskGap() {
  // reuse pi readers' depth via a fresh focused reader pair
  const f = (await parallel([
    () => agent(rPiAgentLoop, { label: 'read:pi-loop(gap)', phase: 'Read', agentType: AT }),
    () => agent(rPiVideo, { label: 'read:pi-video(gap)', phase: 'Read', agentType: AT }),
    () => agent(`${COMMON}
TASK: Inventory kuralle-core's CURRENT harness capabilities for a Pi gap comparison.
Read/skim in ${ROOT}/packages/kuralle-core/src: runtime/{Runtime.ts,openRun.ts,closeRun.ts}, `+"`ls runtime/channels`"+`, tools/{Tool.ts,effect/defineTool.ts,effect/ToolExecutor.ts}, types/{agentConfig.ts,session.ts}, `+"`ls session`, `ls memory`, `ls processors`, `ls hooks`, `ls capabilities`, `ls flows`"+`.
Capture what EXISTS today: loop, tool exec, sessions/stores, memory, compaction(?), streaming, hooks. Be honest about what is absent (bash/exec, fs, skills, env injection, jsonl trace log, SDK/extensions).
Return: a capability inventory with file:line for what exists and an explicit "ABSENT" list.`, { label: 'read:kuralle-inventory', phase: 'Read', agentType: AT }),
  ])).filter(Boolean).join('\n\n========\n\n')
  return await agent(
    synth(
      `${R}/kuralle-vs-pi-gap.md`,
      'Produce a primitive-level gap analysis: "how far is kuralle-core from being a Pi-class agentic harness?" Side-by-side table (primitive | Pi | kuralle today | gap | effort) and a prioritized roadmap. Be honest and specific; this drives planning.',
      f,
      'rely on the kuralle-inventory reader finding above; spot-check packages/kuralle-core/src/runtime/Runtime.ts and types/agentConfig.ts directly.',
      'A side-by-side gap TABLE (primitive | Pi mechanism+file | kuralle status+file | gap | rough effort) as the centerpiece, then a phased roadmap.',
    ),
    { label: 'synth:kuralle-vs-pi-gap', phase: 'Synthesize', agentType: AT, schema: SYNTH_SCHEMA },
  )
}

log('Launching 5 grounded research pipelines (FS, Skills/Scripts, Pi-primitives, Harness-eng, Kuralle-vs-Pi gap)')
const results = await parallel([taskFS, taskSkills, taskPi, taskHarness, taskGap])
const ok = results.filter(Boolean)
log(`Done: ${ok.length}/5 plans written`)
return { written: ok.map(r => ({ path: r.path, summary: r.summary, changes: r.proposed_kuralle_changes, citations: r.citation_count })) }
