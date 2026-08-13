function canonicalValue(value: unknown, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`canonical values must be finite numbers${path ? ` at ${path}` : ''}`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const child = record[key];
      if (child === undefined) continue;
      result[key] = canonicalValue(child, path ? `${path}.${key}` : key);
    }
    return result;
  }
  throw new Error(`canonical values cannot contain ${typeof value}${path ? ` at ${path}` : ''}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, ''));
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const hash = await crypto.subtle.digest('SHA-256', input.buffer);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
