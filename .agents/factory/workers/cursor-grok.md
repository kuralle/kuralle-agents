---
type: worker
probe: command -v cursor-agent
command: cursor-agent -p --force --trust --model cursor-grok-4.6-high --sandbox disabled --approve-mcps --workspace {repo_path} --output-format text < {prompt_file}
---

# cursor-grok

Cursor CLI pinned to `cursor-grok-4.6-high`. Created 2026-08-13 on explicit
human instruction for the `dynamic-durable-flows` goal ("use cursor-grok-4.6-high
model using the cursor worker"). Kept as a separate worker file rather than
editing [cursor.md](cursor.md), so the default Composer pin stays audited and
this model choice is a routing decision per that file's own rule.

stdin IS the prompt — do not add `< /dev/null`.

`cursor-agent models` lists `cursor-grok-4.6-high - Cursor Grok 4.6` (verified
2026-08-13).

Dispatch rule: run `probe` first. Substitute `{prompt_file}` and `{repo_path}`,
append the per-task log redirect engine-side, background through the harness,
per [../protocol.md](../protocol.md).
