import {
  createUIMessageStream,
  type UIMessage,
  type UIMessageStreamWriter,
} from 'ai';
import type { ConversationOutcome } from '../outcomes/types.js';
import type { ChoiceOption } from '../types/selection.js';
import type { StreamPart, StreamPartBase } from '../types/stream.js';

export type KuralleMetadata = { sessionId?: string };

export type KuralleDataParts = {
  'kuralle-node': { event: 'enter' | 'exit'; node: string };
  'kuralle-flow': {
    event: 'enter' | 'transition' | 'end';
    flow?: string;
    from?: string;
    to?: string;
    reason?: string;
  };
  'kuralle-handoff': { targetAgent: string; reason?: string };
  'kuralle-interactive': { nodeId: string; prompt: string; options: ChoiceOption[] };
  'kuralle-safety': {
    kind: 'safety-blocked' | 'pipeline-validation-block';
    moderator?: string;
    rationale: string;
    userFacingMessage?: string;
  };
  'kuralle-outcome': { outcome: ConversationOutcome };
  'kuralle-control': {
    event: 'interrupted' | 'paused';
    reason?: string;
    waitingFor?: string;
    interrupt?: import('../types/stream.js').HitlInterrupt;
  };
  'kuralle-custom': { name: string; data: unknown };
};

export type KuralleUIMessage = UIMessage<KuralleMetadata, KuralleDataParts>;

/** An error that the harness has explicitly classified for client delivery. */
class ClientStreamError extends Error {}

/**
 * Stable, per-turn ids for the data parts that persist into message history.
 *
 * These ids are not decoration — clients reconcile on `(type, id)`. Cloudflare's
 * `applyChunkToParts` updates a part in place when both match and appends a new
 * one when they do not, and the AI SDK's own client does the same. A random id
 * therefore means "always append", so a turn that is re-emitted into an existing
 * message — Cloudflare's chat recovery re-runs `onChatMessage` and appends to
 * the same assistant message — duplicates every handoff, safety block and
 * outcome it had already recorded.
 *
 * Counting per type per stream gives the ordinal of the event within the turn,
 * which is exactly the identity reconciliation wants: the second safety block of
 * a turn is the same logical part on every attempt at that turn.
 */
function createIdSequence(): (kind: string) => string {
  const counts = new Map<string, number>();
  return kind => {
    const next = counts.get(kind) ?? 0;
    counts.set(kind, next + 1);
    return `${kind}-${next}`;
  };
}

