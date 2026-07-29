# Production agent case study: release governance

## Decision

Build a release-governance operator as Kuralle's flagship production example. It works against a real Git checkout, treats repository evidence as authoritative, runs deterministic quality gates, and creates only a reviewable GitHub draft after approval.

The key product decision is narrower than “an agent that ships software.” The agent prepares a release candidate; the operator retains tag creation and final publication. That division makes the example useful in a real workflow while keeping irreversible authority outside the model.

## What production agent teams are publishing

| First-party source | Reported pattern | Design implication for Kuralle |
| --- | --- | --- |
| [Mastra — Product Agents We Built](https://mastra.ai/blog/product-agents-we-built-at-mastra) | Its “Corey” agent turns version requests into draft GitHub releases and release notes. | Release preparation is a credible, bounded software workflow—not an invented demo task. |
| [OpenAI — Presence](https://openai.com/index/introducing-openai-presence/) | Production agents need a defined job, access to the right knowledge and systems, policies, approved actions, evaluation, guardrails, and escalation. | Make authority, evidence, approvals, and stop conditions visible in the implementation. |
| [OpenAI and PwC finance collaboration](https://openai.com/index/openai-pwc-finance-collaboration/) | Real workflows combine domain context, enterprise systems, governance, and human oversight. | Treat the human review step as part of the workflow rather than an optional UI flourish. |
| [LangChain customer stories](https://www.langchain.com/customers) | Deployed agents cluster around support, incident response, operations, and internal knowledge workflows. | Prefer an operational task with measurable outcomes and real systems of record. |
| [Anthropic and Tines](https://www.anthropic.com/customers/tines) | Security automation benefits from reasoning combined with constrained execution in an existing platform. | Keep the model out of a general-purpose shell and expose narrow, typed effects. |
| [CrewAI case studies](https://crewai.com/case-studies) | Published deployments emphasize repeatable business processes rather than open-ended assistants. | Demonstrate an owned workflow with durable artifacts and a clear completion state. |

These sources describe different products and should not be read as identical architectures. The common pattern inferred from them is that useful production agents operate inside explicit system, authority, and review boundaries.

## Candidate selection

Each candidate was scored from 1–5 on real-world usefulness, objective verification, constrained authority, local reproducibility, and how completely it exercises Kuralle's native primitives.

| Candidate | Useful | Verifiable | Bounded | Reproducible | Kuralle coverage | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Release governance | 5 | 5 | 5 | 4 | 5 | **24** |
| Accounts-payable exception operator | 5 | 5 | 4 | 3 | 5 | 22 |
| Incident triage operator | 5 | 4 | 4 | 3 | 5 | 21 |
| Support resolution operator | 5 | 3 | 4 | 4 | 3 | 19 |
| Voice-of-customer analyst | 4 | 3 | 5 | 4 | 2 | 18 |

Release governance wins because any developer can point it at a Git repository, the evidence is inspectable, the gates are deterministic, and the only external mutation can be limited to a draft release. Finance and incident response remain strong future examples once the repository has realistic service adapters and fixtures for those domains.

## First-principles contract

| Concern | Authoritative substrate | Agent authority | Failure behavior |
| --- | --- | --- | --- |
| Source and history | Configured Git checkout | Read only | Stop if dirty, detached, on the wrong branch, or the root does not match |
| Release gates | Ordered process argument arrays | Run only after approval | Stop on first failing check and persist the result against the exact `HEAD` |
| Draft artifact | Kuralle workspace `/output` | Write revisioned candidate files | Reject stale `HEAD`, missing checks, existing tags, or malformed versions |
| Repository context | Kuralle workspace `/repo` | Read only | Policy and filesystem wrapper both reject mutation |
| External release | Exact GitHub repository | Create a draft only after approval | Reuse only an exact draft; refuse any conflict or non-draft response |
| Final release | Git/GitHub operator | None | Human owns tagging and publication |

This is defense in depth, not duplicated ceremony. The filesystem prevents repository writes even if instructions fail; the policy explains and denies the action at the agent boundary; the service rechecks repository state at each effect boundary; GitHub publication validates the returned object.

The repository view also rejects credential-bearing paths and resolves symlinks before reads. Git itself remains the source of commit and cleanliness metadata, so hiding `.git` from the model does not weaken release evidence.

## Why it is not a demo

- It operates on a caller-selected, real repository instead of embedded sample data.
- Its default checks are the repository's actual typecheck, lint, and test commands.
- Every release claim must be grounded in commits, changesets, or source files visible under `/repo`.
- Check evidence and release candidates survive the model turn as durable files.
- A candidate is content-addressed and becomes stale when the underlying state changes.
- The external effect is real, idempotent, approval-gated, and deliberately reversible because it remains a draft.
- Tests exercise temporary Git repositories and the GitHub protocol boundary, not just prompt text.

## Rejected shortcuts

- No `exec` or general shell tool is exposed to the model.
- No prompt-only “do not edit” rule substitutes for an immutable filesystem mount.
- No mock release command is presented as production behavior.
- No broad token or environment dump enters the workspace.
- No tag, push, merge, generated GitHub notes, or final publication is hidden behind the draft tool.
- No second agent framework bypasses Kuralle's policy, workspace, approval, journal, or driver contracts.

## When to revisit the choice

Choose a different flagship case study if users need to evaluate multi-tenant identity, event-driven resumptions, or large retrieval corpora more than agent authority. The Postgres starter and pharmacy workspace agent already cover those substrates; the release operator is intentionally strongest at governance, evidence, and controlled effects.
