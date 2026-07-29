# Agent workspaces, filesystems, and skills

Status: implemented reference design, 2026-07-29

This note records the design research behind Kuralle's portable workspace and skill changes. It compares the current source of Cloudflare Agents/Think, Eve, and Mastra rather than copying any one framework wholesale.

## First principles

An agent workspace is not merely “files attached to a prompt.” It is a capability boundary with five independent concerns:

1. **Identity:** which user, tenant, session, and agent owns this view?
2. **Namespace:** which paths exist, and how are multiple backends mounted?
3. **Authority:** which operations may the model invoke, which may trusted executor code invoke, and what does the backend enforce regardless of prompt behavior?
4. **Lifetime:** which files are bundled, ephemeral, session-durable, or globally durable?
5. **Disclosure:** which context is always visible, which is discoverable, and which is fetched only when needed?

The model-facing tool is not the security boundary. It is an ergonomic projection of authority. Mount wrappers, root confinement, tenant resolution, and durable storage remain authoritative when a model ignores instructions or emits an unexpected call.

Skills solve a different problem from workspaces. A workspace contains task state and evidence. A skill is a selectively loaded procedure with optional resources and constrained tool names. Mounting skills into the traversable workspace collapses those roles, increases prompt/tool ambiguity, and makes accidental instruction discovery easier.

## What the other systems teach

The source revisions inspected were:

- Cloudflare `cloudflare/agents` at `753a6748c1d20e56a300bedab6174e43acb33a79`
- Mastra `mastra-ai/mastra` at `7a34274124c156b7303a18fb6d749f9f0b4b9bf8`
- Vercel Eve `vercel/eve` at `068c399daa649b0dc88f5e7221dc16b7dccf6e3d`

### Cloudflare Agents and Think

Cloudflare's `Think` package treats a workspace as a normal capability of every durable agent: SQLite-backed files, automatic read/write/edit/list/find/grep/delete/bash tools, optional R2 spillover for large objects, and a separate Agent Skills registry. That is a strong fit for a Durable Object because coordination state and small durable files share one single-threaded ownership atom.

The reusable lesson is substrate locality, not Cloudflare lock-in. Kuralle exposes the DO's native SQL handle to `sqlFileSystem()` but keeps Core typed against the portable `FileSystem` interface. The same agent definition can therefore use an in-memory, Node, SQL, D1, R2-assisted, or composite implementation.

### Eve

Eve is filesystem-first in both authorship and execution. Authored slots determine identity, selected files seed `/workspace`, packaged skills are placed outside that workspace, and built-in bash/read/write/glob/grep tools proxy into a per-session sandbox. Privileged tools and secrets remain in the trusted application runtime rather than the model's shell environment.

The key lesson is the two-world security model: model-controlled filesystem/shell work must not imply access to application environment variables or privileged connections. Kuralle adopts the namespace and skill separation now. A future shell-capable hosted agent should preserve Eve's stronger sandbox/runtime split; a Durable Object SQLite filesystem alone is persistence and confinement, not process isolation.

### Mastra

Mastra's Workspace composes filesystem, sandbox, mounts, search, tools, and skills. It supports runtime resolvers, local and remote filesystem providers, composite views, and both lexical/BM25 and vector search. Its skill discovery layers project and global roots with explicit precedence.

The key lesson is late binding. Workspace selection belongs at request/session resolution time, not agent construction time. Kuralle therefore accepts an async workspace resolver with `{ session, agentId }`, enabling tenant-specific backends without rebuilding the agent API. Kuralle also adopts explicit mount composition and ordered skill-store layering, while leaving workspace indexing/search as a separate future capability rather than overloading exact filesystem operations.

## Kuralle decisions

| Concern | Decision | Why |
| --- | --- | --- |
| Runtime binding | `AgentWorkspaceResolver` resolves per session/agent | Tenant and durable-object isolation cannot be safely expressed by one static filesystem |
| Model authority | Read-only traversal is the default even if trusted executor code can write | Safe discovery should not silently grant mutation |
| Explicit mutation | `modelWritable: true` exposes mkdir/write/edit/mv/rm | Consequential capability is visible in configuration and review |
| Enforcement | `readOnlyFileSystem()` and `CompositeFileSystem` enforce mount policy | Prompt text and filtered schemas are insufficient boundaries |
| Namespace | Longest-prefix composite mounts | One stable path tree can combine immutable knowledge and durable working state |
| Operations | ls, find, grep, cat/read, stat, mkdir, write, edit, mv, rm | The model can traverse and maintain a workspace without requiring a shell |
| Skills | Separate `SkillStoreLike`, progressive `load_skill` and `read_skill_resource` | Procedures stay out of general evidence traversal and prompt cost remains bounded |
| Resource discovery | Skill bodies link to exact relative resources | Level-three assets are otherwise invisible by design |
| Cloudflare persistence | DO SQLite handle is a protected `KuralleAgent` API | Applications avoid reaching through undocumented Agents internals |
| Hosted clients | Stable HTTP JSON plus native Cloudflare WebSocket | Server-rendered facades and native resumable clients need different transports |

The pharmacy example makes the policy concrete:

```text
per-session resolver
  -> CompositeFileSystem
       /knowledge -> readOnlyFileSystem(InMemoryFs)
       /notes     -> SqlFileSystem(Durable Object SQLite)

separate fsSkillStore
  -> prescription-intake/SKILL.md
  -> prescription-intake/references/clarification-checklist.md
  -> order-fulfilment/SKILL.md
```

Live platform verification proved root traversal, immutable knowledge reads, durable note creation and rereads across turns, failed writes at the `/knowledge` mount boundary, skill and resource loading, and isolation between Durable Object instances.

## What Kuralle deliberately does not claim

- A virtual filesystem is not a secure shell. Shell execution still needs an isolated sandbox, resource quotas, egress policy, and credential brokering.
- Session names are not authentication. Hosted routers must derive ownership from verified identity and fail closed.
- SQLite is excellent for small, coordinated durable state, not arbitrary large blobs. Add an R2 blob tier behind the same interface when file size or retention warrants it.
- Exact grep and semantic retrieval are complementary. Filesystem grep should remain deterministic and cheap; workspace indexing should be opt-in and independently observable.
- Model-writable notes can still contain sensitive or malicious content. Retention, redaction, scanning, and human approval remain application responsibilities.
- Skills constrain discoverability and validate declared tool names; they do not replace runtime tool policy or approvals.

## Follow-on work

1. Add a sandbox capability whose filesystem is mount-compatible with `AgentWorkspaceResolver`, while keeping secrets in trusted tools.
2. Add optional workspace search adapters with lexical/BM25 first and vector indexing only when justified.
3. Add quotas, MIME/size limits, and an R2 spillover backend to `SqlFileSystem` deployments.
4. Add authenticated tenant/session resolution examples for both Cloudflare native routes and HTTP facades.
5. Expose workspace snapshots and skill content hashes in trace inspection so a run can be reproduced against the exact capability set.

## Primary sources

- [Cloudflare Think workspace and skills README](https://github.com/cloudflare/agents/tree/main/packages/think)
- [Cloudflare Agents chat agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Cloudflare Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/)
- [Cloudflare Agents routing](https://developers.cloudflare.com/agents/runtime/communication/routing/)
- [Eve project layout](https://github.com/vercel/eve/blob/main/docs/reference/project-layout.md)
- [Eve security model](https://github.com/vercel/eve/blob/main/docs/concepts/security-model.md)
- [Mastra Workspaces introduction](https://mastra.ai/blog/introducing-mastra-workspaces)
- [Mastra Workspace documentation](https://mastra.ai/docs/workspace/overview)
