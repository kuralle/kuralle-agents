import type { ToolSet } from 'ai';
import type { Instructions } from '../types/agentConfig.js';
import type { FlowState, ReplyNode, CollectNode } from '../types/flow.js';
import type { ResolvedNode } from '../types/channel.js';
import type { Tool } from '../types/effectTool.js';
import { buildToolSet } from '../tools/effect/defineTool.js';

export function resolveInstructions(instructions: Instructions, state: FlowState): string {
  if (typeof instructions === 'string') {
    return instructions;
  }
  if (typeof instructions === 'function') {
    const result = instructions({ state });
    if (typeof result === 'string') {
      return result;
    }
    throw new Error('Reply node instructions function must return a string synchronously');
  }
  throw new Error('Reply node instructions must be a string or sync function in TextDriver');
}

export function buildNodePrompt(node: ReplyNode, state: FlowState): string {
  return resolveInstructions(node.instructions, state);
}

export function buildNodeTools(node: ReplyNode, state: FlowState): ToolSet {
  if (!node.tools) {
    return {};
  }
  if (typeof node.tools === 'function') {
    return node.tools(state);
  }
  return node.tools;
}

export function resolveReplyNode(node: ReplyNode, state: FlowState): ResolvedNode {
  const tools = buildNodeTools(node, state);
  return {
    node,
    prompt: buildNodePrompt(node, state),
    tools,
  };
}

export function resolveCollectExtractionNode(
  collectNode: CollectNode,
  missing: string[],
  state: FlowState,
  submitTool: Tool,
): ResolvedNode {
  const instructions =
    collectNode.instructions?.(missing, state) ??
    defaultCollectInstructions(collectNode.id, missing);
  const replyNode: ReplyNode = {
    kind: 'reply',
    id: `${collectNode.id}__extract`,
    instructions,
  };

  return {
    node: replyNode,
    prompt: resolveInstructions(instructions, state),
    tools: buildToolSet({ [submitTool.name]: submitTool }),
    localTools: { [submitTool.name]: submitTool },
  };
}

function defaultCollectInstructions(nodeId: string, missing: string[]): string {
  const missingText = missing.length > 0 ? missing.join(', ') : 'none';
  return (
    `You are collecting information for step "${nodeId}". ` +
    `Missing fields: ${missingText}. ` +
    `Ask for one missing field at a time. When the user provides a value, call submit_${slugify(nodeId)}_data with the extracted fields.`
  );
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}
