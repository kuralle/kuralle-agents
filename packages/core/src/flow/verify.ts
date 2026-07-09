import type { StandardSchemaV1 } from '../types/standard-schema.js';
import type { FlowNode, FlowState } from '../types/flow.js';
import type { StepRecord } from '../runtime/durable/types.js';

export interface NodeVerify {
  outputSchema?: StandardSchemaV1;
  check?: (input: VerifyInput) => boolean | Promise<boolean>;
}

export interface VerifyInput {
  state: FlowState;
  steps: StepRecord[];
  data?: Record<string, unknown>;
}

export class VerifyBlockedError extends Error {
  constructor(
    readonly nodeId: string,
    message: string,
  ) {
    super(message);
    this.name = 'VerifyBlockedError';
  }
}

function readNodeVerify(node: FlowNode): NodeVerify | undefined {
  return (node as FlowNode & { verify?: NodeVerify; outputSchema?: StandardSchemaV1 }).verify
    ?? ((node as FlowNode & { outputSchema?: StandardSchemaV1 }).outputSchema
      ? { outputSchema: (node as FlowNode & { outputSchema?: StandardSchemaV1 }).outputSchema }
      : undefined);
}

export async function runNodeVerify(
  node: FlowNode,
  input: VerifyInput,
): Promise<void> {
  const verify = readNodeVerify(node);
  if (!verify) {
    return;
  }

  if (verify.outputSchema) {
    const payload = { ...input.state, ...(input.data ?? {}) };
    const result = await verify.outputSchema['~standard'].validate(payload);
    if ('issues' in result) {
      const message = result.issues.map((issue) => issue.message).join('; ') || 'Verify failed';
      throw new VerifyBlockedError(node.id, `Verify blocked on "${node.id}": ${message}`);
    }
  }

  if (verify.check) {
    const ok = await verify.check(input);
    if (!ok) {
      throw new VerifyBlockedError(node.id, `Verify check failed on "${node.id}"`);
    }
  }
}
