# Flow Examples (v2)

Parity ports of `pipecat-flows/examples` using v2 `defineFlow`, `reply`/`collect`/`action`/`decide`, and returned transitions.

Run any example:

```bash
cd packages/core
bun examples/flows/quickstart-hello-world.ts
bun examples/flows/food-ordering.ts
```

Every file also default-exports its `AgentConfig` and guards direct execution
with `import.meta.main`, so the CLI can load it without starting the example's
own conversation runner:

```bash
bun packages/cli/src/cli.ts chat \
  --agent packages/core/examples/flows/quickstart-hello-world.ts \
  --trace
```

The dual-driver stress playground imports all files in this directory, runs
them through CLI auto-chat with both the default AI SDK driver and the Pi
driver, and verifies their persisted traces and OTLP export:

```bash
bun run --cwd apps/playground/pi-driver-stress run
```
