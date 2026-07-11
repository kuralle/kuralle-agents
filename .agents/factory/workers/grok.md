---
type: worker
probe: command -v grok
command: grok --prompt-file {prompt_file} --model grok-composer-2.5-fast --always-approve --output-format plain
---

# grok

Fast implementation worker (default IC). `--model grok-composer-2.5-fast`
is the installed default; swap to `grok-build` or another id from
`grok models`. Never pass `--sandbox` — omitting it grants full IC
access; `--sandbox` is opt-in to restrict, only for untrusted third-party
code.

Dispatch rule: run `probe` first — if it fails, this worker does not exist on
this machine; pick another file in this directory. Substitute {prompt_file}
with the brief path and run `command` verbatim. The result contract is
defined in [../protocol.md](../protocol.md).
