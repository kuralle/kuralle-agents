# Research handoff notes — FS / Skills-Scripts / Harness

## What this was
Grounded study (not implementation) of how Flue, Hare, cloudflare-agents, Mastra, Pi, and Mintlify build filesystem / Skills-Scripts / agent-loop primitives, to decide what to add to kuralle-core so it can be the reusable agentic conversational harness. Output = 6 markdown docs in `research/` (5 plans + 1 synthesis) + raw sources under `research/_sources/`.

## How sources were gathered (reproducible)
- Repos: shallow-cloned to `research/{cloudflare-agents-sdk,mastra,pi}` (flue/hare were already present). All gitignored.
- Transcripts: local `yt-dlp` + `youtube-transcript-api` (Whisper `base` fallback for the one caption-less video, `K4-flzsPraE`). Script in the skill `~/.claude/skills/youtube-researcher`. → `research/_sources/transcripts/`.
- Web: firecrawl (mintlify, mindstudio) + jina reader (openai, which blocks normal fetch). → `research/_sources/web/`.
- Workflow script: `research/_sources/fs-harness-research.workflow.js` (re-runnable via `Workflow({scriptPath})`).

## Gotchas hit (so the next run is faster)
- **zsh does not word-split unquoted `$var`** — `for id in $ids` iterated once over the whole string. Use a zsh array `ids=(...)`. Cost two failed transcript passes.
- **Whisper writes a `Detected language: …` line + progress to stdout**, polluting JSON capture. Repaired by slicing from the first `{`. The youtube-researcher script should redirect Whisper noise to stderr.
- The youtube transcript JSON field is **`content`**, not `text`.

## Key decisions / reconciliation (mine, on top of the agents' output)
1. **`FileSystem` now, `Shell` later.** Two pipelines proposed `@kuralle-agents/workspace` with Pi's `ExecutionEnv = FileSystem & Shell`; one proposed `@kuralle-agents/fs` (no shell). For a *conversational* framework targeting Node **and** Workers, real shell is non-portable and conflicts with Kuralle's "tools return data only / SOP in flows" rules. Decision: ship the portable `FileSystem` + `@kuralle-agents/fs`; keep `Shell` an optional Node-only capability that composes onto the same interface later. `grep/cat/ls/find` (just-bash-style) over the VFS covers the KB use case without a shell.
2. **Field name `workspace`, package `@kuralle-agents/fs`.** All plans converged on `AgentConfig.workspace?` as the field; package naming was inconsistent — picked `fs` (the primitive) over `workspace` (which becomes the field).
3. **Skills via the existing `Capability` pattern.** Strong agreement: copy `AutoRetrieveCapability`'s on-demand-tool trick for `load_skill`. "Scripts" = allow-listed `defineTool`/flows, not bash.
4. **Reconcile with the orphaned memory primitive, don't duplicate.** `FilePersistentMemoryStore` + `buildMemoryBlockTool` already exist and are exported but unwired (verified zero `runtime/` refs). The workspace/fs work must absorb this, not add a parallel store.
5. **Single-loop, not multi-agent.** Both the OpenAI article and the Omni/Blobby talk independently warn against sub-agent "split brain"; Kuralle's flow design already matches the recommended shape.

## Known doc inaccuracies to fix at implementation time
- `skills-and-scripts-plan.md` references `getSections()`; the real `Capability` method is `getPromptSections()` (`packages/kuralle-core/src/capabilities/index.ts:92`). Mechanism is correct.
- Cited line numbers drift by ≤~10 in a few places (files evolve); every cited *construct* was verified to exist with the claimed semantics. Re-grep before editing.

## Status
Research complete and verified. No code changed in `packages/`. Next step (separate task, when prioritized): implement sequence step 1 (`@kuralle-agents/fs`) per `fs-skills-harness-synthesis.md`. These are plans, not RFCs — promote the chosen one through `/rfc-writer` before building.
