# Pharmacy Rx Agent (Cloudflare Durable Objects)

A WhatsApp-style pharmacy ordering agent that demonstrates the two platform features
end-to-end: **multimodal intake** (a prescription image) and **durable human-in-the-loop
checkout** (a payment link that resumes the conversation). One Durable Object per chat
thread → multi-tenant isolation + persistent cart/history.

See [`WBS.md`](./WBS.md) for the full plan and current status.

## Flow

1. Customer sends a message + prescription image.
2. The model (vision) reads the prescription, calls `check_inventory` per medicine, and
   reports what's in stock + price; answers follow-up questions; manages a persistent cart.
3. On purchase confirmation, the `checkout` action mints a payment link and **suspends** on
   the durable `payment` signal.
4. Hitting `GET /pay/<token>` delivers the signal to the exact DO (`idFromString`), which
   **resumes** the run, finalizes the order, and broadcasts "✅ order completed" to the
   client (and persists it for reconnecting clients). Closing the chat mid-flow is safe —
   state lives in the DO.

## Layout

- `src/index.ts` — Worker entry: `PharmacyAgent extends KuralleAgent`, `routeAgentRequest`, and the `/pay/:token` route.
- `src/pharmacy.ts` — flow (`assist → checkout → orderComplete`), cart, and global tools.
- `src/inventory.ts` — demo inventory + matcher.
- `src/token.ts` — checkout-token codec (demo-grade base64url; sign it in prod).
- `tools/live-chat.ts` — WS harness to drive a live chat turn.

## Deploy

```bash
cd apps/playground/pharmacy-rx-agent
wrangler secret put OPENAI_API_KEY          # vision-capable model key
wrangler deploy
# then set PUBLIC_URL in wrangler.jsonc to the deployed URL (for clickable links) and redeploy
```

Deployed: `https://pharmacy-rx-agent.mithushancj.workers.dev`.

## Test (once the dep skew below is fixed)

```bash
# multimodal intake + inventory
bun run tools/live-chat.ts tenant-A "Here's my Rx. I need Amoxicillin 500mg + Metformin 500mg." <imageUrl>
# follow-up + checkout in the same thread, then hit the emitted /pay/<token> link
```

## ⚠️ Known blocker (pre-existing in `@kuralle-agents/cf-agent`)

The CF chat path currently throws server-side:
`TypeError: this.mcp.ensureJsonSchema is not a function` in `AIChatAgent.onMessage`.

Cause: `@cloudflare/ai-chat@0.1.9` peers `agents@^0.7.6`, but the repo resolves
`agents@0.11.5` (peer unmet; the method is absent). Fix: align cf-agent to
`@cloudflare/ai-chat@^0.8.x` + `agents@>=0.14` (the latest matched pairing) and re-verify
the cf-agent voice examples. The Worker deploys and routes fine; only the chat `onMessage`
path is affected.
