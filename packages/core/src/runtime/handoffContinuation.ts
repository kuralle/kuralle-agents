/**
 * Silent handoff: a transfer between agents should read as one continuous
 * assistant to the user. The transfer itself is already a silent control tool
 * call, but the TARGET agent's own instructions may tell it to introduce itself
 * ("Bill here"), which leaks the switch. On a silent handoff we append a strong
 * continuation directive to the target's system prompt so it does not greet or
 * re-introduce — mirroring the OpenAI Agents SDK's `nest_handoff_history`
 * context-note approach. Off (visible handoff) leaves the target's instructions
 * untouched.
 */
import type { Instructions } from '../types/agentConfig.js';

export const HANDOFF_CONTINUATION_DIRECTIVE =
  'You are seamlessly continuing an ongoing conversation with the same user — this is ' +
  'not a new conversation. Do NOT greet the user, introduce yourself, state your name ' +
  'or role, say "hello", or mention any transfer, connection, or that a different ' +
  'assistant is now helping. Ignore any earlier instruction to open with a greeting or ' +
  'self-introduction. Continue as one uninterrupted assistant and answer the request directly.';

const SUFFIX = `\n\n[Handoff continuation]\n${HANDOFF_CONTINUATION_DIRECTIVE}`;

/**
 * Append the continuation directive to a target agent's instructions on a silent
 * handoff. Handles every `Instructions` form: a string is suffixed; a (sync)
 * function is wrapped so the directive is appended to its resolved text; an
 * `AgentPrompt` object is left untouched (it cannot be safely suffixed, and is
 * rare as a base layer); `undefined` yields the directive alone.
 */
export function applyHandoffContinuation(base: Instructions | undefined): Instructions {
  if (typeof base === 'string') {
    return `${base}${SUFFIX}`;
  }
  if (typeof base === 'function') {
    return (ctx: { state: Record<string, unknown> }): Instructions => {
      const inner = base(ctx);
      if (typeof inner !== 'string') {
        // resolveInstructions only supports sync-string functions; match that contract.
        throw new Error('handoff continuation: instructions function must return a string synchronously');
      }
      return `${inner}${SUFFIX}`;
    };
  }
  // AgentPrompt object → preserve as-is (do not drop the persona); undefined → directive only.
  return base ?? HANDOFF_CONTINUATION_DIRECTIVE;
}
