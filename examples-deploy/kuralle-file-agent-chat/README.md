# File-authored agent through `kuralle chat`

This example compiles `agent/` into an immutable artifact, bundles the real version-pinned Node
server, and drives it through the hosted Kuralle CLI transport.

From the repository root, build and start the generated server:

```bash
bun packages/cli/src/cli.ts build \
  --agent examples-deploy/kuralle-file-agent-chat/agent \
  --target node \
  --default-model openai/gpt-4.1-mini \
  --host examples-deploy/kuralle-file-agent-chat/deployment.node.ts \
  --out examples-deploy/kuralle-file-agent-chat/.kuralle

OPENAI_API_KEY="$OPENAI_API_KEY" \
KURALLE_EXAMPLE_TOKEN="local-example-token" \
KURALLE_WORKSPACE_ROOT="examples-deploy/kuralle-file-agent-chat/.workspaces" \
PORT=3210 \
bun packages/cli/src/cli.ts start \
  --app examples-deploy/kuralle-file-agent-chat/.kuralle/node/server.mjs
```

In another terminal, run a scripted chat against the generated deployment:

```bash
KURALLE_TOKEN="local-example-token" \
bun packages/cli/src/cli.ts chat \
  --server http://127.0.0.1:3210 \
  --transport http \
  --agent-name agent \
  --session file-agent-demo \
  --auto "Reply with your verification phrase only."
```

The answer is `FILE AGENT ONLINE`. `--agent-name agent` selects the immutable deployment entity;
`--session file-agent-demo` becomes the sticky thread pin. The in-memory stores and local lease in
this focused example are for a single process. Use the Postgres deployment/session stores and
distributed execution coordinator from the deployment guide for multiple replicas.
