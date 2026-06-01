# Codex Review — `HEAD~10..HEAD` (`19bde2d..93097a7`)

## Findings

1. `packages/kuralle-core/examples/_shared/v2Runner.ts:16` — **high** — [axis: coherence] — the documented “force OpenAI” path is not reliable because `loadExampleEnv()` loads root `.env` after shell unsets, so `env -u XAI_API_KEY -u GOOGLE_GENERATIVE_AI_API_KEY ...` can still repopulate both keys from `.env` and select Google/xAI before OpenAI. — Why it fails: live example verification depends on provider selection, but the runner has only priority order (`Google -> xAI -> OpenAI`) and no explicit provider override. I verified this directly from `packages/kuralle-core` with `env -u GOOGLE_GENERATIVE_AI_API_KEY -u XAI_API_KEY bun -e "import { config } from 'dotenv'; config({ path: '../../.env' }); console.log(JSON.stringify({ google: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY), xai: Boolean(process.env.XAI_API_KEY), openai: Boolean(process.env.OPENAI_API_KEY) }));"` and got `{"google":true,"xai":true,"openai":true}`. Setting the vars to empty did force `openai:gpt-4o-mini`, but that key returned 401. — Fix: add an explicit `KURALLE_EXAMPLE_PROVIDER=openai|google|xai` or `OPENAI_ONLY=1` override, and fail fast with a provider-specific startup error before beginning the scripted conversation.

2. `packages/kuralle-core/examples/_shared/v2Runner.ts:108` — **medium** — [axis: coherence] — the example runner prints `Run complete.` after prompts are exhausted even when the flow never reaches a terminal `flow-end`/end node. — Why it fails: `food-ordering-direct-functions.ts` reached `confirm`, called `get_delivery_estimate`, then on the scripted final user input `Looks good` replied with another confirmation question and never called `complete_order`; no `Transition confirm -> end` or `flow-end` appeared, yet the runner still printed `Run complete.` This makes live examples look complete when they are merely out of scripted turns. — Fix: let examples declare an expected terminal reason/node/tool and have `runV2Conversation()` fail if that condition is not observed; also tighten the food-ordering final prompt or confirm-node instructions so “Looks good” deterministically maps to `complete_order`.

3. `packages/kuralle-core/src/runtime/channels/TextDriver.ts:177`, `packages/kuralle-core/src/runtime/channels/voiceTools.ts:29`, `packages/kuralle-core/src/tools/effect/ToolExecutor.ts:82` — **medium** — [axis: arch] — flow-local tools now silently shadow same-named registry tools across model exposure and execution (`{ ...toolDefs, ...(localTools ?? {}) }` plus `args.def ?? this.tools.get(name)`), with no collision guard or opt-in. — Why it fails: a node-local tool can replace a globally registered tool’s schema and executor by name without any signal, which is dangerous for globally governed tools such as payments, handoffs, policy-controlled actions, or audited integrations. The local-first behavior may be the right default for the G5/G6 fix, but unannounced collisions are a sharp public API edge. — Fix: detect same-name registry/local collisions during node resolution or driver tool resolution and either throw, warn under a debug channel, or require an explicit `allowShadow`/`localOverride` marker.

4. `packages/kuralle-core/test/core-voice/conformance.test.ts:168` — **low** — [axis: correctness] — the G5/G6 regression tests exercise local-tool routing, but they register the same tool object in both the executor registry and node-local tools, so they do not prove that a distinct flow-local definition wins on collision. — Why it fails: future changes could accidentally revert to registry-first execution or expose one schema to the model while executing another, and the current tests would still pass because local and registry defs are identical. — Fix: add text and voice tests with the same tool name but different local/registry schemas/executors; assert the provider sees the local schema and the executor runs the local implementation.

5. `packages/kuralle-livekit-plugin-transport-sip/test/sip_signaling_udp_integration.test.ts:41` — **medium** — [axis: correctness] — `getFreeUdpPort()` still uses probe-then-release for the SIP server port. — Why it fails: binding UDP port 0 and closing the socket proves only that the port was free at probe time; another concurrent process can bind it before `SIPSignaling.start()` runs. The change improves on the old pid/random scheme, but it does not eliminate the race under parallel test runners. — Fix: let `SIPSignaling` accept `sipPort: 0` and expose the actual bound port, or keep the reservation socket alive until the server bind handoff.

