import type { ToolSet } from 'ai';
import type { Instructions } from '../types/agentConfig.js';
import type { FlowState, ReplyNode, CollectNode } from '../types/flow.js';
import type { ResolvedNode } from '../types/channel.js';
import type { Tool } from '../types/effectTool.js';
import { buildToolSet, rawToolsFromSet } from '../tools/effect/defineTool.js';

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

/** Compose the agent base layer (ADR 0001) into a node's system prompt: the
 *  agent's base instructions (persona / safety / grounding) prefix the node's
 *  own instructions. Node instructions layer ON TOP — they never replace the
 *  base. Base resolves against the current state so dynamic base prompts work. */
export function composeSystem(
  base: Instructions | undefined,
  nodeSystem: string,
  state: FlowState,
): string {
  const baseText = base ? resolveInstructions(base, state) : '';
  return [baseText, nodeSystem].filter((s) => s && s.trim()).join('\n\n');
}

function buildNodeTools(node: ReplyNode, state: FlowState): ToolSet {
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
    // Recover the raw executors from the node's `buildToolSet` tools so they run
    // in-flow (with run context) — without also needing `agent.effectTools`.
    localTools: rawToolsFromSet(tools),
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
