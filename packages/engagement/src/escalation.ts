import type { EscalationHandler, EscalationOutcome, EscalationRequest } from '@kuralle-agents/core';
import type { OwnershipStore } from '@kuralle-agents/messaging';

/**
 * Channel-side escalation bridge: when the runtime escalates, claim thread
 * ownership for the human (so `ownershipGate` suppresses bot sends) and
 * notify the human channel; when the human is done, `resolveEscalation`
 * releases ownership and hands the conversation back to the bot with the
 * resolution in context.
 */
export interface EscalationBridgeOptions {
  ownership: OwnershipStore;
  /** Map the escalation to the channel threadId to claim. Default: `request.sessionId`. */
  threadIdFor?: (request: EscalationRequest) => string;
  /**
   * Notify the human side (inbox, Slack, pager). The returned outcome is
   * surfaced to the runtime; returning nothing defaults to
   * `{ status: 'queued', queueId: sessionId }`.
   */
  notify?: (request: EscalationRequest) => Promise<EscalationOutcome | void>;
}

export function createOwnershipEscalationHandler(
  options: EscalationBridgeOptions,
): EscalationHandler {
  return async (request) => {
    const threadId = options.threadIdFor?.(request) ?? request.sessionId;
    await options.ownership.claim(threadId, 'human');

    if (options.notify) {
      const outcome = await options.notify(request);
      if (outcome) {
        return outcome;
      }
    }
    return { status: 'queued', queueId: request.sessionId };
  };
}

/** The runtime surface `resolveEscalation` needs (satisfied by `Runtime`). */
export interface EscalationResumable {
  resumeFromEscalation(
    sessionId: string,
    opts?: { resolutionSummary?: string },
  ): Promise<void>;
}

export interface ResolveEscalationOptions {
  runtime: EscalationResumable;
  ownership: OwnershipStore;
  sessionId: string;
  /** Channel threadId that was claimed. Default: `sessionId`. */
  threadId?: string;
  /** What the human did — appended to the conversation so the bot resumes with context. */
  resolutionSummary?: string;
}

/** Human is done: release the thread back to the bot and resume the run with context. */
export async function resolveEscalation(options: ResolveEscalationOptions): Promise<void> {
  await options.ownership.release(options.threadId ?? options.sessionId);
  await options.runtime.resumeFromEscalation(options.sessionId, {
    resolutionSummary: options.resolutionSummary,
  });
}
