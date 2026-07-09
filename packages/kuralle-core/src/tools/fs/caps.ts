export const MAX_READ_LINES = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const MAX_GREP_HITS = 200;
export const MAX_GREP_LINE_LEN = 500;
export const MAX_LIST_ENTRIES = 1000;
export const MAX_SHELL_OUTPUT_BYTES = 50 * 1024;

export function applyReadWindow(
  content: string,
  offset?: number,
  limit?: number,
): { content: string; truncated: boolean; note?: string } {
  const allLines = content.split('\n');
  let lines = allLines;
  let truncated = false;
  const notes: string[] = [];

  if (offset !== undefined && offset > 1) {
    lines = lines.slice(offset - 1);
    truncated = true;
  } else if (offset === 1) {
    lines = lines.slice(0);
  } else if (offset !== undefined && offset <= 0) {
    lines = [];
    truncated = true;
  }

  if (limit !== undefined && limit >= 0 && lines.length > limit) {
    lines = lines.slice(0, limit);
    truncated = true;
  }

  if (lines.length > MAX_READ_LINES) {
    lines = lines.slice(0, MAX_READ_LINES);
    truncated = true;
    notes.push(`truncated at ${MAX_READ_LINES} lines; use offset/limit`);
  }

  let result = lines.join('\n');

  if (result.length > MAX_READ_BYTES) {
    result = result.slice(0, MAX_READ_BYTES);
    truncated = true;
    if (!notes.some((n) => n.includes('bytes'))) {
      notes.push(`truncated at ${MAX_READ_BYTES} bytes; use offset/limit`);
    }
  }

  if (!truncated) {
    return { content: result, truncated: false };
  }

  const note =
    notes.length > 0 ? notes.join('; ') : 'truncated; use offset/limit';
  return { content: result, truncated: true, note };
}

export function capGrepHits<T extends { text: string }>(hits: T[]): {
  hits: T[];
  truncated: boolean;
} {
  const truncated = hits.length > MAX_GREP_HITS;
  const capped = hits.slice(0, MAX_GREP_HITS).map((hit) => {
    if (hit.text.length <= MAX_GREP_LINE_LEN) return hit;
    return {
      ...hit,
      text: `${hit.text.slice(0, MAX_GREP_LINE_LEN)}…`,
    };
  });
  return { hits: capped, truncated };
}

export function capList<T>(entries: T[]): {
  entries: T[];
  truncated: boolean;
} {
  const truncated = entries.length > MAX_LIST_ENTRIES;
  return { entries: entries.slice(0, MAX_LIST_ENTRIES), truncated };
}