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

**Piping is flaky at brief size** — the same brief that piped in successfully
once later reported "I don't see an explicit request in your message". Do not
rely on it. The form that has held is a **short argv prompt pointing at the
brief file**, with stdin closed:

```bash
# runs/dispatch-<task>.sh
#!/usr/bin/env bash
cd <repo> || exit 1
exec claude --dangerously-skip-permissions --model sonnet -p \
  "Read the file runs/brief-<task>.md in this repo and execute it exactly as
   written. It is your complete task brief, including the result contract you
   must write to runs/result-<task>.json before you finish. It is self-contained." \
  < /dev/null
```

The worker reads the brief with its own file tools, so neither size nor stdin
timing is in play.

**Never put a `timeout` on the dispatch.** `Execution error` in the log is
usually just the harness truncating a still-running job — a schema-plus-
migrations task takes many minutes, and 60s of silence is normal work, not a
hang. Bound it with the result-file monitor instead (see protocol.md).

Dispatch rule: run `probe` first — if it fails, this worker does not exist on
this machine; pick another file in this directory. Then substitute the
placeholders — `{prompt_file}` with the brief path, `{repo_path}` with the
absolute repo or worktree path — and dispatch per
[../protocol.md](../protocol.md), which appends the log redirect and
backgrounds the run. Change the flags here, never in a brief. The result
contract is defined in the same file.
