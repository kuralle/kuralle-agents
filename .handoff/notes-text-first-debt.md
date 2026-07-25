# Text-first debt cleanup — implementation notes

## Assumptions

- The canonical public stream contract is `packages/core/src/types/stream.ts`; the shadow union in `types/voice.ts` is removed rather than re-exported or adapted.
- `StreamChannel` remains exactly `'client' | 'internal'` because every currently emitted event fits one of those audiences; replay and provenance remain separate RFC work.
- Existing uncommitted Plan Desk configuration changes are user-owned and remain untouched.

## Decisions and deviations

- RFC 0002 classifies `knowledge-citation` as a live client stream event, but the current source only records it as a `ConversationAuditEntry`; no stream emitter exists. The type remains in scope because REQ-5 explicitly requires its client classification, without inventing a new emitter.
- RFC 0002 V5 says nine SAFE types remain, while applying §4 exactly deletes `knowledge-no-results` and the three documented phantoms, leaving eight client types: four text lifecycle events, `conversation-outcome`, `knowledge-citation`, `error`, and `done`. The implementation follows the explicit §4 disposition.
- ADR-0015 keeps processors, semantic capabilities, and lifecycle hooks distinct, with fixed phase ordering instead of a user-orderable middleware stack. RFC-0001 now discovers one agent `policies.ts`; project `hooks.ts` targets the five-method `Hooks` contract actually used by `Runtime`.
- The 19-method `HarnessHooks` interface belongs to the older `createFoundation`/`HookRunner` surface and is not the contract behind `HarnessConfig.hooks`. It is explicitly excluded from the file convention rather than represented as working runtime middleware.
- `fsSkillStore` keeps `['/skills']` as its default but replaces the options object with an ordered root array. Resolution rebuilds from the filesystem on each store operation, so runtime skill edits remain visible; later roots own metadata, body, and resources on name collision.
- ADR-0005 governs HTTP `UIMessageStream` output, not direct `Runtime.run().events`. The skipped flow/triage test was actually stale because its driver always returned substantive text, which correctly suppresses the answer-first host guard. Its driver now exercises empty-answer routing and asserts the canonical `StreamPart` events, including `flow-enter`.

## Root causes

- The `/types` barrel used wildcard re-exports, allowing a second same-named stream union to become public without an explicit API decision.
- `AgentStreamPart` was a third, narrower hook-only stream union. It had no runtime owner or caller and is deleted; the hook now observes the canonical `StreamPart`.
- Several dist-based JavaScript tests bypassed TypeScript and continued constructing the removed flat shape. They now exercise the same behavior with canonical envelopes, and the public narrowing test covers the package export seam.
