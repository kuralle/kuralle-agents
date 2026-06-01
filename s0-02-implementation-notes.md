# S0-02 implementation notes (A0.1)

## Decisions

- **`customerId` required on `InboundMessage`:** Enforces REQ-19 at compile time. All three Meta `toInboundMessage` producers and test fixtures set `customerId = msg.from` (wa_id / PSID).
- **Session ID = `threadId`:** Meta clients already emit platform-scoped thread IDs (`whatsapp:{phoneNumberId}:{from}`). Prefixing again in `defaultSessionResolver` produced `whatsapp:whatsapp:…`. `ThreadIdResolver` in the chain plugin was left unchanged (historical `{platform}:{threadId}` for bare thread IDs).
- **`parseNfmReply`:** Module-local in `whatsapp/client.ts`; malformed or non-object JSON → `undefined`, no throw.

## Out-of-scope producers

Repo-wide grep found **no** `InboundMessage` producers outside `kuralle-messaging-meta` (WA/Messenger/Instagram + test stub). `ThreadIdResolver` still double-prefixes by design for legacy bare thread IDs.

## Trade-offs

- Required `customerId` forces a compile-time cascade across test fixtures; optional would weaken REQ-19.
- `nfm_reply` tests use a subclass harness calling protected `toInboundMessage` rather than full webhook payloads — faster and targets the mapping contract directly.
