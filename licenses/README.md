# Third-party licence texts

Each file in this directory holds the full licence text (or an honest
incorporation-by-reference stub where noted) for a source Kuralle actually
borrowed from or depends on at runtime.

## Filename convention

```
<spdx>-<project-slug>.txt
```

- **`<spdx>`** — lowercase SPDX identifier (`mit`, `apache-2.0`, `cc-by-4.0`, …).
- **`<project-slug>`** — the project name with `/` replaced by `-` and a leading
  `@` scope dropped. Examples:

| Project | Slug | Example file |
| --- | --- | --- |
| `@modelcontextprotocol/client` | `modelcontextprotocol-client` | `mit-modelcontextprotocol-client.txt` |
| `cloudflare/agents` | `cloudflare-agents` | `mit-cloudflare-agents.txt` |
| `mastra-ai/mastra` | `mastra` | `apache-2.0-mastra.txt` |
| `vercel/eve` | `vercel-eve` | `apache-2.0-vercel-eve.txt` |
| `agentplugins/agent-plugins-spec` | `agent-plugins-spec` | `apache-2.0-agent-plugins-spec.txt` + `cc-by-4.0-agent-plugins-spec.txt` |

## In-file credits

Source files that reimplement a peer design carry a comment of the form:

```ts
// Reimplemented from `<project>`, <path/in/that/project> (<SPDX>).
// Reimplemented from the described design, not copied; changes were made.
```

`scripts/check-provenance.sh` maps `` `<project>` `` to `licenses/*-<slug>.txt` using
the same slug rule, so a credit cannot name a source with no licence file here.

## Index

`THIRD_PARTY_LICENSES.md` at the repo root lists every file in this directory and
records sources that were evaluated but deliberately not borrowed from.
