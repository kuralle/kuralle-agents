# Full-stack loop evaluation

This example compares Kuralle's default AI SDK model/tool loop with
`@kuralle-agents/pi-driver` on the same `openai:gpt-4.1-mini` agent.

The scenario is intentionally broader than a chat smoke test. Each run must:

1. load a filesystem-backed incident-response skill;
2. read a reference owned by that skill;
3. read an account record through the read-only FS tool;
4. retrieve the correct runbook through Kuralle RAG; and
5. produce an answer containing all four independently sourced facts.

The two runtimes share the exact agent config, prompt, task, corpus, tools, and
correctness checks. The only changed input is the runtime driver:

```text
same AgentConfig
├── default runtime -> TextDriver -> Vercel AI SDK loop
└── Pi runtime      -> PiDriver   -> pi-agent-core loop
                         |
                         `-> Kuralle still executes every tool and owns state
```

## Run it

Put `OPENAI_API_KEY` in the repository root `.env`, install the workspace, then
run:

```bash
bun install
bun run --filter @kuralle-agents/pi-driver example:full-stack-eval
```

The default run performs one warmup and three measured runs per driver. For a
quick paid smoke test:

```bash
PI_EVAL_WARMUPS=0 PI_EVAL_RUNS=1 \
  bun run --filter @kuralle-agents/pi-driver example:full-stack-eval
```

Set `PI_EVAL_OUTPUT` to change the output path. Otherwise the complete report is
written to `results/latest.json` beside this README.

## What is measured

- **Correctness:** 14 deterministic checks over the answer, error stream, tool
  calls, arguments, and returned evidence.
- **TTFT:** milliseconds from `runtime.run()` until the first client-visible
  `text-delta`.
- **Total latency:** milliseconds until the run handle and event stream finish.
- **Loop behavior:** model-call count, tool-call count and trace, usage tokens,
  and per-model-call duration.

The summary reports both the difference between each driver's group median and
the median of ordinal-paired differences. Those statistics can diverge in a
small, noisy network sample, so they are labeled separately.

Execution order alternates between drivers and warmups are excluded from the
summary. Warmup correctness is retained in the JSON artifact as diagnostic data.
A measured run with missing evidence fails the command after the artifact has
been written.

## Substrates exercised

- `@kuralle-agents/core`: agent authoring, runtime, stream, and tool execution
- `@kuralle-agents/fs`: `InMemoryFs` and the read-only workspace tool
- Core skills: `fsSkillStore`, `SKILL.md`, and a skill reference
- `@kuralle-agents/rag`: `RagPipeline`, Markdown chunking, and
  `InMemoryVectorStore`
- `@kuralle-agents/tools`: `createVectorRetrievalTool`
- `@kuralle-agents/pi-driver`: the candidate `pi-agent-core` loop

The embedder is a deterministic local token-hash implementation. This keeps
embedding-provider cost and network latency out of the loop comparison while
still exercising ingestion, chunking, vector storage, retrieval, and the RAG
tool. Results are an environment-specific sample, not a universal performance
claim; increase `PI_EVAL_RUNS` and repeat at different times for stronger data.
