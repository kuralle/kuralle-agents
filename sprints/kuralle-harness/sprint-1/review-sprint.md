# Sprint 1 review + proceed — Phase 0: Tool model cleanup (RFC-01)

**IC:** cursor · **Range:** `39d662c..32c0ab5` (7 IC commits `kh-S1-C1..C7` + 1 manager fix `kh-S1-fix`) · **Decision: PROCEED → Sprint 2.**

## Gate 01 results (manager-run, observed — not the IC's word)
| Check | Command | Result |
|-------|---------|--------|
| proof gate | `verify-handoff-proof.sh kh-sprint1` | PROOF_OK (7 claims, 13 assertions) |
| typecheck | `bun run typecheck:all` | ✓ green (+ playground green) |
| tests | `bun run test` | 0 fail across all packages |
| new tests | `wrap-ai-sdk-tool`, `agentreply-journaled`, `journal-key-workers` (vitest-pool-workers) | green |
| guard | `bash scripts/check-no-raw-tool-execute.sh` | ✓ exit 0 |
| rename completeness | `grep -rn effectTools packages apps` | 0 leftovers |
| live smoke | `KURALLE_EXAMPLE_PROVIDER=openai bun .../examples/agents/echo.ts` | OBSERVED: `echo` + `end_call` tools executed through the renamed durable path against live gpt-4o-mini |

## Layer 1 — What works
- `agentReply.ts` now journals host-reply tools: `tools: agent.tools ? buildToolSet(agent.tools) : undefined` (schema-only; executors registered via Runtime) — exactly RFC-01 §4.3.
- `wrapAiSdkTool.ts` matches the blueprint (throws on schema-only AI SDK tool; routes `execute` through the executor). Exported from `tools/effect/index.ts` + core `index.ts:252`.
- `agentConfig.ts`: `tools?: Record<string,AnyTool>` (27) + `globalTools?` (33); raw `tools?: ToolSet` removed. No `effectTools` alias.
- Workers journal-key parity test added (REQ-6) and green — `node:crypto` covered on the Workers path (no fallback needed; nodejs_compat sufficed).

## Layer 2 — Blockers
- None blocking. One defect found and fixed by manager: the C5 codemod produced `tools?, tools?` / `tools, tools` duplicates in two doc signature lists (`CLAUDE.md:40`, `docs/skills/kuralle-usage/SKILL.md:21`) — fixed in `kh-S1-fix` (second field restored to `globalTools`).

## Pre-existing issues surfaced (NOT in scope; logged for follow-up)
- `examples/_shared/v2Runner.ts` hardcodes stale model ids (`gemini-2.0-flash` → 404; `grok-2-1212`). The default-provider live smoke 404s on Google; works when forced to OpenAI. Out of RFC-01 scope — candidate for a tiny "bump example model ids" follow-up. Did NOT block Gate 01 (the tool path is observed working on OpenAI).

## Verdict
Solid — shipping. Gate 01 GREEN. Advance STATE to Sprint 2.
