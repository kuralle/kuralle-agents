import { createHash } from 'node:crypto';

function stableStringify(value: unknown): string {
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

export function clockEffectKey(runId: string, callsite: string, kind: 'now' | 'uuid'): string {
  return idempotencyKey(runId, callsite, kind);
}
