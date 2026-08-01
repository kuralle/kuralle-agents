# Prior art

All load-bearing open-source claims below were verified from source at the commits listed in
[`sources.md`](sources.md). Hosted platform behavior comes from official documentation.

## File-agent frameworks

| System | Authoring boundary | Build/runtime boundary | Take for Kuralle |
|---|---|---|---|
| MWP / ICM | Layered folders, routing `CONTEXT.md`, stage contracts, references, skills, editable outputs | No compiler or multi-user runtime; a coding agent interprets conventions | Adopt explicit context dependencies and stable-reference/per-run separation. Do not adopt files as shared production state. |
| Eve | `agent/` with instructions, tools, skills, connections, hooks, channels, schedules, subagents, sandbox seed | Versioned discovery manifest, compiled manifest, module map, diagnostics, source-graph hashes, runtime validation | Best direct precedent for source → IR → runtime and diagnostics-as-data. |
| Flue 2 | Code-first `'use agent'` exports; imported skills and root agent instructions | AST scanning and Vite-generated Node/CF registries; durable state separate from filesystem | Adopt static capability packaging and collision checks. Current source differs materially from the article's older API. |
| Mastra | `src/mastra/agents/<id>` with config, instructions, tools, skills, memory, workspace, processors, scorers, subagents | CLI codegen inlines prose/imports modules before normal bundling | Adopt broad discovery hardening and version storage; reject silent code-wins precedence and shared mutable workspaces. |
| Agent Skills | `SKILL.md` with optional references/assets/scripts | metadata first, body/resources on demand | Keep progressive disclosure; hash the complete package and enforce authority outside prose. |
| Pydantic AI AgentSpec | strict YAML/JSON declarative specification | validates into a bounded runtime capability model | Evidence for one strict serializable schema shared by files and databases. |

### MWP/ICM boundary

The thesis's useful five layers are root identity, workspace routing, stage contract, stable
references, and per-run artifacts. Its `Inputs / Process / Outputs` contract makes context selection
auditable and gives Kuralle a concrete dependency graph to compile.

The paper also names its own boundary: real-time collaboration and high concurrency need proper
queueing, state isolation, and deployment infrastructure; complex automatic branching becomes a
framework. It reports informal practitioner evidence on one model family and no controlled
comparison. The pattern is valuable, but it is not evidence that a filesystem replaces a SaaS
runtime.

### Eve details to adopt

- discovery does not initially import authored modules;
- diagnostics accumulate and gate compilation rather than failing at the first typo;
- symlinks and unknown/ambiguous slots are handled explicitly;
- authored paths become stable source references;
- compilation emits a schema-versioned manifest, static module map, metadata, and hashes;
- runtime validates artifact/schema compatibility;
- subagents are self-contained rather than inheriting hidden parent state;
- only declared workspace seed files are materialized—the source tree is not the runtime workspace.

### Mastra details to adopt and avoid

Mastra's current `StorageAgentType` is a mutable identity/governance record with `status`,
`activeVersionId`, `authorId`, and `visibility`. `AgentVersion` contains the serializable snapshot;
tools and integrations are references resolved against deployed capabilities. This is the best
database precedent in the inspected frameworks.

Avoid three behaviors: code silently winning file conflicts, incomplete skill-package resource
loading, and default per-agent mutable workspace directories that can be shared across users.
Mastra's file-routing code is Apache-2.0, while `ee/` has a production-restricted license.

## Hosted agent builders and deployers

| Platform | Version/config model | Custom tools | Production lesson |
|---|---|---|---|
| Vapi | API definitions; recommends Git/CI and separate dev/UAT/prod because built-in versioning is absent | webhook, hosted TS, integrations, built-ins | Environment promotion cannot be an afterthought; hosted code is platform-specific. |
| ElevenLabs Agents | immutable versions, branches, drafts, deterministic weighted deployment; conversation sticks to branch/environment | client, HTTP webhook, MCP, system tools | Best release semantics and trace attribution precedent. |
| Retell | editable draft; immutable published V0+; staging/prod tags redirect new calls | HTTP functions and hosted JS | Tags/releases affect new traffic; hosted JS is explicitly not appropriate for sensitive production backends. |
| LiveKit Agents | source/container revisions and rolling session drain | fully custom source code | Strong code-deployment model, job isolation, logs/traces; not a database-definition model. |
| Pipecat Cloud | Docker image and deployment manifest; warm pool/scale-to-zero | fully custom source code | Session instance isolation and cold-start tradeoff; weak deterministic version pinning. |
| LangGraph / LangSmith | source graph and deployment revisions | arbitrary source code | Durable thread/checkpoint model is useful; resumed threads using the latest graph is the counterexample Kuralle rejects. |
| Google ADK | code-first container/Agent Engine deployment | functions, OpenAPI, MCP | Portable code/runtime with platform-specific deploy revisions; no unified stored-agent artifact. |
| Cloudflare Agents | source-deployed class, many named durable instances | source code, MCP, platform tools | One generic thread class can host database-created definitions; Worker and DO schema rollbacks are separate concerns. |

## Cross-platform synthesis

The market converges on two distinct products that are often described with one word:

1. **Agent configuration publishing** — immutable snapshots, branches, traffic, new-conversation
   activation, HTTP/MCP/catalog tools.
2. **Agent program deployment** — container/Worker code, custom implementations, migrations,
   rolling drain and rollback.

Kuralle needs both and must join them explicitly. An `Agent Release` therefore pins two axes:
`agentRevision` (serialized behavior/resources) and `runtimeRevision` (deployed executable
capabilities). A compatibility check joins them before traffic is assigned.

