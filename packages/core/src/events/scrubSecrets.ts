import type { StreamPart } from '../types/stream.js';

export const SECRET_MARKER = '[REDACTED]';
export const CIRCULAR_MARKER = '[circular]';

// Heuristic secret detection — not exhaustive. Catches known value prefixes (sk-, pk_, etc.)
// and sensitive key names (api_key, secret, token, password, etc.). Deliberately does not catch:
// secrets in ordinary prose, or high-entropy credentials under neutral key names with no
// recognised prefix — e.g. { value: '<40 random chars>' } passes through. That is an accepted
// limitation: catching it would redact every UUID, path and sha in the log.
//
// Call-site contract: scrub-then-serialize must be atomic — unchanged subtrees are returned by
// reference, so a tool that mutates a live result object between emit and serialization can change
// what is persisted after scrub.
const SECRET_VALUE_PREFIXES = [
  'sk-',
  'sk_live_',
  'pk_',
  'rk_live_',
  'ghp_',
  'gho_',
  'github_pat_',
  'xox',
  'xapp-',
  'AKIA',
  'ASIA',
  'ya29.',
  'npm_',
  'Bearer ',
  'eyJ',
] as const;
// `\b` is wrong here: `_` is a word character in JS regex, so \btoken\b never fires inside
// access_token / refresh_token — the canonical prefix-less credential. Lookarounds that exclude
// only alphanumerics catch the snake_case compounds while leaving tokenizer / tokenCount alone.
const W = String.raw`(?<![a-z0-9])`;
const W_END = String.raw`(?![a-z0-9])`;
const SECRET_KEY_PATTERN = new RegExp(
  `(?:api[-_]?key|secret|${W}token${W_END}|password|passwd|credential|authorization`
  + `|private[-_]?key|${W}private${W_END}|access[-_]?key|${W}access${W_END}|signing|passphrase`
  + `|${W}pwd${W_END}|${W}pat${W_END}|${W}auth${W_END}|connectionString|${W}dsn${W_END}|bearer)`,
  'i',
);
// The pattern above is case-insensitive, which makes its lookarounds treat `T` in accessToken as
// a word character, so camelCase compounds need a case-SENSITIVE alternative. `tokenizer` and
// `tokenCount` carry no capital, so they stay out of it.
const SECRET_KEY_CAMEL_PATTERN =
  /[a-z](?:Token|Secret|Password|Passwd|Credential|Key|Auth|Pwd|Passphrase)(?![a-z])/;

const URL_USERINFO_PATTERN = /:\/\/[^/:@]+:[^/@]+@/;
const MAX_WALK_DEPTH = 64;

function keyLooksSecret(key: string | undefined): boolean {
  return key !== undefined && (SECRET_KEY_PATTERN.test(key) || SECRET_KEY_CAMEL_PATTERN.test(key));
}

function valueLooksSecret(value: string): boolean {
  if (value.toLowerCase().startsWith('bearer ')) {
    return true;
  }
  if (SECRET_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return true;
  }
  if (value.includes('-----BEGIN')) {
    return true;
  }
  if (URL_USERINFO_PATTERN.test(value)) {
    return true;
  }
  return false;
}

function isBuffer(value: unknown): value is Buffer {
  return typeof Buffer !== 'undefined' && Buffer.isBuffer(value);
}

function isTypedArray(value: unknown): value is Uint8Array {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer;
}

function isMap(value: unknown): value is Map<unknown, unknown> {
  return value instanceof Map;
}

function isSet(value: unknown): value is Set<unknown> {
  return value instanceof Set;
}

function isOpaqueCarrier(value: unknown): boolean {
  return (
    isBuffer(value) ||
    isTypedArray(value) ||
    isArrayBuffer(value) ||
    isMap(value) ||
    isSet(value)
  );
}

function walk(
  value: unknown,
  lastKey: string | undefined,
  ancestors: Set<object>,
  depth: number,
): unknown {
  if (depth > MAX_WALK_DEPTH) {
    return SECRET_MARKER;
  }

  if (keyLooksSecret(lastKey)) {
    return SECRET_MARKER;
  }

  if (isOpaqueCarrier(value)) {
    return value;
  }

  if (typeof value === 'string') {
    if (valueLooksSecret(value)) {
      return SECRET_MARKER;
    }
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(value);
        const scrubbed = walk(parsed, lastKey, ancestors, depth + 1);
        if (scrubbed !== parsed) {
          return JSON.stringify(scrubbed);
        }
      } catch {
        // not JSON — leave unchanged
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      return CIRCULAR_MARKER;
    }
    ancestors.add(value);

    let changed = false;
    const next = value.map((item) => {
      const scrubbed = walk(item, lastKey, ancestors, depth + 1);
      if (scrubbed !== item) changed = true;
      return scrubbed;
    });
    ancestors.delete(value);
    return changed ? next : value;
  }

  if (value !== null && typeof value === 'object') {
    if (ancestors.has(value)) {
      return CIRCULAR_MARKER;
    }
    ancestors.add(value);

    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      const scrubbed = walk(entryValue, key, ancestors, depth + 1);
      next[key] = scrubbed;
      if (scrubbed !== entryValue) changed = true;
    }
    ancestors.delete(value);
    return changed ? next : value;
  }

  return value;
}

