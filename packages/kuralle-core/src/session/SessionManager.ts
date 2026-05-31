import type { Session } from '../types/index.js';
import type { SessionStore } from './SessionStore.js';
import type { AgentStateController } from '../foundation/AgentStateController.js';
import { DefaultAgentStateController } from '../foundation/DefaultAgentStateController.js';

export class SessionManager {
  private readonly agentState: AgentStateController;

  constructor(
    private store: SessionStore,
    private defaultAgentId: string,
    agentState?: AgentStateController,
  ) {
    this.agentState = agentState ?? new DefaultAgentStateController();
  }

  async create(userId?: string, sessionId?: string): Promise<Session> {
    const now = new Date();
    const id = sessionId ?? crypto.randomUUID();
    const session: Session = {
      id,
      conversationId: id,
      channelId: 'web',
      userId,
      createdAt: now,
      updatedAt: now,
      messages: [],
      workingMemory: {},
      currentAgent: this.defaultAgentId,
      activeAgentId: this.defaultAgentId,
      state: {},
      metadata: {
        createdAt: now,
        lastActiveAt: now,
        totalTokens: 0,
        totalSteps: 0,
        handoffHistory: [],
      },
      agentStates: {},
      handoffHistory: [],
    };

    await this.store.save(session);
    return session;
  }

  async getOrCreate(sessionId?: string, userId?: string): Promise<Session> {
    if (sessionId) {
      const existing = await this.store.get(sessionId);
      if (existing) {
        return existing;
      }
      return this.create(userId, sessionId);
    }

    return this.create(userId);
  }

  async get(sessionId: string): Promise<Session | null> {
    return this.store.get(sessionId);
  }

  async save(session: Session): Promise<void> {
    session.updatedAt = new Date();
    if (session.metadata) {
      session.metadata.lastActiveAt = new Date();
    }
    await this.store.save(session);
  }

  async delete(sessionId: string): Promise<void> {
    await this.store.delete(sessionId);
  }

  async listForUser(userId: string): Promise<Session[]> {
    return this.store.list(userId);
  }

  async recordHandoff(
    sessionId: string,
    fromAgentId: string,
    toAgentId: string,
    reason: string
  ): Promise<void> {
    const session = await this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.currentAgent = toAgentId;
    session.activeAgentId = toAgentId;
    session.handoffHistory.push({
      from: fromAgentId,
      to: toAgentId,
      reason,
      timestamp: new Date(),
    });
    if (session.metadata) {
      session.metadata.handoffHistory.push({
        from: fromAgentId,
        to: toAgentId,
        reason,
        timestamp: new Date(),
      });
    }

    await this.save(session);
  }

  async updateStats(sessionId: string, tokensUsed: number, stepsCompleted: number): Promise<void> {
    const session = await this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!session.metadata) {
      session.metadata = {
        createdAt: session.createdAt,
        lastActiveAt: new Date(),
        totalTokens: 0,
        totalSteps: 0,
        handoffHistory: session.handoffHistory ?? [],
      };
    }

    session.metadata.totalTokens += tokensUsed;
    session.metadata.totalSteps += stepsCompleted;

    await this.save(session);
  }

  async setState(sessionId: string, key: string, value: unknown): Promise<void> {
    const session = await this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!session.state) {
      session.state = {};
    }

    session.state[key] = value;
    await this.save(session);
  }

  async getState<T>(sessionId: string, key: string): Promise<T | undefined> {
    const session = await this.store.get(sessionId);
    return session?.state?.[key] as T | undefined;
  }

  async cleanup(maxAgeMs: number): Promise<number> {
    if (this.store.cleanup) {
      return this.store.cleanup(maxAgeMs);
    }
    return 0;
  }

  async updateAgentState(sessionId: string, agentId: string, state: Record<string, unknown>): Promise<void> {
    const session = await this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    this.agentState.setAgentState(session, agentId, state);

    await this.save(session);
  }
}
