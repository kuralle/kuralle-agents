# Templates

Start a new Kuralle project from a template with create-kuralle-agents.

The fastest way to start is from a template. `create-kuralle-agents` scaffolds a working project — no clone, no boilerplate to wire up.

## Create a project

1. Run the scaffolder. It fetches a template from the open-source [`kuralle/starter`](https://github.com/kuralle/starter) repo, sets your project name, and prints the next steps.

   ```bash
   npm create kuralle-agents@latest my-app
   ```

   Or pick the template up front:

   ```bash
   npm create kuralle-agents@latest my-app --template nextjs-chatbot
   ```

2. Install and run.

   ```bash
   cd my-app
   npm install
   cp .env.example .env   # add your OPENAI_API_KEY
   npm run dev
   ```

With no arguments, the CLI asks where to create the project and which template to use.

> **How it works**
>
> Templates live in the public [`kuralle/starter`](https://github.com/kuralle/starter) repo. The CLI downloads the one you pick with [`@bluwy/giget-core`](https://github.com/bluwy/giget-core) — the same downloader `create-hono` uses — pinned to the `vMAJOR.MINOR` tag that matches your CLI version, so you always get a compatible, up-to-date template. Browse or contribute templates there.

## Templates

| Template | What it is |
| --- | --- |
| `nextjs-chatbot` | A Next.js chat app wired to a Kuralle agent — streaming chat UI, thread history, and persistence through Kuralle `SessionStore` (in-memory by default, Postgres when `POSTGRES_URL` is set). |

> **More templates**
>
> `nextjs-chatbot` is the first template — more are on the way. In the meantime, the [Agents](./agents.md), [Flows](./flows.md), and [Routing](./routing.md) guides cover the same patterns (triage, flows, and per-specialist tool scoping) with runnable examples you can copy.

## What you get

Every template is a complete, runnable project:

- Kuralle already wired — `defineAgent` + `createRuntime`, ready to extend.
- A real example of the pattern it demonstrates (chat UI, persistence, flows, or triage).
- `.env.example` listing the keys you need.

Edit `lib/kuralle/` (or the equivalent) to change the agent, add tools, or attach a flow — see the [Agents](./agents.md), [Flows](./flows.md), and [Tools](./tools.md) guides.
