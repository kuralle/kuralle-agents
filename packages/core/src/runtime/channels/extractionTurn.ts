import type { LanguageModel, ModelMessage } from 'ai';
import type { ResolvedNode, TurnResult } from '../../types/channel.js';
import type { RunContext } from '../../types/run-context.js';
import type { ReplyNode } from '../../types/flow.js';
import type { AnyTool } from '../../types/effectTool.js';
import { buildNodePrompt, composeSystem } from '../../flow/nodeBuilders.js';
import { systemNoteBlocks } from '../systemNotes.js';
import { resolveNodeTools } from './resolveNodeTools.js';
import { currentFlowState } from '../../flow/flowState.js';
import { AiSdkModelTurnLoop } from './AiSdkModelTurnLoop.js';
import {
  applyModelTurnLoopState,
  createModelTurnLoopState,
  type ModelTurnLoop,
} from './ModelTurnLoop.js';

/**
 * Shared non-speaking field extraction for collect nodes. The same model-loop
 * SPI as replies is used, but model prose is discarded by construction and
 * the flow engine remains the only author of the user-facing question.
 */
export async function runSilentExtraction(
  node: ResolvedNode,
  ctx: RunContext,
  model: LanguageModel,
  maxSteps: number,
  agentToolDefs: Record<string, AnyTool> = {},
  modelLoop: ModelTurnLoop = new AiSdkModelTurnLoop(),
): Promise<TurnResult> {
  const replyNode = node.node as ReplyNode;
  const state = currentFlowState(ctx.runState);
  const nodeSystem = node.prompt || buildNodePrompt(replyNode, state);
  const stableSystem = composeSystem(
    ctx.baseInstructions,
    nodeSystem,
    state,
    ctx.skillPrompt,
    ctx.workingMemoryPrompt,
  );
  const loopState = createModelTurnLoopState();
  let inspectedResults = 0;

  await modelLoop.run(
    {
      purpose: 'extraction',
      node,
      ctx,
      model,
      messages: [...ctx.runState.messages] as ModelMessage[],
      system: stableSystem,
      volatileSystemBlocks: systemNoteBlocks(ctx.runState),
      tools: resolveNodeTools(node, ctx, agentToolDefs),
      maxSteps,
      temperature: 0,
      async stopAfterToolResults(current) {
        const recent = current.toolResults.slice(inspectedResults);
        inspectedResults = current.toolResults.length;
        const submitCalls = recent.filter(
          (result) => result.name.startsWith('submit_') && result.name.endsWith('_data'),
        );
        if (submitCalls.length === 0) return false;
        const anyFailed = submitCalls.some((result) => {
          const record = current.toolCallsMade.find((call) => call.toolCallId === result.toolCallId);
          return record?.success === false;
        });
        return !anyFailed && (await node.extractionSatisfied?.(current.toolResults) ?? false);
      },
    },
    loopState,
    () => {
      // Silent by contract: collect questions are emitted by the flow engine.
    },
  );

  const out: TurnResult = { text: '', toolResults: [] };
  applyModelTurnLoopState(out, loopState);
  return out;
}
