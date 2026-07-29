import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { Hooks } from '../types/hooks.js';
import type { RunContext } from '../types/run-context.js';
import type { RunState } from './durable/types.js';
import type { RunStore } from './durable/RunStore.js';
import { isTerminalOutcome, markSessionOutcome } from './outcomeMarking.js';
import type { ConversationOutcome } from '../outcomes/types.js';
import { mutateSessionWithRetry } from '../session/utils.js';
import { syncPendingUserInput } from './channels/inputBuffer.js';
import { runHookSafely } from './runHookSafely.js';

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
    await runHookSafely('onConversationEnd', () => hooks?.onConversationEnd?.({
      session,
      outcome: outcomeRecord,
    }));
  }

  await mutateSessionWithRetry(sessionStore, session.id, (latest) => {
    latest.currentAgent = runState.activeAgentId;
    latest.activeAgentId = runState.activeAgentId;
    // Tool and driver code receives the live Session through RunContext. Persist
    // its working-memory mutations alongside the canonical transcript; otherwise
    // values set during a tool call disappear after this turn because journal
    // writes operate on separately cloned SessionStore snapshots.
    latest.workingMemory = structuredClone(ctx.session.workingMemory);
    // Sync the session-level message mirror to the canonical run record — it
    // otherwise lacks assistant turns and keeps pre-guardrail (unredacted)
    // user input written at openRun.
    latest.messages = [...runState.messages];
    // Persist handoff history accumulated on the run's working session this turn
    // (terminal + non-terminal handoffs alike). Without this the in-memory pushes
    // were silently dropped: stores that clone on get/save (e.g. MemoryStore) hand
    // back a fresh snapshot here, and the previous mutator never copied handoffHistory
    // across — so isHandoffOscillating's cross-turn safeguard never saw prior turns.
    latest.handoffHistory = session.handoffHistory;
    if (session.metadata?.audit) {
      latest.metadata ??= {
        createdAt: latest.createdAt,
        lastActiveAt: latest.updatedAt,
        totalTokens: 0,
        totalSteps: 0,
        handoffHistory: [],
      };
      latest.metadata.audit = [...session.metadata.audit];
    }
    syncPendingUserInput(ctx.session, latest);
  });
}
