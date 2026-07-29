# Pi driver CLI stress playground

This playground executes every agent in `packages/core/examples/flows` through
the real `packages/cli` chat surface with the same OpenAI model on two channel
drivers:

- `ai-sdk`: Kuralle `TextDriver` backed by the Vercel AI SDK, retained as the
  portability baseline
- `pi`: `@kuralle-agents/pi-driver` backed by
  `@earendil-works/pi-agent-core`, with Pi-native typed flow collection and
  decisions enabled; this is the application's default when no driver is set

It also adds two substrate scenarios that the flow examples do not cover
together:

- `kitchen-sink`: separate workspace and skill filesystems, progressive skill
  and resource loading, grounded file reads, and three `parallelSafe` tools
- `okf`: an Open Knowledge Format bundle navigated with a filesystem-backed
  skill and the workspace tool

## Run it

Put `OPENAI_API_KEY` in the repository root `.env`, then run:

```sh
# Fast substrate check, both drivers
bun run --cwd apps/playground/pi-driver-stress smoke

# All Core flow examples plus both substrate scenarios, both drivers
bun run --cwd apps/playground/pi-driver-stress run

# Narrow a diagnosis
bun run apps/playground/pi-driver-stress/run.ts \
  --scenario patient-intake \
  --driver pi
```

Repeat `--scenario` and `--driver` to select more than one. `--model` overrides
the default `gpt-4.1-mini` for both lanes.

## What is actually verified

For each lane the runner starts the real CLI:

```text
kuralle chat --auto ... --trace --store ...
kuralle trace <session> --store ... --json
```

It then fails the run unless the persisted native traces prove:

- every scripted prompt produced one completed turn with text and TTFT;
- expected flows, tools, handoffs, and grounded answer facts occurred;
- no span ended in error;
- kitchen-sink tool intervals overlap, proving concurrent execution rather
  than merely observing three tool names;
- every CLI trace reached a local OTLP/HTTP collector with its semantic span
  kind and `kuralle.ttftMs` attribute intact.

The runner compares its scenario manifest with the directory contents before
making model calls. Adding or removing a Core flow example therefore fails fast
until the matrix is updated.

## Results

Each run creates an immutable timestamped folder under `results/` containing:

- file-backed CLI sessions and JSONL trace sidecars;
- one full trace/result JSON file per scenario and driver;
- `report.json` with correctness and median TTFT/total latency summaries.

`results/latest.json` points to the latest completed report. Latency from one
run is diagnostic evidence, not a benchmark conclusion; use repeated,
alternating runs before comparing drivers statistically.

The launcher is intentionally a synchronous CLI `buildRuntime` factory. The
runner selects the scenario and driver through child-process environment
variables, so Core examples remain ordinary import-safe `AgentConfig` modules
and the CLI package does not depend on the optional Pi adapter.
