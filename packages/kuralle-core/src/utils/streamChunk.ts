export function getChunkArgs(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== 'object') {
    return undefined;
  }
  const record = chunk as Record<string, unknown>;
  if ('args' in record) {
    return record.args;
  }
  if ('input' in record) {
    return record.input;
  }
  return undefined;
}

export function getChunkResult(chunk: unknown): unknown {
  if (!chunk || typeof chunk !== 'object') {
    return undefined;
  }
  const record = chunk as Record<string, unknown>;
  if ('result' in record) {
    return record.result;
  }
  if ('output' in record) {
    return record.output;
  }
  return undefined;
}

export function getChunkToolCallId(chunk: unknown): string | undefined {
  if (!chunk || typeof chunk !== 'object') {
    return undefined;
  }
  const value = (chunk as Record<string, unknown>).toolCallId;
  return typeof value === 'string' ? value : undefined;
}

export function getChunkErrorMessage(chunk: unknown): string {
  if (!chunk || typeof chunk !== 'object') {
    return 'Tool execution error';
  }
  const value = (chunk as Record<string, unknown>).error;
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'message' in value) {
    const msg = (value as Record<string, unknown>).message;
    if (typeof msg === 'string') {
      return msg;
    }
  }
  return 'Tool execution error';
}
