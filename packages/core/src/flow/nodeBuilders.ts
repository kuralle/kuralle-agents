import type { SystemModelMessage, ToolSet } from 'ai';
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

/**
 * Compose the agent base layer (ADR 0001) into a stable system-message array.
 * Returned as `SystemModelMessage[]` so a cache breakpoint can annotate the
 * last message — a single string cannot carry per-message providerOptions.
 */
/**
 * Tells the model it may issue several tool calls in one response.
 *
 * The runtime already runs parallel-safe calls from a single response concurrently and
 * fires ONE follow-up completion for the batch (`dispatchModelToolCalls`). Nothing told
 * the model to batch, so it emitted one call per response and that machinery never fired
 * — a turn was measured spending ~10,400 ms on six sequential tool round-trips at ~1.7 s
 * each, while tool execution across the whole turn was 15 ms.
 *
 * Round-trip COUNT dominates turn latency, and it is the model that decides the count.
 * Wording follows Eve's, including the independence caveat: batching calls that depend on
 * each other is a correctness bug, not a speed-up.
 *
 * Lives in the stable head so it sits inside the cache breakpoint rather than being
 * re-billed every turn.
 */
export const PARALLEL_TOOL_INSTRUCTION =
  'Tool use: if you need several independent tools, call them all in one response — they ' +
  'run in parallel and cost a single round-trip. Only batch calls that do not depend on ' +
  "each other's results; anything that needs a previous result must wait for it.";

export function composeSystem(
  base: Instructions | undefined,
  nodeSystem: string,
  state: FlowState,
  skillPrompt?: string,
  workingMemoryPrompt?: string,
): SystemModelMessage[] {
  // TWO messages, deliberately. A cache breakpoint is placed on a system message, and it
  // only buys anything if that message is byte-identical between turns. Joining everything
  // into one message meant the marked message changed the moment a flow node prompt or a
  // working-memory line appeared — so the whole system region re-billed on every flow turn
  // (measured: 93.20% cache rate on a plain session, 77.20% once a flow entered).
  //
  // head    = base instructions + skills. Stable for the life of the agent.
  // volatile = working memory + node prompt. Changes turn to turn, by design.
  const baseText = base ? resolveInstructions(base, state) : '';
  // Only alongside real instructions. An agent with nothing to say should not get a system
  // message consisting solely of a tool-batching note — composeSystem returning [] for empty
  // input is a contract two tests pin.
  const authored = [baseText, skillPrompt].filter((s) => s && s.trim());
  const head = authored.length > 0 ? [authored[0], PARALLEL_TOOL_INSTRUCTION, ...authored.slice(1)].join('\n\n') : '';
  const volatile = [workingMemoryPrompt, nodeSystem].filter((s) => s && s.trim()).join('\n\n');

  const messages: SystemModelMessage[] = [];
  if (head.trim()) messages.push({ role: 'system', content: head });
  if (volatile.trim()) messages.push({ role: 'system', content: volatile });
  return messages;
}

/** Flatten system messages to a string for callers that still need one (e.g. structured decide). */
export function systemMessagesText(messages: readonly SystemModelMessage[]): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((s) => s.trim())
    .join('\n\n');
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

export function resolveReplyNode(
  node: ReplyNode,
  state: FlowState,
  options?: { freeConversation?: boolean },
): ResolvedNode {
  const tools = buildNodeTools(node, state);
  return {
    node,
    prompt: buildNodePrompt(node, state),
    tools,
    // Recover the raw executors from the node's `buildToolSet` tools so they run
    // in-flow (with run context) — without also needing `agent.tools`.
    localTools: rawToolsFromSet(tools),
    ...(options?.freeConversation && { freeConversation: true }),
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