function scrubPayload<T>(payload: T): T {
  const scrubbed = walk(payload, undefined, new Set(), 0);
  return scrubbed === payload ? payload : (scrubbed as T);
}

export function scrubSecrets(part: StreamPart): StreamPart {
  switch (part.type) {
    case 'tool-call': {
      const args = scrubPayload(part.payload.args);
      return args === part.payload.args ? part : { ...part, payload: { ...part.payload, args } };
    }
    case 'tool-result': {
      const result = scrubPayload(part.payload.result);
      return result === part.payload.result
        ? part
        : { ...part, payload: { ...part.payload, result } };
    }
    case 'extraction': {
      const value = scrubPayload(part.payload.value);
      return value === part.payload.value
        ? part
        : { ...part, payload: { ...part.payload, value } };
    }
    case 'custom': {
      const data = scrubPayload(part.payload.data);
      return data === part.payload.data ? part : { ...part, payload: { ...part.payload, data } };
    }
    case 'paused': {
      const { interrupt } = part.payload;
      const operation = interrupt.operation;
      const scrubbedArgs = operation !== undefined ? scrubPayload(operation.args) : undefined;
      const scrubbedSchema = scrubPayload(interrupt.responseSchema);

      if (scrubbedArgs === operation?.args && scrubbedSchema === interrupt.responseSchema) {
        return part;
      }

      const nextInterrupt = {
        ...interrupt,
        ...(operation !== undefined && scrubbedArgs !== operation.args
          ? { operation: { ...operation, args: scrubbedArgs } }
          : {}),
        ...(scrubbedSchema !== interrupt.responseSchema
          ? { responseSchema: scrubbedSchema }
          : {}),
      };
      return { ...part, payload: { ...part.payload, interrupt: nextInterrupt } };
    }
    case 'interactive': {
      const prompt = scrubPayload(part.payload.prompt);
      return prompt === part.payload.prompt
        ? part
        : { ...part, payload: { ...part.payload, prompt } };
    }
    case 'safety-blocked': {
      const rationale = scrubPayload(part.payload.rationale);
      const userFacingMessage = scrubPayload(part.payload.userFacingMessage);
      if (rationale === part.payload.rationale && userFacingMessage === part.payload.userFacingMessage) {
        return part;
      }
      return {
        ...part,
        payload: { ...part.payload, rationale, userFacingMessage },
      };
    }
    case 'pipeline-validation-block': {
      const rationale = scrubPayload(part.payload.rationale);
      const userFacingMessage = scrubPayload(part.payload.userFacingMessage);
      if (rationale === part.payload.rationale && userFacingMessage === part.payload.userFacingMessage) {
        return part;
      }
      return { ...part, payload: { ...part.payload, rationale, userFacingMessage } };
    }
    case 'error': {
      // sanitizePart replaces this wholesale at a client route, but the durable log applies only
      // scrubSecrets — and a failed fetch reports its URL verbatim, userinfo included.
      const error = scrubPayload(part.payload.error);
      return error === part.payload.error ? part : { ...part, payload: { ...part.payload, error } };
    }
    case 'escalation': {
      const payload = scrubPayload(part.payload);
      return payload === part.payload ? part : { ...part, payload };
    }
    case 'flow-end': {
      const gates = scrubPayload(part.payload.gates);
      return gates === part.payload.gates ? part : { ...part, payload: { ...part.payload, gates } };
    }
    case 'knowledge-cache-hit': {
      const query = scrubPayload(part.payload.query);
      return query === part.payload.query
        ? part
        : { ...part, payload: { ...part.payload, query } };
    }
    case 'knowledge-cache-miss': {
      const query = scrubPayload(part.payload.query);
      return query === part.payload.query
        ? part
        : { ...part, payload: { ...part.payload, query } };
    }
    case 'knowledge-search': {
      const query = scrubPayload(part.payload.query);
      return query === part.payload.query
        ? part
        : { ...part, payload: { ...part.payload, query } };
    }
    case 'knowledge-quality-check': {
      const query = scrubPayload(part.payload.query);
      return query === part.payload.query
        ? part
        : { ...part, payload: { ...part.payload, query } };
    }
    case 'knowledge-reformulation': {
      const originalQuery = scrubPayload(part.payload.originalQuery);
      const reformulatedQuery = scrubPayload(part.payload.reformulatedQuery);
      if (
        originalQuery === part.payload.originalQuery &&
        reformulatedQuery === part.payload.reformulatedQuery
      ) {
        return part;
      }
      return {
        ...part,
        payload: { ...part.payload, originalQuery, reformulatedQuery },
      };
    }
    default:
      return part;
  }
}
