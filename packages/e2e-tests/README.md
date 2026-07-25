# @kuralle-agents/e2e-tests

End-to-end tests for Kuralle **text** agents. Private, not published.

> Voice/realtime E2E (provider-native audio, cascaded pipelines, SIP/WebSocket transports, `.pcm`
> fixtures, the fake realtime client) was removed with the voice packages. Cascaded voice and
> telephony live in [kuralle/kuralle-livekit](https://github.com/kuralle/kuralle-livekit).

## Suites

| File | What it covers | Needs |
|---|---|---|
| `tests/flow-triage.test.ts` | flow + triage routing over a stub driver | — |
| `tests/parallel-tools-durability-e2e.ts` | parallel tool execution against the durable journal (G9/H1) | `OPENAI_API_KEY` |
| `tests/postcall-audit/02-runtime-stream-on-session-end.ts` | runtime stream on session end | — |
| `tests/postcall-audit/04-analytics-local-endpoint.ts` | analytics batching to a local endpoint | — |
| `tests/postcall-audit/05-eval-replay-and-score.ts` | transcript replay + golden scoring | — |

```bash
bun test tests/flow-triage.test.ts
npm run test:parallel-durability     # live OpenAI
npx tsx tests/postcall-audit/05-eval-replay-and-score.ts
```

## Rebuild before testing

These tests import the compiled `dist/` of workspace packages, not `src/`. After editing a
package's source, rebuild before running:

```bash
bun run build                        # all packages, topologically ordered
cd packages/core && npm run build    # or just one
```

Stale `dist/` is the most common "my fix didn't take" false negative in this repo.

## Other scripts

- `validate-prompt-cache.mjs` / `validate-gemini-cache.mjs` — live prompt-cache hit validation.
- `sandbox-poc/deploy.ts` — Vercel Sandbox deployment proof of concept.
