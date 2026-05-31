import type { ModelMessage } from 'ai';
import type { ChannelDriver, TurnResult } from '../types/channel.js';
import type { CollectNode } from '../types/flow.js';
import type { RunContext } from '../types/run-context.js';
import type { RunState } from '../runtime/durable/types.js';
import { hasPendingUserInput } from '../runtime/channels/inputBuffer.js';
import { resolveCollectExtractionNode } from './nodeBuilders.js';
import {
  computeMissingFields,
  createExtractionSubmitTool,
  getCollectData,
  incrementCollectTurns,
  mergeTurnExtraction,
  projectCollectData,
  schemaSatisfied,
} from './extraction.js';
import { normalizeTransition } from './normalizeTransition.js';
import type { NormalizedTransition } from './normalizeTransition.js';

function appendAssistantMessage(run: RunState, text: string): void {
  if (!text.trim()) {
    return;
  }
  const message: ModelMessage = { role: 'assistant', content: text };
  run.messages = [...run.messages, message];
}

function appendUserMessage(run: RunState, input: string): void {
  const message: ModelMessage = { role: 'user', content: input };
  run.messages = [...run.messages, message];
}

export async function collectUntilComplete(
  node: CollectNode,
  run: RunState,
  driver: ChannelDriver,
  ctx: RunContext,
): Promise<NormalizedTransition> {
  for (;;) {
    if (schemaSatisfied(node, run.state)) {
      const data = projectCollectData(node, run.state);
      return normalizeTransition(await node.onComplete(data, run.state));
    }

    const turns = incrementCollectTurns(run.state, node.id);
    const maxTurns = node.maxTurns ?? 10;
    if (turns > maxTurns) {
      const data = projectCollectData(node, run.state);
      return normalizeTransition(await node.onComplete(data, run.state));
    }

    const missing = computeMissingFields(node, getCollectData(run.state, node.id));
    const submitTool = createExtractionSubmitTool(node, missing, {
      userMessage: peekLatestUserMessage(run),
    });
    const resolved = resolveCollectExtractionNode(node, missing, run.state, submitTool);
    const turn = await driver.runAgentTurn(resolved, ctx);
    mergeExtractionFromTurn(node, run, turn);
    appendAssistantMessage(run, turn.text);

    if (schemaSatisfied(node, run.state)) {
      continue;
    }

    if (!hasPendingUserInput(ctx.session)) {
      return { kind: 'stay' };
    }

    const signal = await driver.awaitUser(ctx);
    appendUserMessage(run, signal.input);
  }
}

function mergeExtractionFromTurn(node: CollectNode, run: RunState, turn: TurnResult): void {
  mergeTurnExtraction(
    node,
    run.state,
    turn.toolResults.map((record) => ({ name: record.name, result: record.result })),
  );
}

function peekLatestUserMessage(run: RunState): string | undefined {
  for (let i = run.messages.length - 1; i >= 0; i -= 1) {
    const message = run.messages[i];
    if (message?.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return undefined;
}
