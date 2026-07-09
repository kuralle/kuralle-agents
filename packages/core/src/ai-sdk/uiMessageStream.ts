import {
  createUIMessageStream,
  generateId,
  type UIMessage,
  type UIMessageStreamWriter,
} from 'ai';
import type { ConversationOutcome } from '../outcomes/types.js';
import type { ChoiceOption } from '../types/selection.js';
import type { HarnessStreamPart } from '../types/stream.js';

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
  'kuralle-control': { event: 'interrupted' | 'paused'; reason?: string; waitingFor?: string };
  'kuralle-custom': { name: string; data: unknown };
};

export type KuralleUIMessage = UIMessage<KuralleMetadata, KuralleDataParts>;

function writeHarnessPart(
  part: HarnessStreamPart,
  writer: UIMessageStreamWriter<KuralleUIMessage>,
): void {
  switch (part.type) {
    case 'text-start':
      writer.write({ type: 'text-start', id: part.id });
      break;
    case 'text-delta':
      writer.write({ type: 'text-delta', id: part.id, delta: part.delta });
      break;
    case 'text-end':
      writer.write({ type: 'text-end', id: part.id });
      break;
    case 'text-cancel':
      writer.write({ type: 'text-end', id: part.id });
      break;
    case 'tool-call':
      writer.write({
        type: 'tool-input-available',
        toolCallId: part.toolCallId ?? generateId(),
        toolName: part.toolName,
        input: part.args,
      });
      break;
    case 'tool-result':
      writer.write({
        type: 'tool-output-available',
        toolCallId: part.toolCallId ?? 'unknown',
        output: part.result,
      });
      break;
    case 'node-enter':
      writer.write({
        type: 'data-kuralle-node',
        data: { event: 'enter', node: part.nodeName },
        transient: true,
      });
      break;
    case 'node-exit':
      writer.write({
        type: 'data-kuralle-node',
        data: { event: 'exit', node: part.nodeName },
        transient: true,
      });
      break;
    case 'flow-enter':
      writer.write({
        type: 'data-kuralle-flow',
        data: { event: 'enter', flow: part.flow },
        transient: true,
      });
      break;
    case 'flow-end':
      writer.write({
        type: 'data-kuralle-flow',
        data: { event: 'end', flow: part.flow, reason: part.reason },
        transient: true,
      });
      break;
    case 'flow-transition':
      writer.write({
        type: 'data-kuralle-flow',
        data: { event: 'transition', from: part.from, to: part.to },
        transient: true,
      });
      break;
    case 'handoff':
      writer.write({
        type: 'data-kuralle-handoff',
        id: generateId(),
        data: { targetAgent: part.targetAgent, reason: part.reason },
      });
      break;
    case 'interactive':
      writer.write({
        type: 'data-kuralle-interactive',
        id: part.nodeId,
        data: { nodeId: part.nodeId, prompt: part.prompt, options: part.options },
      });
      break;
    case 'safety-blocked':
      writer.write({
        type: 'data-kuralle-safety',
        id: generateId(),
        data: {
          kind: 'safety-blocked',
          moderator: part.moderator,
          rationale: part.rationale,
          userFacingMessage: part.userFacingMessage,
        },
      });
      break;
    case 'pipeline-validation-block':
      writer.write({
        type: 'data-kuralle-safety',
        id: generateId(),
        data: {
          kind: 'pipeline-validation-block',
          rationale: part.rationale,
          userFacingMessage: part.userFacingMessage,
        },
      });
      break;
    case 'conversation-outcome':
      writer.write({
        type: 'data-kuralle-outcome',
        id: generateId(),
        data: { outcome: part.outcome },
      });
      break;
    case 'interrupted':
      writer.write({
        type: 'data-kuralle-control',
        data: { event: 'interrupted', reason: part.reason },
        transient: true,
      });
      break;
    case 'paused':
      writer.write({
        type: 'data-kuralle-control',
        data: { event: 'paused', waitingFor: part.waitingFor },
        transient: true,
      });
      break;
    case 'custom':
      writer.write({
        type: 'data-kuralle-custom',
        data: { name: part.name, data: part.data },
        transient: true,
      });
      break;
    case 'error':
      throw new Error(part.error);
    case 'done':
    case 'turn-end':
      break;
  }
}

export function harnessToUIMessageStream(
  source: AsyncIterable<HarnessStreamPart>,
  opts?: { sessionId?: string },
): ReadableStream {
  return createUIMessageStream<KuralleUIMessage>({
    execute: async ({ writer }) => {
      let doneSessionId = opts?.sessionId;

      if (doneSessionId) {
        writer.write({
          type: 'start',
          messageMetadata: { sessionId: doneSessionId },
        });
      }

      for await (const part of source) {
        if (part.type === 'done' && part.sessionId) {
          doneSessionId = doneSessionId ?? part.sessionId;
        } else {
          writeHarnessPart(part, writer);
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
