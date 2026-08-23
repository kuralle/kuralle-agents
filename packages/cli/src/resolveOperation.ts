import { readFileSync } from 'node:fs';
import { buildApprovalResponse, type InputResponse, type TurnView } from '@kuralle-agents/client';
import { UsageError } from './errors.js';
import { parseTurnResult, type TurnResult } from './turnResult.js';

export interface ResolvedSend {
  previous?: TurnResult;
  mode: 'send' | 'respond' | 'signal';
  responses?: InputResponse[];
}

export function readStdinText(): string {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8').trim();
  } catch {
    return '';
  }
}

export async function readResumeResult(resume: boolean): Promise<TurnResult | undefined> {
  if (!resume) return undefined;
  const text = readStdinText();
  if (!text) {
    throw new UsageError('--resume requires a TurnResult on stdin');
  }
  return parseTurnResult(JSON.parse(text));
}

export function responsesFromRespondJson(
  respondJson: string,
  previous: TurnResult,
): InputResponse[] {
  if (previous.status !== 'input-required') {
    throw new UsageError('--respond requires a prior input-required result');
  }
  const parsed = JSON.parse(respondJson) as Array<{ requestId: string; decision: 'approve' | 'deny' }>;
  const entry = parsed[0];
  if (!entry) {
    throw new UsageError('--respond requires at least one response');
  }
  const interrupt = previous.view.pending.find((pending) => pending.requestId === entry.requestId);
  if (!interrupt) {
    throw new UsageError(`no pending request with id ${entry.requestId}`);
  }
  return buildApprovalResponse(interrupt, entry.decision);
}

export function resolveOperation(
  message: string,
  respondJson: string | undefined,
  approve: boolean,
  deny: boolean,
  signalName: string | undefined,
  previous: TurnResult | undefined,
): ResolvedSend {
  const hasPrompt = message.length > 0;
  const hasRespond = respondJson !== undefined;
  const hasApprovalFlag = approve || deny;
  const hasSignal = signalName !== undefined || hasApprovalFlag;

  if (!previous) {
    if (!hasPrompt && !hasSignal) {
      throw new UsageError('pass a message to take a turn, or --state to inspect');
    }
    if (hasRespond) {
      throw new UsageError('--respond requires --resume with an input-required result');
    }
    if (hasApprovalFlag) {
      throw new UsageError('--approve/--deny requires --resume with an input-required result');
    }
    return { mode: hasSignal ? 'signal' : 'send' };
  }

  if (previous.status === 'failed') {
    throw new UsageError('a terminal failed result cannot be resumed');
  }

  if ('view' in previous && previous.view.status === 'streaming' && hasPrompt) {
    throw new UsageError('a running invocation cannot accept a follow-up prompt');
  }

  if (previous.status === 'input-required') {
    if (!hasPrompt && !hasRespond && !hasApprovalFlag && !hasSignal) {
      throw new UsageError('input-required: pass a message or --respond');
    }
    if (hasRespond || hasApprovalFlag) {
      const responses = hasRespond
        ? responsesFromRespondJson(respondJson!, previous)
        : buildApprovalResponse(
          previous.view.pending[0]!,
          approve ? 'approve' : 'deny',
        );
      return { previous, mode: 'respond', responses };
    }
    if (hasSignal) {
      return { previous, mode: 'signal' };
    }
    return { previous, mode: 'send' };
  }

  if (!hasPrompt && !hasSignal) {
    throw new UsageError('pass a message to continue');
  }
  if (hasRespond) {
    throw new UsageError('--respond requires a prior input-required result');
  }
  if (hasApprovalFlag) {
    throw new UsageError('--approve/--deny requires a prior input-required result');
  }

  return { previous, mode: hasSignal ? 'signal' : 'send' };
}

export function priorView(result: TurnResult | undefined): TurnView | undefined {
  return result && 'view' in result ? result.view : undefined;
}

export function resumeCursor(result: TurnResult): NonNullable<TurnResult['cursor']> {
  if (!result.cursor) {
    throw new UsageError('resume requires a TurnResult with a cursor');
  }
  return result.cursor;
}
