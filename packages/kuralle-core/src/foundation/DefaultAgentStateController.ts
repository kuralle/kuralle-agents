import type { Session, HandoffRecord } from '../types/index.js';
import type { AgentStateController } from './AgentStateController.js';

/**
 * Default agent state controller extracted from Runtime.
 *
 * Handles:
 * - Active agent resolution with fallback
 * - Handoff recording in session.handoffHistory + session.metadata.handoffHistory
 * - Per-agent state updates in session.agentStates
 * - Circular handoff detection
 */
export class DefaultAgentStateController implements AgentStateController {
  getActiveAgent(session: Session, fallbackAgentId: string): string {
    return session.activeAgentId ?? session.currentAgent ?? fallbackAgentId;
  }

  setActiveAgent(session: Session, agentId: string): void {
    session.activeAgentId = agentId;
    session.currentAgent = agentId;
  }

  recordHandoff(args: {
    session: Session;
    fromAgentId: string;
    toAgentId: string;
    reason: string;
  }): void {
    const record: HandoffRecord = {
      from: args.fromAgentId,
      to: args.toAgentId,
      reason: args.reason,
      timestamp: new Date(),
    };

    args.session.handoffHistory.push(record);

    if (args.session.metadata) {
      args.session.metadata.handoffHistory.push(record);
    }
  }

  updateAgentState(session: Session, agentId: string, state: Record<string, unknown>): void {
    const existing = session.agentStates[agentId];
    if (existing) {
      existing.state = { ...existing.state, ...state };
      existing.lastActive = new Date();
    } else {
      session.agentStates[agentId] = {
        agentId,
        state,
        lastActive: new Date(),
      };
    }
  }

  setAgentState(session: Session, agentId: string, state: Record<string, unknown>): void {
    session.agentStates[agentId] = {
      agentId,
      state,
      lastActive: new Date(),
    };
  }

  getAgentState<T = Record<string, unknown>>(session: Session, agentId: string): T | undefined {
    const stored = session.agentStates?.[agentId]?.state;
    if (!stored || typeof stored !== 'object') return undefined;
    return stored as T;
  }

  clearAgent(session: Session, agentId: string): void {
    delete session.agentStates[agentId];
  }

  isCircularHandoff(handoffStack: string[], agentId: string, maxVisits: number = 2): boolean {
    const priorVisits = handoffStack.filter(id => id === agentId).length;
    return priorVisits >= maxVisits;
  }
}
