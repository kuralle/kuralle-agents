---
'@kuralle-agents/cli': minor
---

`kuralle send` can now deliver an approval or a signal: `--approve [by]`, `--deny [by]`, `--signal <name> [--payload <json>]`.

A `needsApproval` tool suspends the run durably, and the runtime has always accepted `signalDelivery` on `run()` — but the CLI had no way to send one. So `send` could enter an approval pause and never leave it: every later turn re-requested approval and paused again. Human-in-the-loop was a headline feature the CLI could start and not finish.

A decision may arrive with no message — approving is itself the turn.
