---
'@kuralle-agents/cli': patch
---

Add the first tests to `@kuralle-agents/cli`, covering store wiring.

`packages/cli` had no test script, so the root runner skipped it entirely — which is why `send --store` could ship discarding every trace without anything failing. The new tests assert what each command hands the runtime (session store *and* trace store), that the sidecar is written beside `--store` and survives the process, that it is JSONL rather than one JSON document, and that a torn final line does not fail the read. No model or API key required.

Also clarifies the sidecar naming in the CLI guide and in `trace.ts`: `runs/app.json` writes `runs/app.traces.json` — the extension is replaced, not appended — and the file is JSONL.
