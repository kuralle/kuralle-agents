export interface FinalResult {
  type: 'final';
  text: string;
  sources?: unknown;
  metadata?: Record<string, unknown>;
}

export function isFinalResult(result: unknown): result is FinalResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    'type' in result &&
    (result as { type?: unknown }).type === 'final' &&
    'text' in result &&
    typeof (result as { text?: unknown }).text === 'string'
  );
}
