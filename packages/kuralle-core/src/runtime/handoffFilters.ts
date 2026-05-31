/**
 * Pre-built handoff input filters for common context-management patterns.
 *
 * These filters are composable: chain them with composeFilters() to apply
 * multiple transformations in sequence.
 */

export interface HandoffInputData {
  /** The full message history at the point of handoff. */
  messages: Array<Record<string, unknown>>;

  /** The workingMemory state at the point of handoff. */
  workingMemory: Record<string, unknown>;

  /** The agent that initiated the handoff. */
  sourceAgentId: string;

  /** The agent that will receive the handoff. */
  targetAgentId: string;

  /** The reason provided by the LLM for the handoff, if any. */
  reason?: string;
}

export interface HandoffInputResult {
  /** The filtered message history to pass to the target agent. */
  messages: Array<Record<string, unknown>>;

  /** The filtered workingMemory to pass to the target agent. */
  workingMemory: Record<string, unknown>;
}

export type HandoffInputFilter = (
  data: HandoffInputData,
) => Promise<HandoffInputResult> | HandoffInputResult;

/**
 * Removes all tool-call and tool-result messages from the history.
 * The target agent sees only user/assistant conversational turns.
 *
 * - Messages with role 'tool' are removed entirely.
 * - Assistant messages that contain ONLY tool-call content parts are removed.
 * - Assistant messages with mixed content (text + tool-call) are preserved.
 */
export function removeToolHistory(data: HandoffInputData): HandoffInputResult {
  const filtered = data.messages.filter((m) => {
    if (m.role === 'tool') return false;

    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const parts = m.content as Array<Record<string, unknown>>;
      const hasOnlyToolContent = parts.every(
        (part) => part.type === 'tool-call' || part.type === 'tool-result',
      );
      if (hasOnlyToolContent && parts.length > 0) return false;
    }

    return true;
  });
  return { messages: filtered, workingMemory: data.workingMemory };
}

/**
 * Keeps only the last N non-system messages. System messages are always preserved.
 *
 * Respects tool-call/tool-result pair integrity: if a tool-result message is
 * included but its preceding tool-call assistant message is cut, both are excluded.
 */
export function keepRecentMessages(
  count: number,
): (data: HandoffInputData) => HandoffInputResult {
  return (data: HandoffInputData): HandoffInputResult => {
    if (count <= 0) {
      const system = data.messages.filter((m) => m.role === 'system');
      return { messages: system, workingMemory: data.workingMemory };
    }

    const system = data.messages.filter((m) => m.role === 'system');
    const nonSystem = data.messages.filter((m) => m.role !== 'system');
    const recent = nonSystem.slice(-count);
    return {
      messages: [...system, ...recent],
      workingMemory: data.workingMemory,
    };
  };
}

/**
 * Removes specified keys from workingMemory. Passes messages through unchanged.
 */
export function removeKeys(
  keys: string[],
): (data: HandoffInputData) => HandoffInputResult {
  return (data: HandoffInputData): HandoffInputResult => {
    const cleaned = { ...data.workingMemory };
    for (const key of keys) {
      delete cleaned[key];
    }
    return { messages: data.messages, workingMemory: cleaned };
  };
}

/**
 * Composes multiple filters into a single filter.
 * Filters are applied left-to-right: each filter receives the output of the previous one.
 */
export function composeFilters(
  ...filters: HandoffInputFilter[]
): HandoffInputFilter {
  return async (data: HandoffInputData): Promise<HandoffInputResult> => {
    if (filters.length === 0) {
      return { messages: data.messages, workingMemory: data.workingMemory };
    }

    let result: HandoffInputResult = {
      messages: data.messages,
      workingMemory: data.workingMemory,
    };

    for (const filter of filters) {
      const input: HandoffInputData = {
        ...data,
        messages: result.messages,
        workingMemory: result.workingMemory,
      };
      result = await filter(input);
    }

    return result;
  };
}

/**
 * Convenience namespace for all pre-built filters.
 */
export const handoffFilters = {
  removeToolHistory,
  keepRecentMessages,
  removeKeys,
  compose: composeFilters,
};
