import type { HarnessConfig } from '@kuralle-agents/core';
import {
  DeploymentError,
  type BoundAgentRevision,
  type ThreadAssignmentRequest,
  type ThreadPin,
} from '@kuralle-agents/deployment';
import { KuralleAgent, type ResolvedRuntimeDefinition } from './KuralleAgent.js';
import { SqlThreadPinStore } from './SqlThreadPinStore.js';

/**
 * Generic production Durable Object: deploy one class and create one named
 * instance per authenticated `(tenantId, threadId)` pair.
 */
export abstract class KuralleThreadAgent<Env = unknown, State = unknown>
  extends KuralleAgent<Env, State> {
  private boundRevision?: { key: string; value: BoundAgentRevision };

  /** Authenticate the private control-plane initialization request. Fail closed. */
  protected abstract authorizeThreadInitialization(request: Request): boolean | Promise<boolean>;

  /** Resolve an active release only for a thread that does not already have a durable pin. */
  protected abstract assignThread(request: ThreadAssignmentRequest): Promise<ThreadPin>;

  /** Fetch, verify, and bind the exact artifact/runtime pair named by the durable pin. */
  protected abstract bindPinnedAgent(pin: ThreadPin): Promise<BoundAgentRevision>;

  protected override async resolveRuntimeDefinition(): Promise<ResolvedRuntimeDefinition> {
    const pin = new SqlThreadPinStore(this.getSqlExecutor()).get();
    if (!pin) throw new Error('thread is not initialized');
    const key = [
      pin.tenantId,
      pin.threadId,
      pin.agentVersionId,
      pin.artifactDigest,
      pin.runtimeRevisionId,
      pin.configGeneration,
      pin.secretGeneration,
    ].join(':');
    const bound = this.boundRevision?.key === key
      ? this.boundRevision.value
      : await this.bindPinnedAgent(pin);
    if (
      bound.deployment.tenantId !== pin.tenantId ||
      bound.deployment.agentVersionId !== pin.agentVersionId ||
      bound.deployment.artifactDigest !== pin.artifactDigest ||
      bound.deployment.runtimeRevisionId !== pin.runtimeRevisionId
    ) {
      throw new Error('bound agent does not match the durable thread pin');
    }
    this.boundRevision = { key, value: bound };
    return {
      agents: [bound.agent],
      defaultAgentId: bound.agent.id,
      deployment: bound.deployment,
    };
  }

  protected override getAgents(): HarnessConfig['agents'] {
    throw new Error('KuralleThreadAgent resolves agents from its durable thread pin');
  }

  protected override getDefaultAgentId(): string {
    throw new Error('KuralleThreadAgent resolves its default agent from the pinned artifact');
  }

  override async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname.endsWith('/_kuralle/initialize')) {
      if (!await this.authorizeThreadInitialization(request)) {
        return Response.json({ error: 'forbidden' }, { status: 403 });
      }
      const body = await request.json().catch(() => null) as ThreadAssignmentRequest | null;
      if (!body || typeof body !== 'object') {
        return Response.json({ error: 'invalid initialization request' }, { status: 400 });
      }
      try {
        const pin = await new SqlThreadPinStore(this.getSqlExecutor())
          .initialize(body, candidate => this.assignThread(candidate));
        return Response.json({ pin }, { status: 200 });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'thread initialization failed';
        const status = error instanceof DeploymentError && error.code === 'ACCESS_DENIED' ? 403 : 409;
        return Response.json({ error: message }, { status });
      }
    }
    return super.onRequest(request);
  }
}