## Deterministic Gates

| Command | Result | Evidence |
|---|---:|---|
| `bun run build:packages` | pass | Ended with `✓ all packages built (ordered)`; no `error TS` in output. |
| `bun run typecheck:all` | pass | Ended framework sweep with `✓ typecheck:all green`, playground sweep with `✓ typecheck:playground green`, then ESLint exited 0. |
| `bun run --filter '@kuralle-agents/core' test` | pass | `362 pass`, `0 fail`, `534 expect() calls`, `Ran 362 tests across 50 files`. |
| `bun run check:no-source-maps` | pass | `✓ no source maps or raw src in any publishable package tarball`. |
| `gh repo view --json nameWithOwner,defaultBranchRef,isPrivate,url && gh pr status` | pass | Repo is `kuralle/kuralle-agents`, private, default branch `main`; no current PR. |

Context7 check: resolved Vercel AI SDK docs as `/vercel/ai`; the manual agent-loop docs show the expected pattern of reading `result.toolCalls` after `finishReason === 'tool-calls'` and appending a `role: 'tool'` message with `toolCallId`, `toolName`, and `output`. The current `TextDriver` follows that shape at `TextDriver.ts:85-142`.

## Live Example Coherence

| Example | Model/provider | Ran? | Coherent? | Evidence |
|---|---|---:|---:|---|
| `packages/kuralle-core/examples/flows/food-ordering-direct-functions.ts` with `GOOGLE_GENERATIVE_AI_API_KEY= XAI_API_KEY=` | `openai:gpt-4o-mini` | y | n | Failed before first model reply: `AI_APICallError ... 401 invalid_api_key`. |
| `packages/kuralle-core/examples/flows/food-ordering-direct-functions.ts` default env | `google:gemini-2.0-flash` | y | n | Local tools worked (`choose_sushi`, `select_sushi_order`, `get_delivery_estimate`), but final `Looks good` did not call `complete_order`; assistant replied: `Is that all correct, or would you like to make any changes?` and no terminal transition occurred. |
| `packages/kuralle-core/examples/flows/restaurant-reservation-direct-functions.ts` default env | `google:gemini-2.0-flash` | y | n | First turns were coherent (`How many people...`, `[Tool call] collect_party_size`), then failed after retries with `AI_RetryError ... 429 Resource exhausted`. |
| `packages/kuralle-core/examples/flows/food-ordering.ts` default env | `google:gemini-2.0-flash` | y | n | Entered `order/kitchen_check/initial`, then failed before first assistant response with `AI_RetryError ... 429 Resource exhausted`. |
| `packages/kuralle-core/examples/flows/restaurant-reservation.ts` default env | `google:gemini-2.0-flash` | y | n | Coherent through local tools and transitions: `collect_party_size`, `check_availability`, `get_time -> no_availability -> confirm`; then final turn failed with `AI_RetryError ... 429 Resource exhausted`. |
| `packages/kuralle-core/examples/agents/basic-chat.ts` default env | `google:gemini-2.0-flash` | y | n | Failed on first turn after retries with `AI_RetryError ... 429 Resource exhausted`. |

I stopped live runs after repeated Google 429s and the OpenAI 401, per the budget note. I did not run `agents/chat-supervisor.ts` or `agents/form-filler.ts` because the provider failures were already deterministic enough to make more live calls low value.

## Verdict

**Not ready to go public.**

Ranked blockers:

1. Live examples are not currently a reliable public verification path: the runner cannot explicitly select a provider, OpenAI is 401 in this environment, and Google is rate-limiting.
2. At least one high-priority flow-local-tool example exercised the tools but did not complete coherently; the runner masked that by printing `Run complete.` without a terminal assertion.
3. Same-name local tool shadowing is now the intended architecture, but it is silent and untested for distinct local-vs-registry definitions.
4. SIP UDP test hardening reduced entropy collisions but still retains a probe/release port race.
