---
type: worker
probe: command -v claude
command: claude --dangerously-skip-permissions --model sonnet -p < {prompt_file}
---

# claude

Default implementation worker. **`--model sonnet`** is pinned in the command
(the alias, not a dated id; never a `[1m]` variant). stdin IS the prompt — do
not add `< /dev/null`.

**Dispatch it through a wrapper script that PIPES the brief in.** Three ways
this goes wrong, all observed on 2026-08-04, all silent-ish:

```bash
# runs/dispatch-<task>.sh
#!/usr/bin/env bash
cd <repo> || exit 1
cat runs/brief-<task>.md | claude --dangerously-skip-permissions --model sonnet -p
```

- `-p < brief.md` backgrounded through the harness exits 0 having done nothing;
  the log reads "There's no message or task in your last turn — just system
  context." The redirect does not survive backgrounding. **A worker that exits 0
  with no result file and a log about missing input is this bug, not a refusal.**
- `-p "$(cat brief.md)"` fails with `error: unknown option '---`, because a
  brief that begins with the workmanship frontmatter starts with `-`. Strip the
  leading `---…---` block when assembling a brief, or the argument is parsed as
  a flag.
- Building the command inline (rather than in a script) puts the brief's own
  quotes and backticks inside the harness's `eval '…'` wrapper and mangles it.

The pipe-through-a-script form avoids all three. It is slow to first output —
90s with no bytes is normal work, not a hang.

Dispatch rule: run `probe` first — if it fails, this worker does not exist on
this machine; pick another file in this directory. Then substitute the
placeholders — `{prompt_file}` with the brief path, `{repo_path}` with the
absolute repo or worktree path — and dispatch per
[../protocol.md](../protocol.md), which appends the log redirect and
backgrounds the run. Change the flags here, never in a brief. The result
contract is defined in the same file.
