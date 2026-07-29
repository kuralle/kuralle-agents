# Production example ports: evidence and design record

Research and validation date: 2026-07-29.

## Reproducible upstream baseline

| Upstream | Commit | Licence | Used for |
| --- | --- | --- | --- |
| `livekit/agents` | `7946376824940ddc34aadc640733caccac345084` | Apache-2.0 | healthcare and hotel conversational requirements |
| `livekit-examples/supabase-hacker-starter` | `d20e97082f98a52a1a75221dac446dad86cdf4c3` | MIT | web starter product shape |
| `vercel-labs/eve-content-agent-template` | `dd42d0a6cf8e6a10371b2115e560a2e60edcaab7` | Apache-2.0 | content workflow, style skills, lint and review boundaries |
| `vercel/eve` | `6dc662ca8e6e81113d3c416eedc16533133fd189` | Apache-2.0 | filesystem-first authoring, sandbox, skill and durability analysis |
| `cloudflare/agents` | `6e77f62e368279a5bbd11ee2c4b2f489693d0401` | MIT | durable workspace, skills, ownership and agent-substrate comparison |

The clones used during implementation lived outside the repository under `/tmp/kuralle-example-upstreams.FRhAoQ`. Code was re-authored against the observed contracts; shipped examples do not vendor those repositories.

## First-principles conclusions

### One application is not one substrate

The right persistence unit follows the invariant, not the UI:

- a conversation needs ordered durable session state and replay-safe effects;
- operational records need transactional tables and domain constraints;
- semantic memory needs scoped retrieval plus authoritative exact lookup;
- mutable prose needs human-readable files, optimistic revisions, and approval;
- optional procedures need progressive disclosure, not permanent prompt weight.

That led to SQLite for the two operational TUI apps, PostgreSQL for the multi-user retrieval web app, and real local Markdown for the content app. Kuralle’s driver remains an inner model/tool loop; Kuralle’s runtime, session, journal, approval, policy, and flow machinery stay authoritative.

### What transferred from Eve

Useful patterns:

- keep stable identity and safety rules always on;
- keep surface-specific procedures in load-on-demand `SKILL.md` packages;
- treat skill loading as context, not a new execution capability;
- put typed integrations on tools and gate irreversible effects;
- derive principal or target paths from trusted context rather than model input;
- bound lint input and escape literal regex terms;
- isolate qualitative review from deterministic lint.

Deliberate divergence:

- the content example has no remote communication, source, publishing, or blob service;
- local source retrieval replaces an open-web researcher because the requested runtime must be self-contained and every claim must map to local evidence;
- human review of an exact SHA-256 revision replaces an implicit “ship it” interpretation;
- malformed lint data fails closed instead of returning a clean result;
- a separate sandbox is unnecessary because the agent cannot execute code and its generic workspace is read-only.

### What transferred from Cloudflare

Useful patterns:

- one owner for each durable workspace;
- path normalisation and symlink confinement are security boundaries;
- storage and execution are separate interfaces;
- skills are catalogued first and activated on demand;
- code/script execution requires an explicit capability envelope;
- workspace mutation should be observable and conflict-aware.

Deliberate divergence:

- Kuralle keeps its frozen 19-method filesystem rather than adopting a 45-method state/code-execution backend;
- the Node content workspace uses ordinary files because interoperability with editors, Git, and backups is the requirement;
- no skill scripts run; skills supply instructions and references only;
- narrow domain tools own writes instead of giving the model a general read-write workspace.

### Kuralle primitive changes supported by evidence

1. `NodeFileSystem` supplies the missing local-directory adapter without expanding the `FileSystem` contract. It maps virtual POSIX paths to one real root and rejects traversal and symlink escape.
2. `fsSkillStore` now throws on malformed discovered skills. Behavioural content must not disappear behind a warning.
3. The store reuses one validated discovery snapshot across catalog and body loads, avoiding repeated full-tree reads during runtime wiring.

Stale-write detection remains application-specific. The generic filesystem stays small; the content tools require SHA-256 revisions only where a human is approving mutable prose.

## Current primary documentation checked

- [Agent Skills specification](https://agentskills.io/specification): required `SKILL.md` frontmatter, naming constraints, resources, and the three progressive-disclosure levels.
- [Cloudflare Agents documentation](https://developers.cloudflare.com/agents/): current separation between communication channels, harness, durable runtime, and tools.
- [Cloudflare human-in-the-loop patterns](https://developers.cloudflare.com/agents/concepts/agentic-patterns/human-in-the-loop/): consequential operations pause for a human decision.
- [Cloudflare enterprise agent workspace architecture](https://developers.cloudflare.com/reference-architecture/diagrams/ai/enterprise-ai-agent-workspace/): a durable workspace coordinates state and selects separate execution and file services by workload.
- [Eve skills documentation](https://github.com/vercel/eve/blob/main/docs/skills.mdx), [execution model](https://github.com/vercel/eve/blob/main/docs/concepts/execution-model-and-durability.mdx), and [security model](https://github.com/vercel/eve/blob/main/docs/concepts/security-model.md): context loading, durable checkpoints, and runtime/sandbox trust boundaries.
- [AI SDK Elements prompt input](https://elements.ai-sdk.dev/components/prompt-input), [Hono on Next.js](https://hono.dev/docs/getting-started/nextjs), and [Next.js route handlers](https://nextjs.org/docs/app/getting-started/route-handlers): current web integration contracts used by the Postgres example.

## Live API evidence

The deterministic suites were supplemented with real provider runs:

- healthcare: Pi and default-driver authentication/policy turns; Pi approval resume with SQLite verification;
- hotel: Pi policy/booking turns, default-driver refusal/emergency turn, Pi approval resume with SQLite verification;
- Postgres web: Pi retrieval stream, Pi approved memory write with database verification, default-driver exact order tool result, persisted sessions/traces/reports;
- content: Pi loaded a style skill, preferences, and source through three separate tools; Pi created a draft after approval and the file was inspected; the default driver fetched its exact revision, paused publication, resumed after approval, and the published file was inspected.

The content live run also found an API defect: a single optional revision field let the model reuse the preferences hash for a new draft. The production API was split into `create_draft` (revision impossible) and `update_draft` (revision mandatory), then the entire approval path was rerun successfully.
