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

    // Acquire THIS turn's fresh input before extracting. If input is pending,
    // consume it so extraction reads the user's actual reply. If nothing is
    // pending AND the turn's input was already consumed by a prior node, pause:
    // the prompt was presented on node-enter, so await the next turn rather than
    // running extraction over stale history (which makes the model fabricate
    // required fields). On the run's first input-node the turn's input is in
    // `messages` with nothing pending and `turnInputConsumed` false, so we fall
    // through and extract it.
    if (hasPendingUserInput(ctx.session)) {
      const signal = await driver.awaitUser(ctx);
      appendUserMessage(run, signal.input);
    } else if (ctx.turnInputConsumed) {
      // No fresh input to extract this turn: ask (deterministically) for the
      // fields still missing and wait. Never run extraction over stale context.
      emitCollectAsk(node, run, ctx);
      return { kind: 'stay' };
    }
    ctx.turnInputConsumed = true;

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
    // Non-speaking extraction: the model's prose is DISCARDED (never emitted or
    // appended), so a collect turn cannot author narration that contradicts flow
    // state. Falls back to runAgentTurn for drivers without runExtraction; its
    // text is likewise dropped here. The user-facing question is the deterministic
    // `ask` emitted above — never model-authored.
    const turn = await (driver.runExtraction
      ? driver.runExtraction(resolved, ctx)
      : driver.runAgentTurn(resolved, ctx));
    mergeExtractionFromTurn(node, run, turn);
  }
}

function humanizeField(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Deterministic, framework-authored question for the still-missing fields. Uses
 *  the node's `ask` when provided, else a safe default that never references a
 *  downstream outcome (order/delivery/payment/website). */
function renderCollectAsk(node: CollectNode, missing: string[], state: RunState['state']): string {
  if (node.ask) {
    return node.ask(missing, state);
  }
  if (missing.length === 1) {
    return `Could you share your ${humanizeField(missing[0]!)}?`;
  }
  if (missing.length > 1) {
    return `Could you share: ${missing.map(humanizeField).join(', ')}?`;
  }
  return 'Could you tell me a little more?';
}

function emitCollectAsk(node: CollectNode, run: RunState, ctx: RunContext): void {
  const missing = computeMissingFields(node, getCollectData(run.state, node.id));
  const text = renderCollectAsk(node, missing, run.state);
  if (!text.trim()) {
    return;
  }
  ctx.emit({ type: 'text-delta', text });
  ctx.emit({ type: 'turn-end' });
  appendAssistantMessage(run, text);
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
