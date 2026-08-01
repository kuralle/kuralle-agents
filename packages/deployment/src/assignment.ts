import { DeploymentError } from './errors.js';
import type { ThreadAssignmentRequest } from './types.js';

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function validateThreadAssignmentRequest(request: ThreadAssignmentRequest): void {
  for (const field of ['tenantId', 'threadId', 'agentEntityId', 'environment'] as const) {
    const value = request[field];
    if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
      throw new DeploymentError('CONFLICT', `invalid thread assignment ${field}`);
    }
  }
  for (const field of ['configGeneration', 'secretGeneration'] as const) {
    const value = request[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new DeploymentError('CONFLICT', `invalid thread assignment ${field}`);
    }
  }
  if (request.assignedAt !== undefined && Number.isNaN(Date.parse(request.assignedAt))) {
    throw new DeploymentError('CONFLICT', 'invalid thread assignment assignedAt');
  }
}
