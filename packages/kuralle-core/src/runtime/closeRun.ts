import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { Hooks } from '../types/hooks.js';
import type { RunContext } from '../types/run-context.js';
import type { RunState } from './durable/types.js';
import type { RunStore } from './durable/RunStore.js';
import { isTerminalOutcome, markSessionOutcome } from './outcomeMarking.js';
import type { ConversationOutcome } from '../outcomes/types.js';

export interface CloseRunOptions {
  session: Session;
  runState: RunState;
  runStore: RunStore;
  sessionStore: SessionStore;
  hooks?: Hooks;
  ctx: RunContext;
  terminalOutcome?: ConversationOutcome;
  outcomeReason?: string;
  memoryIngest?: (ctx: RunContext) => Promise<void>;
}

export async function closeRun(options: CloseRunOptions): Promise<void> {
  const { session, runState, runStore, sessionStore, hooks, ctx } = options;

  runState.updatedAt = Date.now();
  if (options.terminalOutcome) {
    runState.status = 'finished';
  }
  await runStore.putRunState(runState);

  if (options.memoryIngest) {
    await options.memoryIngest(ctx);
  }

  let outcomeRecord = session.metadata?.outcome;
  if (options.terminalOutcome && !outcomeRecord) {
    outcomeRecord = await markSessionOutcome(
      sessionStore,
      session,
      options.terminalOutcome,
      { reason: options.outcomeReason, markedBy: 'hook' },
      ctx.emit,
    );
  }

  if (outcomeRecord && isTerminalOutcome(outcomeRecord.outcome)) {
    await hooks?.onConversationEnd?.({
      session,
      outcome: outcomeRecord,
    });
  }

  const latest = (await sessionStore.get(session.id)) ?? session;
  latest.currentAgent = runState.activeAgentId;
  latest.activeAgentId = runState.activeAgentId;
  await sessionStore.save(latest);
}
