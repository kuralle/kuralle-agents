---
type: worker
probe: command -v codex
version: codex --version
command: codex exec -C {repo_path} --model gpt-5.6-luna -c model_reasoning_effort="xhigh" -c model_service_tier="priority" --dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust --skip-git-repo-check "$(cat {prompt_file})" < /dev/null
---

# codex-luna-xhigh

Codex CLI pinned to `gpt-5.6-luna` at **`xhigh`** reasoning on the **priority**
service tier. Created 2026-08-23 on explicit human instruction ("use codex
gpt-5.6-luna xhigh service priority fast") during the `cli-tui-split` goal.

Kept as a separate worker file rather than editing [codex.md](codex.md), so that
file's `high`/default-tier pin stays audited — the same reason
[cursor-grok.md](cursor-grok.md) exists beside [cursor.md](cursor.md).

**When to reach for this over the default IC.** The hard cases, where a cheaper
worker has already failed or the task is diagnosis rather than construction:
a hang whose cause is not obvious, a defect that survived two remediation
rounds, a design call with real blast radius. `xhigh` costs more per dispatch
and is worth it exactly when a second failed cycle would cost more.

**`< /dev/null` is mandatory** — `codex exec` otherwise prints "Reading
additional input from stdin…" and hangs when backgrounded. The prompt is passed
as `"$(cat {prompt_file})"`, not on stdin.

Both settings verified live on codex-cli 0.147.0 before this file was written:
`-c model_reasoning_effort="xhigh" -c model_service_tier="priority"` is accepted
and returns normally. Verify again after a codex upgrade — an unrecognised `-c`
key is silently ignored rather than rejected, so a stale key degrades to the
default without telling you.

Dispatch rule: run `probe` first, substitute `{prompt_file}` and `{repo_path}`,
then dispatch per [../protocol.md](../protocol.md), which appends the log
redirect and backgrounds the run. Change flags here, never in a brief.
