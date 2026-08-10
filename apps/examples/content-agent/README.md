# Local Content Desk

A production-runnable Kuralle content agent for a terminal. It turns local Markdown source material into reviewed drafts and local publications. Pi is the default driver; the same agent can run on Core's built-in AI SDK driver.

This is an adaptation of the workflow ideas in Vercel’s Eve content-agent template, not a hosted-service port. Slack, Notion, Vercel Blob, remote workspace storage, and voice UI are deliberately absent.

## Run it

Requirements: Bun, an OpenAI API key, and Node-compatible local filesystem access.

```bash
cp .env.example ../../../.env
# add OPENAI_API_KEY to ../../../.env
bun install
bun run chat
```

## Drivers

This example runs on the **Pi driver** by default.

| Driver | Command |
| --- | --- |
| Pi — the default | `bun run chat` |
| Core's built-in AI SDK driver | `bun run chat:ai-sdk` |

Both run the same agent. Set `KURALLE_DRIVER=pi` or `KURALLE_DRIVER=ai-sdk` to choose one
directly. The switch lives in `src/production-runtime.ts`, in this example — nothing is shared with the
other examples, so you can read the whole wiring in one folder.

The TUI persists conversation state and traces under `runs/`. The content itself remains ordinary files under `workspace/`. Set `CONTENT_WORKSPACE_PATH` to point the agent at another caller-owned directory with the same layout.

Try:

> Read the Kuralle brief and draft a blog post about the local content agent.

Then ask it to save the draft, approve the tool in the TUI, review the returned revision, and say “publish that exact revision” when ready.

## Files are the product boundary

```text
workspace/
├── sources/       input briefs and evidence; model-readable, never mutated
├── skills/        Agent Skills packages with SKILL.md and references
├── preferences/   standing writer preferences
├── drafts/        approval-gated working documents
└── published/     append-only local publications
```

Kuralle’s read-only `workspace` tool lets the model list, search, and read the tree. The style catalog uses Kuralle’s separate progressive skill path: descriptions appear in the prompt, `load_skill` loads one procedure, and `read_skill_resource` loads one supporting file. Skill bodies are not dumped into every model call.

Durable mutations use narrow tools rather than a writable generic filesystem:

- `save_writer_preferences` replaces a short, curated Markdown file.
- `create_draft` requires real source paths and clean deterministic lint, and cannot overwrite.
- `get_draft` returns the current Markdown, metadata, and SHA-256 revision.
- `update_draft` requires those checks plus the exact current draft revision.
- `publish_draft` requires the exact SHA-256 revision the writer reviewed, re-runs lint, creates a new publication, and refuses overwrite.
- `delete_draft` requires approval and an exact revision; it cannot delete publications.

Writes use a temporary file followed by a same-filesystem rename. Paths are derived from enum-constrained surfaces and strict slugs. The Node filesystem adapter confines all virtual paths and symlink resolution to the configured root.

## Grounding and review

The agent must read source Markdown before drafting and records those paths in document metadata. Source text is treated as untrusted evidence, never as permission or agent instructions. When a source does not support a claim, the agent must surface the gap.

Each surface has a `SKILL.md`, a format rubric, and a deterministic banned-words list. Lint is intentionally fail-closed: a missing, invalid, or malformed resource fails the operation instead of reporting a clean draft.

The original template used fresh-context researcher and reviewer subagents. This local example keeps the production boundary smaller: research is explicit local-source retrieval, deterministic lint is a hard floor, and the human sees and approves the exact revision before publication. A separate qualitative reviewer agent can be added later without changing the storage or approval contract.

## API behaviour and failure modes

- New draft: `create_draft` has no revision field; an existing path produces `EEXIST` and returns no write.
- Draft update: call `get_draft`, then call `update_draft` with its SHA-256 revision; a mismatch produces `ESTALE`.
- Publication: requires a current draft revision; a prior publication at the same path produces `EEXIST`.
- Missing source: fails before write.
- Style violation or broken lint resource: fails before write or publication.
- Path traversal and symlinks outside the configured root: rejected by `NodeFileSystem`.
- Approval denial: Kuralle resumes the run without executing the mutation.

## Verify

```bash
bun test
bun run typecheck
```

The test suite covers the approval surface, local-file persistence, grounding constraints, fail-closed lint, stale revisions, append-only publication, and filesystem confinement.

## Provenance

Workflow ideas were reimplemented from `vercel-labs/eve-content-agent-template` at commit `dd42d0a6cf8e6a10371b2115e560a2e60edcaab7` (Apache-2.0), informed by `vercel/eve` at `6dc662ca8e6e81113d3c416eedc16533133fd189` (Apache-2.0) and `cloudflare/agents` at `6e77f62e368279a5bbd11ee2c4b2f489693d0401` (MIT). No upstream hosted integration code is included.
