# Primary sources and provenance

## Inspected repositories

| Project | Commit inspected | License verdict | Load-bearing paths |
|---|---|---|---|
| [Vercel Eve](https://github.com/vercel/eve) | `6ad578ae68e14deec707a65e4a9b6414ed57617b` | Apache-2.0 | `packages/eve/src/discover/`, `compiler/`, `runtime/compiled-artifacts-source.ts`, `docs/reference/project-layout.md` |
| [Flue](https://github.com/withastro/flue) | `5485efe2fc6e84fb2c1c0f98e5ccb8068f9394b6` | Apache-2.0 | `packages/vite/src/agent-scan.ts`, generated Node/CF entries, runtime coordinators and stores |
| [Mastra](https://github.com/mastra-ai/mastra) | `cc85af24250f406f43fa8ef736f1bee6855dc57a` | Apache-2.0 outside `ee/`; `ee/` production-restricted | `packages/deployer/src/build/fs-routing/`, `packages/core/src/storage/types.ts`, `storage/domains/agents/`, `packages/editor/src/namespaces/agent.ts` |
| [Model Workspace Protocol / ICM](https://github.com/RinDig/Model-Workspace-Protocol-MWP-) | `02ba5d85c7871b75c7c702a2d8da6524723d53d4` | MIT | workspace `CONTEXT.md` contracts, builder stages and audit templates |
| [Agent Skills](https://agentskills.io/specification) | `38a2ff82958afee88dadf4831509e6f7e9d8ef4e` | code Apache-2.0; docs CC-BY-4.0 | specification and examples |
| [Pydantic AI](https://ai.pydantic.dev/agent/#agent-specification) | `86405bb7d715a11842aab75c2516f5a3b376b9d7` | MIT | AgentSpec schema and validation |

The clones were used only for inspection and were kept under temporary directories, outside this
repository. No source was copied into Kuralle.

## Papers and supplied media

- [Interpretable Context Methodology: Folder Structure as Agent Architecture](https://arxiv.org/html/2603.16021v1), arXiv:2603.16021v1, CC BY 4.0.
- [File-Based AI Agents: How Flue, Vercel Eve & Mastra Let You Build an Agent from a Folder](https://www.thetoolnerd.com/p/file-based-ai-agents-how-flue-vercel-mastra-building-it). Useful orientation; version/date claims were checked against current source.
- [Claude Code Creator's Greatest Tip For Using AI Agents](https://www.youtube.com/watch?v=pGro_uKt-_M). Secondhand advice: minimize always-on context, split on-demand skills, use falsifiable evals. Its claim that model behavior neutralizes skill injection is rejected as a security boundary.
- [Your AI agent is just a folder now](https://www.youtube.com/watch?v=qV2YluZkar0). Eve orientation; beta-era details yield to current source.
- [Stop Building AI Agents. Use This Folder System Instead](https://www.youtube.com/watch?v=MkN-ss2Nl10). MWP-style routing and editable stages; does not address multi-user runtime isolation.

## Hosted-platform documentation

- [ElevenLabs agent versioning](https://elevenlabs.io/docs/eleven-agents/operate/versioning)
- [ElevenLabs tools](https://elevenlabs.io/docs/eleven-agents/customization/tools)
- [ElevenLabs knowledge base](https://elevenlabs.io/docs/eleven-agents/customization/knowledge-base)
- [Retell agent versioning](https://docs.retellai.com/agent/version)
- [Vapi environment/versioning guidance](https://docs.vapi.ai/documentation/best-practices/enterprise-environments-dev-uat-prod)
- [LiveKit deployment revisions](https://docs.livekit.io/deploy/agents/managing-deployments/)
- [Pipecat Cloud deployment](https://docs.pipecat.ai/pipecat-cloud/fundamentals/deploy)
- [LangGraph backwards compatibility](https://docs.langchain.com/oss/python/langgraph/backward-compatibility)
- [Google agents CLI deployment](https://google.github.io/agents-cli/guide/deployment/)
- [Cloudflare Agents state](https://developers.cloudflare.com/agents/runtime/lifecycle/state/)
- [Cloudflare Agents observability](https://developers.cloudflare.com/agents/runtime/operations/observability/)
- [Cloudflare gradual deployments](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/)
- [Cloudflare rollback limitations](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)

