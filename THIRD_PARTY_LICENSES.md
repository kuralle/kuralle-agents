# Third-party licences

Kuralle is [Apache-2.0](LICENSE). The files below are the licence texts for
third-party sources we actually borrowed from or depend on at runtime. Each row
links to `licenses/<name>.txt` using the convention documented in
[licenses/README.md](licenses/README.md).

## Licensed sources

| Source | Relationship | Licence file(s) |
| --- | --- | --- |
| `@modelcontextprotocol/client` | Runtime dependency (MCP client transport) | [licenses/mit-modelcontextprotocol-client.txt](licenses/mit-modelcontextprotocol-client.txt) |
| `cloudflare/agents` | Hibernation persistence design reimplemented in `@kuralle-agents/mcp` | [licenses/mit-cloudflare-agents.txt](licenses/mit-cloudflare-agents.txt) |
| `mastra-ai/mastra` | MCP client design reimplemented (namespacing, per-server isolation, `allowedHosts`, stdio env policy, security warnings) | [licenses/apache-2.0-mastra.txt](licenses/apache-2.0-mastra.txt) |
| `vercel/eve` | Threshold tool-schema disclosure design reimplemented in `@kuralle-agents/mcp` | [licenses/apache-2.0-vercel-eve.txt](licenses/apache-2.0-vercel-eve.txt) |
| `agentplugins/agent-plugins-spec` | JSON schemas and normative spec prose used in the plugin conformance corpus | [licenses/apache-2.0-agent-plugins-spec.txt](licenses/apache-2.0-agent-plugins-spec.txt) (code/schemas) and [licenses/cc-by-4.0-agent-plugins-spec.txt](licenses/cc-by-4.0-agent-plugins-spec.txt) (spec prose) |

## Considered and not borrowed from

These sources were studied during MCP and plugin design. Nothing in the
distribution derives from them, so no licence file is listed.

| Source | Licence | Reason omitted |
| --- | --- | --- |
| `coder/mux` | AGPL-3.0 | Read-only reference. Nothing was copied; citing it as an origin would falsely imply derivation and the AGPL network clause would reach our whole distribution. |
| `Toasterson/agent-plugin-ts` | MPL-2.0 | Evaluated and rejected. Its fixtures were deliberately not vendored, so no file derives from it. |
