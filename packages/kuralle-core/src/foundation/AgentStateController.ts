import type { Session } from '../types/index.js';

/**
 * Manages active agent resolution, handoff recording, and agent state.
 * Shared by Runtime and VoiceEngine.
 */
export interface AgentStateController {
  /** Resolve the active agent ID, falling back to the provided default. */
  getActiveAgent(session: Session, fallbackAgentId: string): string;

  /** Set the active agent on the session. */
  setActiveAgent(session: Session, agentId: string): void;

  /** Record a handoff in the session's handoff history. */
  recordHandoff(args: {
    session: Session;
    fromAgentId: string;
    toAgentId: string;
    reason: string;
  }): void;

  /** Update per-agent state stored in session.agentStates. Merges with existing state. */
  updateAgentState(session: Session, agentId: string, state: Record<string, unknown>): void;

  /** Replace per-agent state fully (no merge). Use when the state is a single opaque blob. */
  setAgentState(session: Session, agentId: string, state: Record<string, unknown>): void;

  /** Read per-agent state with optional type assertion. Returns undefined if absent or empty. */
  getAgentState<T = Record<string, unknown>>(session: Session, agentId: string): T | undefined;

  /** Remove per-agent state from session.agentStates. No-op if absent. */
  clearAgent(session: Session, agentId: string): void;

  /**
   * Check whether visiting the given agent would constitute a circular handoff.
   * Returns true if the agent has been visited >= maxVisits times in the handoff stack.
   */
  isCircularHandoff(handoffStack: string[], agentId: string, maxVisits?: number): boolean;
}
