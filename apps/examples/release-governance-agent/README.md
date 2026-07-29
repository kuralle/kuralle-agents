# Release Governance Agent

A production-oriented Kuralle operator for preparing a GitHub release from a real repository. It inspects Git history, runs the repository's configured release gates, writes an evidence-bound candidate, and can create that exact candidate as a GitHub **draft** after explicit human approval.

This is not a simulated release chat. The agent reads the configured repository, executes real checks without a shell, persists revisioned artifacts, and calls the GitHub Releases API. Its authority deliberately stops before tagging, pushing, or publishing a release.

## Why this use case

Release preparation is useful agent work because the evidence and the authority boundary are both concrete. Mastra describes a release-notes agent that creates draft GitHub releases; the broader production-agent pattern is to give an agent a narrow job, approved actions, evaluation gates, and escalation paths. The [case-study research](../../../research/production-agent-release-governance.md) records the sources, alternatives, and selection criteria behind this example.

## Architecture

```text
real Git repository (read-only /repo)    writable state (/output)
                 \                         /
                  inspect -> run checks
                          -> draft candidate
                          -> operator approval
                          -> GitHub draft release only
```

The implementation uses Kuralle primitives throughout:

- `defineAgent` and typed `defineTool` contracts for the operator and its effects.
- The Pi driver by default through the shared production runtime; `KURALLE_DRIVER=ai-sdk` exercises the same agent with the built-in driver.
- A composite Kuralle workspace with an immutable `/repo` mount and a writable `/output` mount.
- A filesystem skill that progressively discloses the release checklist.
- A custom Kuralle policy plus tool-level approval gates for checks, candidate persistence, and GitHub draft creation.
- The durable journal, session store, traces, idempotency key, and native CLI approval/resume path supplied by Core.

## Production boundary

The agent:

- requires a clean checkout on the configured release branch;
- binds each successful check run to the exact Git `HEAD`;
- binds a release candidate revision to that check evidence;
- revalidates branch, cleanliness, `HEAD`, and check evidence immediately before publication;
- invokes commands as argument arrays with `shell: false`, timeouts, and streaming-bounded output;
- removes `.env`, credential, private-key, and Git-internal paths from the model's repository view, including symlink aliases;
- uses the exact configured GitHub `owner/repository` and refuses to overwrite a conflicting release;
- creates only `draft: true` releases and safely reuses only an exact existing draft.

The agent cannot edit the repository, create tags, push branches, publish a non-draft release, or turn a different GitHub release into its candidate. A human still reviews the candidate, creates the tag, and performs final publication.

## Run it

From the repository root:

```bash
bun install
cp apps/examples/release-governance-agent/.env.example .env
```

Set `OPENAI_API_KEY`. Set `GITHUB_TOKEN` only when you intend to exercise draft creation; inspection, drafting, and tests do not need it. The token should have the minimum Releases permission needed for the configured repository.

Then start the native terminal client:

```bash
bun run --cwd apps/examples/release-governance-agent chat
```

A useful first request is:

```text
Inspect this repository and prepare release notes for v0.2.0. Run every configured gate, save the candidate, and stop for my review before creating a GitHub draft.
```

Approve only after reviewing the exact candidate revision shown by the agent. The CLI records approvals and resumes the durable run through Kuralle's normal control path.

## Configure another repository

Set these values in the root `.env` or process environment:

| Variable | Purpose |
| --- | --- |
| `RELEASE_REPO_ROOT` | Absolute path, or a path relative to this app, for the target Git checkout |
| `RELEASE_BRANCH` | Branch on which release preparation is allowed |
| `GITHUB_REPOSITORY` | Exact `owner/repository` receiving the draft |
| `RELEASE_STATE_ROOT` | Optional directory for check records and candidate artifacts |
| `RELEASE_CONFIG_PATH` | Optional path to the JSON check configuration |

Edit `release-agent.config.json` to define the ordered repository gates. Each command is a JSON argument array, not a shell string:

```json
{
  "checks": [
    { "name": "TypeScript", "command": ["bun", "run", "typecheck"] },
    { "name": "Tests", "command": ["bun", "test"] }
  ]
}
```

## Verify the contract

```bash
bun run --cwd apps/examples/release-governance-agent typecheck
bun run --cwd apps/examples/release-governance-agent test
```

The tests use temporary Git repositories and a fake GitHub transport. They cover clean/dirty state, branch and stale-`HEAD` enforcement, passing-check evidence, candidate revision integrity, read-only workspace policy, approval metadata, exact-draft reuse, conflict refusal, and the invariant that the GitHub payload remains draft-only.
