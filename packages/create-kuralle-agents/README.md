# create-kuralle-agents

Scaffold a new [Kuralle](https://agents.kuralle.com) project from a template.

Kuralle is a TypeScript framework for building conversational AI agents with structured
flows, routing, and durable tool execution, built on the Vercel AI SDK.

## Usage

```bash
npm create kuralle-agents@latest
```

That starts an interactive picker: choose a template, name the directory, and the project
is written and ready to install.

Skip the picker by naming both up front:

```bash
npm create kuralle-agents@latest my-agent --template nextjs-chatbot
```

| Argument | Description |
|---|---|
| `[dir]` | Directory to create the project in. Prompted for when omitted. |
| `-t`, `--template <id>` | Template to scaffold. Prompted for when omitted. |
| `-h`, `--help` | Print usage and exit. |

## Templates

The template list is fetched from the [`kuralle/starter`](https://github.com/kuralle/starter)
repository at the branch matching this package's major and minor version, so a template added
there appears without waiting for a new release of this CLI. If GitHub is unreachable, the
picker falls back to a template list bundled at build time.

Pinning templates to the CLI's own version line is deliberate: a scaffolded project always
receives a template set compatible with the framework version it is generated against.

## What you get

The scaffolded project depends on the published `@kuralle-agents/*` packages — it is a normal
application, not a fork of the framework. Install and run it with your usual package manager.

## Links

- [Documentation](https://agents.kuralle.com)
- [GitHub](https://github.com/kuralle/kuralle-agents)

## License

Apache-2.0
