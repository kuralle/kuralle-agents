# Kuralle guides

These guides are generated from the documentation site and match the version of
`@kuralle-agents/core` you installed. The same pages are published at
<https://agents.kuralle.com>, where they always describe the latest release.

Read in this order for a full picture; jump straight to a page to solve one task.

1. [Quickstart](./quickstart.md) — Build your first Kuralle agent in minutes.
2. [Build an Agent (from idea to production)](./build-an-agent.md) — A conversational walkthrough — start with an idea, grow it into a real Kuralle agent, then deploy it to Node, Cloudflare, or Vercel.
3. [Agents](./agents.md) — Define agents with instructions, tools, flows, and routing.
4. [Tools](./tools.md) — Define deterministic tools with Zod-typed inputs and durable execution.
5. [Flows](./flows.md) — Model multi-step procedures as typed node graphs.
6. [Flow Execution Model](./flow-execution.md) — How the flow engine dispatches nodes, normalizes transitions, reshapes context, and pauses for the next turn.
7. [Routing & Handoffs](./routing.md) — Route between agents and hand off conversations without leaking triage state.
8. [Tool Policy](./policy.md) — Decide whether each tool call runs, asks a human, or is refused — enforced at the gate, not in the prompt.
9. [Durable Execution](./durable-execution.md) — How Kuralle records effects and replays them for exactly-once tool execution and durable pause/resume.
10. [Sessions & State](./sessions.md) — Persist conversation history and per-agent state across restarts.
11. [Memory](./memory.md) — Give agents durable working memory that persists across sessions, plus semantic recall.
12. [Knowledge & Retrieval](./knowledge.md) — Ground agents in your content with hybrid retrieval — vector search, a BM25 keyword tier, incremental ingestion, and a filesystem view of the knowledge base.
13. [Skills](./skills.md) — Anthropic-style Agent Skills — SKILL.md knowledge an agent loads on demand via progressive disclosure.
14. [Workspace (Filesystem, Shell & Skills)](./workspace.md) — Give an agent a portable filesystem — read/write files, run a shell, load SKILL.md skills, consume Open Knowledge Format bundles, and persist it all across restarts on Node or Cloudflare.
15. [Dynamic Flows](./dynamic-flows.md) — Author, validate, and hot-register JSON FlowDefinitions on a live server — versioned, Policy-gated, and durable across parked runs.
16. [Agent Plugins](./plugins.md) — Load third-party Agent Plugins — plugin.json, skills/, optional mcp.json, and optional flows/ — with partial failure isolation.
17. [MCP](./mcp.md) — Connect Model Context Protocol servers from Agent Plugins — remote transports on Workers, stdio on Node, Policy-gated execution, and schema disclosure budgets.
18. [Multimodal Input](./multimodal.md) — Send images, documents, and voice notes — not just text — to a Kuralle agent, across web, messaging, and Cloudflare.
19. [Templates](./templates.md) — Start a new Kuralle project from a template with create-kuralle-agents.
20. [File-authored Agents](./file-authored-agents.md) — Compile an agent folder into an immutable deployment and chat with it through the Kuralle CLI.
21. [Agent Definitions in Your Database](./agent-definitions-database.md) — Own agent-definition schema and migrations in Postgres, Prisma, or Drizzle, and run the agents on Cloudflare.
22. [Build an Agent Builder in React](./agent-builder-react.md) — Build a multi-tenant agent builder UI on React — drafts, publishing, releases, live preview streaming, and deploying the result to Node or Cloudflare.
23. [Engagement & Messaging](./engagement.md) — Window-safe omnichannel bots with WhatsApp, Instagram, and web chat on one runtime.
24. [Observability](./observability.md) — Structured traces for every run — evals with runOnce, durable trace storage, OTLP/Langfuse export, and an embeddable trace viewer.
25. [Deployment](./deployment.md) — Deploy Kuralle agents to Hono/Node, Cloudflare Workers, or serverless platforms.
26. [CLI & Devtools](./cli.md) — Connect to hosted runtimes or run local chat, send, resume, simulation, and trace inspection against any Kuralle agent.
27. [Pi Driver](./pi-driver.md) — Use pi-agent-core as Kuralle's production model/tool loop while Kuralle retains flows, policy, durability, sessions, and streaming.
