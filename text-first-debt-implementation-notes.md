# Text-first debt cleanup — implementation notes

## Assumptions

- The canonical public stream contract is `packages/core/src/types/stream.ts`; the shadow union in `types/voice.ts` is removed rather than re-exported or adapted.
- `StreamChannel` remains exactly `'client' | 'internal'` because every currently emitted event fits one of those audiences; replay and provenance remain separate RFC work.
- Existing uncommitted Plan Desk configuration changes are user-owned and remain untouched.

## Decisions and deviations

- RFC 0002 classifies `knowledge-citation` as a live client stream event, but the current source only records it as a `ConversationAuditEntry`; no stream emitter exists. The type remains in scope because REQ-5 explicitly requires its client classification, without inventing a new emitter.
- RFC 0002 V5 says nine SAFE types remain, while applying §4 exactly deletes `knowledge-no-results` and the three documented phantoms, leaving eight client types: four text lifecycle events, `conversation-outcome`, `knowledge-citation`, `error`, and `done`. The implementation follows the explicit §4 disposition.

## Root causes

- The `/types` barrel used wildcard re-exports, allowing a second same-named stream union to become public without an explicit API decision.
- `AgentStreamPart` was a third, narrower hook-only stream union. It had no runtime owner or caller and is deleted; the hook now observes the canonical `StreamPart`.
- Several dist-based JavaScript tests bypassed TypeScript and continued constructing the removed flat shape. They now exercise the same behavior with canonical envelopes, and the public narrowing test covers the package export seam.
