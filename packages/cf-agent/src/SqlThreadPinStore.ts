import { DeploymentError } from '@kuralle-agents/deployment';
import type {
  ThreadAssignmentRequest,
  ThreadPin,
} from '@kuralle-agents/deployment';
import type { SqlExecutor } from './types.js';

function accessDenied(): never {
  throw new DeploymentError('ACCESS_DENIED', 'resource is not accessible in this tenant');
}

function conflict(message: string): never {
  throw new DeploymentError('CONFLICT', message);
}

function parsePin(value: string): ThreadPin {
  const pin = JSON.parse(value) as Partial<ThreadPin>;
  for (const field of [
    'tenantId',
    'threadId',
    'agentEntityId',
    'agentVersionId',
    'artifactDigest',
    'runtimeRevisionId',
    'releaseId',
    'environment',
    'assignedAt',
  ] as const) {
    if (typeof pin[field] !== 'string' || pin[field]!.length === 0) {
      throw new DeploymentError('CONFLICT', `stored thread pin has invalid ${field}`);
    }
  }
  if (
    typeof pin.configGeneration !== 'number' ||
    !Number.isSafeInteger(pin.configGeneration) ||
    typeof pin.secretGeneration !== 'number' ||
    !Number.isSafeInteger(pin.secretGeneration)
  ) {
    throw new DeploymentError('CONFLICT', 'stored thread pin has invalid generations');
  }
  return pin as ThreadPin;
}

function verifyRequest(pin: ThreadPin, request: ThreadAssignmentRequest): void {
  if (pin.tenantId !== request.tenantId) accessDenied();
  if (
    pin.threadId !== request.threadId ||
    pin.agentEntityId !== request.agentEntityId ||
    pin.environment !== request.environment
  ) {
    conflict('Durable Object is already pinned to a different thread, agent, or environment');
  }
}

function validateRequest(request: ThreadAssignmentRequest): void {
  for (const field of ['tenantId', 'threadId', 'agentEntityId', 'environment'] as const) {
    if (typeof request[field] !== 'string' || request[field].length === 0) {
      conflict(`invalid thread assignment ${field}`);
    }
  }
  for (const field of ['configGeneration', 'secretGeneration'] as const) {
    const value = request[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      conflict(`invalid thread assignment ${field}`);
    }
  }
}

/** Private, one-row revision pin stored inside a thread Durable Object. */
export class SqlThreadPinStore {
  private initialized = false;

  constructor(private readonly sql: SqlExecutor) {}

  get(): ThreadPin | null {
    this.ensureTable();
    const row = this.sql<{ payload: string }>`
      SELECT payload FROM kuralle_thread_pin WHERE id = ${'pin'} LIMIT 1
    `[0];
    return row ? parsePin(row.payload) : null;
  }

  initialize(
    request: ThreadAssignmentRequest,
    resolve: (request: ThreadAssignmentRequest) => Promise<ThreadPin>,
  ): Promise<ThreadPin> {
    return this.initializeInner(request, resolve);
  }

  private async initializeInner(
    request: ThreadAssignmentRequest,
    resolve: (request: ThreadAssignmentRequest) => Promise<ThreadPin>,
  ): Promise<ThreadPin> {
    validateRequest(request);
    const existing = this.get();
    if (existing) {
      verifyRequest(existing, request);
      return existing;
    }
    const assigned = await resolve(request);
    verifyRequest(assigned, request);
    this.sql`
      INSERT INTO kuralle_thread_pin (id, payload, created_at)
      VALUES (${'pin'}, ${JSON.stringify(assigned)}, ${assigned.assignedAt})
      ON CONFLICT(id) DO NOTHING
    `;
    const durable = this.get();
    if (!durable) conflict('thread pin insert did not become durable');
    verifyRequest(durable, request);
    if (
      durable.agentVersionId !== assigned.agentVersionId ||
      durable.artifactDigest !== assigned.artifactDigest ||
      durable.runtimeRevisionId !== assigned.runtimeRevisionId ||
      durable.releaseId !== assigned.releaseId
    ) {
      conflict('concurrent initialization resolved a different release assignment');
    }
    return durable;
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.sql`
      CREATE TABLE IF NOT EXISTS kuralle_thread_pin (
        id TEXT PRIMARY KEY CHECK (id = 'pin'),
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `;
    this.initialized = true;
  }
}
