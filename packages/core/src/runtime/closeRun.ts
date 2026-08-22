import type { Session } from '../types/session.js';
import type { SessionStore } from '../session/SessionStore.js';
import type { Hooks } from '../types/hooks.js';
import type { RunContext } from '../types/run-context.js';
import { runKind, type RunState } from './durable/types.js';
import type { RunStore } from './durable/RunStore.js';
import { clearRunLease } from './durable/runLease.js';
import { isTerminalOutcome, markSessionOutcome } from './outcomeMarking.js';
import type { ConversationOutcome } from '../outcomes/types.js';
import type { FlowGateVerdict } from '../flows/definition/types.js';
import { mutateSessionWithRetry } from '../session/utils.js';
import { syncPendingUserInput } from './channels/inputBuffer.js';
import { runHookSafely } from './runHookSafely.js';
import type { ExtractionConfig } from '../types/grounding.js';
import { runExtractionAtClose } from '../memory/extract/runExtraction.js';
import { consumeTurnNotes } from './systemNotes.js';

export interface CloseRunExtractionOptions {
  config: ExtractionConfig;
  turnMessageBaseline: number;
  run: () => Promise<boolean>;
  trackBackground: (promise: Promise<void>) => void;
}

export interface CloseRunOptions {
  session: Session;
  /** Number of inline audit entries present when this turn opened. */
  auditBaseline?: number;
  runState: RunState;
  runStore: RunStore;
  sessionStore: SessionStore;
  hooks?: Hooks;
  ctx: RunContext;
  terminalOutcome?: ConversationOutcome;
  outcomeReason?: string;
  outcomeGates?: FlowGateVerdict[];
  extraction?: CloseRunExtractionOptions;
}

export async function closeRun(options: CloseRunOptions): Promise<void> {
  const { session, runState, runStore, sessionStore, hooks, ctx } = options;

  // Turn boundary: every model composition for this runtime.run() has finished
  // (reply, extraction, flow handoffs). Drop `turn`-lifetime notes here so they
  // do not leak into the next user turn; persist with the closing write so crash
  // recovery does not replay a note that was already composed.
  consumeTurnNotes(runState);
  runState.updatedAt = Date.now();
  if (options.terminalOutcome) {
    runState.status = 'finished';
  }
  clearRunLease(runState);
  await runStore.putRunState(runState);

  if (options.extraction) {
    await runExtractionAtClose({
      runState,
      runStore,
      ...options.extraction,
    });
  }

  let outcomeRecord = session.metadata?.outcome;
  if (options.terminalOutcome && !outcomeRecord) {
    outcomeRecord = await markSessionOutcome(
      sessionStore,
      session,
      options.terminalOutcome,
      {
        reason: options.outcomeReason,
        markedBy: 'hook',
        ...(options.outcomeGates && options.outcomeGates.length > 0
          ? { gates: options.outcomeGates }
          : {}),
      },
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
    if (runKind(runState) === 'conversation') {
      // Tool and driver code receives the live Session through RunContext. Persist
      // its working-memory mutations alongside the canonical transcript; otherwise
      // values set during a tool call disappear after this turn because journal
      // writes operate on separately cloned SessionStore snapshots.
      latest.workingMemory = structuredClone(ctx.session.workingMemory);
      latest.currentAgent = runState.activeAgentId;
      latest.activeAgentId = runState.activeAgentId;
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
      syncPendingUserInput(ctx.session, latest);
    }
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
  });

  if (sessionStore.appendAuditEntry) {
    const createdThisTurn = session.metadata?.audit?.slice(options.auditBaseline ?? 0) ?? [];
    // Keep append order deterministic. This also makes a failure observable at
    // the turn boundary instead of silently claiming an audit trail exists.
    for (const entry of createdThisTurn) {
      await sessionStore.appendAuditEntry(session.id, entry);
    }
  }
}
