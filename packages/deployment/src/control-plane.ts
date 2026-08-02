import { validateArtifact } from './artifact.js';
import { DeploymentError } from './errors.js';
import type { DeploymentStore } from './store.js';
import type { AgentVersion, ThreadAssignmentRequest, ThreadPin } from './types.js';

export interface PinnedAgentVersion {
  pin: ThreadPin;
  version: AgentVersion;
}

export interface DeploymentControlPlaneClient {
  assignThread(request: ThreadAssignmentRequest): Promise<ThreadPin>;
  getPinnedVersion(pin: ThreadPin): Promise<AgentVersion>;
}

export type DeploymentControlPlaneFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Response | Promise<Response>;

export interface HttpDeploymentControlPlaneClientOptions {
  baseUrl: string;
  authorization: string | (() => string | Promise<string>);
  fetch?: DeploymentControlPlaneFetch;
  timeoutMs?: number;
}

export const DEPLOYMENT_CONTROL_PLANE_PATHS = {
  assignThread: '/v1/internal/deployment/threads/assign',
  pinnedVersion: '/v1/internal/deployment/threads/pinned-version',
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateThreadPin(value: unknown): ThreadPin {
  if (!isRecord(value)) throw new DeploymentError('NOT_FOUND', 'control plane returned an invalid thread pin');
  const requiredStrings = [
    'tenantId', 'threadId', 'agentEntityId', 'agentVersionId', 'artifactDigest',
    'runtimeRevisionId', 'releaseId', 'environment', 'assignedAt',
  ] as const;
  if (requiredStrings.some(field => typeof value[field] !== 'string')) {
    throw new DeploymentError('NOT_FOUND', 'control plane returned an invalid thread pin');
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.artifactDigest))) {
    throw new DeploymentError('NOT_FOUND', 'control plane returned an invalid artifact digest');
  }
  if (
    !Number.isSafeInteger(value.configGeneration)
    || Number(value.configGeneration) < 0
    || !Number.isSafeInteger(value.secretGeneration)
    || Number(value.secretGeneration) < 0
  ) {
    throw new DeploymentError('NOT_FOUND', 'control plane returned invalid deployment generations');
  }
  if (Number.isNaN(Date.parse(String(value.assignedAt)))) {
    throw new DeploymentError('NOT_FOUND', 'control plane returned an invalid assignment timestamp');
  }
  if (value.branch !== undefined && typeof value.branch !== 'string') {
    throw new DeploymentError('NOT_FOUND', 'control plane returned an invalid release branch');
  }
  return value as unknown as ThreadPin;
}

function samePin(left: ThreadPin, right: ThreadPin): boolean {
  return left.tenantId === right.tenantId
    && left.threadId === right.threadId
    && left.agentEntityId === right.agentEntityId
    && left.agentVersionId === right.agentVersionId
    && left.artifactDigest === right.artifactDigest
    && left.runtimeRevisionId === right.runtimeRevisionId
    && left.releaseId === right.releaseId
    && left.environment === right.environment
    && left.configGeneration === right.configGeneration
    && left.secretGeneration === right.secretGeneration;
}

export async function resolvePinnedAgentVersion(
  store: DeploymentStore,
  requestedPin: ThreadPin,
): Promise<PinnedAgentVersion> {
  const pin = await store.getThreadPin(requestedPin.tenantId, requestedPin.threadId);
  if (!pin) throw new DeploymentError('NOT_FOUND', 'thread pin does not exist');
  if (!samePin(pin, requestedPin)) {
    throw new DeploymentError('CONFLICT', 'requested thread pin does not match the durable control-plane pin');
  }
  const version = await store.getVersion(pin.tenantId, pin.agentVersionId);
  if (!version) throw new DeploymentError('NOT_FOUND', 'pinned agent version does not exist');
  if (version.artifact.digest !== pin.artifactDigest) {
    throw new DeploymentError('CONFLICT', 'pinned artifact digest does not match the stored agent version');
  }
  return { pin, version };
}

export class HttpDeploymentControlPlaneClient implements DeploymentControlPlaneClient {
  private readonly baseUrl: string;
  private readonly authorization: HttpDeploymentControlPlaneClientOptions['authorization'];
  private readonly fetcher: DeploymentControlPlaneFetch;
  private readonly timeoutMs: number;

  constructor(options: HttpDeploymentControlPlaneClientOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
      throw new Error('Deployment control plane must use HTTPS outside local development');
    }
    this.baseUrl = url.toString().replace(/\/$/, '');
    this.authorization = options.authorization;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async assignThread(request: ThreadAssignmentRequest): Promise<ThreadPin> {
    const result = await this.post(DEPLOYMENT_CONTROL_PLANE_PATHS.assignThread, request);
    const pin = validateThreadPin(isRecord(result) ? result.pin : undefined);
    if (
      pin.tenantId !== request.tenantId
      || pin.threadId !== request.threadId
      || pin.agentEntityId !== request.agentEntityId
      || pin.environment !== request.environment
    ) {
      throw new DeploymentError('CONFLICT', 'control-plane assignment does not match the requested thread');
    }
    return pin;
  }

  async getPinnedVersion(requestedPin: ThreadPin): Promise<AgentVersion> {
    const result = await this.post(DEPLOYMENT_CONTROL_PLANE_PATHS.pinnedVersion, { pin: requestedPin });
    const pin = validateThreadPin(isRecord(result) ? result.pin : undefined);
    if (!samePin(pin, requestedPin)) {
      throw new DeploymentError('CONFLICT', 'control-plane response does not match the durable thread pin');
    }
    const rawVersion = isRecord(result) ? result.version : undefined;
    if (!isRecord(rawVersion)) {
      throw new DeploymentError('NOT_FOUND', 'control plane returned an invalid agent version');
    }
    const artifact = await validateArtifact(rawVersion.artifact);
    if (
      rawVersion.tenantId !== pin.tenantId
      || rawVersion.id !== pin.agentVersionId
      || artifact.digest !== pin.artifactDigest
    ) {
      throw new DeploymentError('CONFLICT', 'control-plane version does not match the durable thread pin');
    }
    return { ...rawVersion, artifact } as unknown as AgentVersion;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const authorization = typeof this.authorization === 'function'
      ? await this.authorization()
      : this.authorization;
    if (!authorization.trim()) throw new Error('Deployment control-plane authorization is required');
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const result = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const message = isRecord(result) && typeof result.error === 'string'
        ? result.error
        : `deployment control plane returned ${response.status}`;
      const code = response.status === 401 || response.status === 403 ? 'ACCESS_DENIED'
        : response.status === 404 ? 'NOT_FOUND'
          : 'CONFLICT';
      throw new DeploymentError(code, message);
    }
    return result;
  }
}
