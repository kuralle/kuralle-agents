---
name: release-governance
description: Use when auditing release readiness, writing release notes, choosing a semantic version tag, or preparing a GitHub draft release from repository evidence.
allowed-tools: [inspect_release_state, run_release_checks, workspace, save_release_candidate, get_release_candidate, publish_draft_release]
---
# Release governance

1. Inspect the authoritative release snapshot. A dirty tree, detached HEAD, wrong branch, or moving HEAD is a hard stop.
2. Run every configured check and require a passing result bound to the same HEAD.
3. Read the changesets and representative source or documentation changes. Commit subjects are leads, not sufficient evidence by themselves.
4. Group user-visible changes under Added, Changed, Fixed, Security, and Operations. Omit empty groups.
5. State breaking changes and migration work explicitly. If none are evidenced, do not invent a compatibility promise.
6. Keep internal implementation trivia out unless it changes operation, security, performance, or the public API.
7. Save one candidate, read it back, and present its revision and exact tag to the operator before publication.
8. Publication means a GitHub draft only. A human owns final editing, tagging, and publishing.

Read `references/review-checklist.md` before saving a candidate.
