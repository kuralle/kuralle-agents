# Prompt-cache validation (0.7.2)

Live validation that the 0.7.2 provider-prompt-cache wiring (`applyPromptCache`) produces
**real cache hits**, not just that the option is set. Run from the repo root (keys read from `.env`).

```bash
node packages/e2e-tests/validate-prompt-cache.mjs    # OpenAI (via shipped applyPromptCache)
node packages/e2e-tests/validate-gemini-cache.mjs    # Gemini implicit caching (REST, provider-level)
```

Both send a large (>1024/2048-token) **stable system prefix** repeatedly with a per-session key and
read the provider's cached-token count from usage.

## Results

| Provider | Wired in kuralle? | Live result | Notes |
|---|---|---|---|
| **OpenAI** (`gpt-4o-mini`) | ✅ `promptCacheKey` + `truncation: auto` | ✅ **HIT** — turn 1 `cacheReadTokens=0`, turns 2–4 `=10240` (≈99% of an 10,377-token prompt) | Proven through the shipped `applyPromptCache` helper. Cached input bills ~50% → ~half the input cost on repeat turns. |
| **Anthropic** (Claude) | ✅ `cache_control` ephemeral breakpoints | ⚠️ wired + unit-tested, **not live-validated** | No `ANTHROPIC_API_KEY` in env. Anthropic caching is opt-in, so this was 0% before 0.7.2 — the bigger theoretical win. Add a key + rerun `validate-prompt-cache.mjs` against a Claude model to confirm. |
| **Gemini** (`gemini-2.5-flash`) | ➖ nothing (implicit caching needs no param) | ⚠️ **MISS** — 4 back-to-back turns, 11,137-token prefix, `cachedContentTokenCount=0` every time | Implicit caching is default-on for 2.5+ but **best-effort/not-guaranteed** — it did not fire here. For *guaranteed* Gemini caching you need **explicit** `CachedContent` (a stateful cache object + TTL), which kuralle does **not** wire. Open follow-up. |

## Cloudflare AI Gateway (how it composes)

Two independent layers:
1. **Gateway response cache** — off by default, enabled via `cf-aig-cache-ttl`, **byte-identical match only**
   (any change to messages/tools/params = separate entry). Rarely hits for a stateful multi-turn agent.
   Status via `cf-aig-cache-status: HIT|MISS`.
2. **Provider prompt cache** (the 0.7.2 wiring) — keyed on the stable prefix at the provider; rides
   **through** the gateway because `promptCacheKey`/`cache_control` are request-body fields the proxy
   forwards, and `cached_tokens` come back in the response. You can see gateway `MISS` + provider
   `cached_tokens > 0` on the same request — different layers.

Caveat: the gateway pass-through is inferred from the transparent-proxy model (CF docs don't document it
explicitly); not yet validated live against a configured AI Gateway endpoint.
