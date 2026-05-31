---
name: kuralle-prompt-writing
description: Write high-quality prompts for Kuralle agents (LLM, Flow, and Triage). Use when creating or reviewing prompts to improve correctness, routing quality, tool behavior, and production robustness.
---

# Kuralle Prompt Writing

Use this skill when prompts are the bottleneck: hallucinations, weak tool usage, routing leaks, repeated questions, or inconsistent flow behavior.

## Read this first

- Aria is runtime-first: prompts should not carry state machine logic.
- SOP belongs in flows; prompts should describe role and current task.
- Triage prompts must route, not chat.
- Tool behavior should be contract-first (schemas + deterministic outputs).

## Navigation

- `references/project-prompt-patterns.md` - Aria-specific prompt architecture, patterns, **voice prompt rules**, AgentPrompt vs plain strings
- `references/templates.md` - copy/paste templates (LLM, Flow node, Triage, Voice, AgentPrompt)
- `references/review-checklist.md` - prompt review checklist before merge
- `references/case-study-medical-office.md` - form-filler prompt critique + improved version

**Cross-skill references:**
- `docs/skills/kuralle-usage/references/agent-prompt.md` - Full AgentPrompt API (security profiles, token budgeting, `.voiceRules()`)
- `docs/skills/kuralle-voice-agents/rules/voice-prompt-rules.md` - Voice-specific prompt rules
- `docs/skills/kuralle-flow-agents/references/prompt-best-practices.md` - Why plain strings beat PromptBuilder for tool-heavy nodes

Rules:

- `rules/prompt-quality-gates.md`

## Workflow

1. Choose agent mode:
   - `llm` for freeform help with tools
   - `flow` for SOP/multi-step collection
   - `triage` for routing only
2. Draft prompt using the matching template.
3. Add explicit uncertainty/tool constraints.
4. Run conversation scenarios and inspect transcripts.
5. Run `kuralle prompt lint --strict` and fix violations.
6. Fix prompt issues before touching model/provider.

## Non-negotiables

- Do not encode flow steps in one giant system prompt.
- Do not let triage produce user-facing text.
- Do not instruct tools to “talk to the user”.
- Prefer concrete constraints over vague style instructions.
