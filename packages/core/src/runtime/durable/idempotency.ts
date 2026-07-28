import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const record = val as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = record[key];
      }
      return sorted;
    }
    return val;
  });
}

export function valueHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function logicalRunId(runId: string, runEpoch: number | undefined): string {
  return `${runId}#${runEpoch ?? 0}`;
}

export function idempotencyKey(runId: string, callsite: string, payload: unknown): string {
  const material = stableStringify({ runId, callsite, payload });
  return createHash('sha256').update(material).digest('hex');
}

export function toolEffectKey(runId: string, callsite: string, name: string, args: unknown): string {
  return idempotencyKey(runId, callsite, { name, args });
}

export function pauseEffectKey(runId: string, callsite: string, name: string): string {
  return idempotencyKey(runId, callsite, name);
}

export function approvalEffectKey(
  runId: string,
  effectKey: string,
  name: string,
  args: unknown,
): string {
  return idempotencyKey(runId, 'approval', { effectKey, name, args });
}

export function clockEffectKey(runId: string, callsite: string, kind: 'now' | 'uuid'): string {
  return idempotencyKey(runId, callsite, kind);
}