function writeHarnessPart(
  part: StreamPart,
  writer: UIMessageStreamWriter<KuralleUIMessage>,
  nextId: (kind: string) => string,
): void {
  switch (part.type) {
    case 'text-start':
      writer.write({ type: 'text-start', id: part.payload.id });
      break;
    case 'text-delta':
      writer.write({ type: 'text-delta', id: part.payload.id, delta: part.payload.delta });
      break;
    case 'text-end':
      writer.write({ type: 'text-end', id: part.payload.id });
      break;
    case 'text-cancel':
      writer.write({ type: 'text-end', id: part.payload.id });
      break;
    case 'tool-call':
      writer.write({
        type: 'tool-input-available',
        // Same reasoning as the data-part ids: a random fallback id appends a
        // duplicate tool part on a re-emitted turn. (It stays unpaired with the
        // `tool-result` fallback below, which is a pre-existing gap in the
        // degenerate case where the harness emitted no toolCallId at all.)
        toolCallId: part.payload.toolCallId ?? nextId('tool'),
        toolName: part.payload.toolName,
        input: part.payload.args,
      });
      break;
    case 'tool-result':
      writer.write({
        type: 'tool-output-available',
        toolCallId: part.payload.toolCallId ?? 'unknown',
        output: part.payload.result,
      });
      break;
    case 'node-enter':
      writer.write({
        type: 'data-kuralle-node',
        data: { event: 'enter', node: part.payload.nodeName },
        transient: true,
      });
      break;
    case 'node-exit':
      writer.write({
        type: 'data-kuralle-node',
        data: { event: 'exit', node: part.payload.nodeName },
        transient: true,
      });
      break;
    case 'flow-enter':
      writer.write({
        type: 'data-kuralle-flow',
        data: { event: 'enter', flow: part.payload.flow },
        transient: true,
      });
      break;
    case 'flow-end':
      writer.write({
        type: 'data-kuralle-flow',
        data: { event: 'end', flow: part.payload.flow, reason: part.payload.reason },
        transient: true,
      });
      break;
    case 'flow-transition':
      writer.write({
        type: 'data-kuralle-flow',
        data: { event: 'transition', from: part.payload.from, to: part.payload.to },
        transient: true,
      });
      break;
    case 'handoff':
      writer.write({
        type: 'data-kuralle-handoff',
        id: nextId('handoff'),
        data: { targetAgent: part.payload.targetAgent, reason: part.payload.reason },
      });
      break;
    case 'interactive':
      writer.write({
        type: 'data-kuralle-interactive',
        id: part.payload.nodeId,
        data: {
          nodeId: part.payload.nodeId,
          prompt: part.payload.prompt,
          options: part.payload.options,
        },
      });
      break;
    case 'safety-blocked':
      writer.write({
        type: 'data-kuralle-safety',
        id: nextId('safety'),
        data: {
          kind: 'safety-blocked',
          moderator: part.payload.moderator,
          rationale: part.payload.rationale,
          userFacingMessage: part.payload.userFacingMessage,
        },
      });
      break;
    case 'pipeline-validation-block':
      writer.write({
        type: 'data-kuralle-safety',
        id: nextId('safety'),
        data: {
          kind: 'pipeline-validation-block',
          rationale: part.payload.rationale,
          userFacingMessage: part.payload.userFacingMessage,
        },
      });
      break;
    case 'conversation-outcome':
      writer.write({
        type: 'data-kuralle-outcome',
        id: nextId('outcome'),
        data: { outcome: part.payload.outcome },
      });
      break;
    case 'interrupted':
      writer.write({
        type: 'data-kuralle-control',
        data: { event: 'interrupted', reason: part.payload.reason },
        transient: true,
      });
      break;
    case 'paused':
      writer.write({
        type: 'data-kuralle-control',
        data: {
          event: 'paused',
          waitingFor: part.payload.waitingFor,
          interrupt: part.payload.interrupt,
        },
        transient: true,
      });
      break;
    case 'custom':
      writer.write({
        type: 'data-kuralle-custom',
        data: { name: part.payload.name, data: part.payload.data },
        transient: true,
      });
      break;
    case 'error':
      throw new ClientStreamError(part.payload.error);
    case 'done':
    case 'turn-end':
      break;
    default: {
      // Client-channel exhaustiveness guard. Internal-channel parts are
      // deliberately unmapped here — they never reach a UI client. But a new
      // `client` variant added without a case above would be silently dropped
      // on the default output path, so pin the residual to internal:
      // adding a client variant without a case fails this assignment.
      const _internalOnly: StreamPartBase<'internal'> = part;
      void _internalOnly;
    }
  }
}

export function harnessToUIMessageStream(
  source: AsyncIterable<StreamPart>,
  opts?: { sessionId?: string },
): ReadableStream {
  return createUIMessageStream<KuralleUIMessage>({
    // AI SDK deliberately redacts thrown errors by default. Preserve the
    // harness's explicit client error contract without leaking unexpected
    // iterator, adapter, or implementation failures.
    onError: (error) =>
      error instanceof ClientStreamError ? error.message : 'An error occurred.',
    execute: async ({ writer }) => {
      const nextId = createIdSequence();
      let doneSessionId = opts?.sessionId;

      if (doneSessionId) {
        writer.write({
          type: 'start',
          messageMetadata: { sessionId: doneSessionId },
        });
      }

      for await (const part of source) {
        if (part.type === 'done' && part.payload.sessionId) {
          doneSessionId = doneSessionId ?? part.payload.sessionId;
        } else {
          writeHarnessPart(part, writer, nextId);
        }
      }

      if (doneSessionId) {
        writer.write({
          type: 'finish',
          messageMetadata: { sessionId: doneSessionId },
        });
      }
    },
  });
}
