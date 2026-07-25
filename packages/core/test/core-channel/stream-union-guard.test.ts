import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { PART_CHANNEL } from '../../src/types/stream.js';
import type { StreamPart, StreamChannel } from '../../src/types/stream.js';

const sourceRoot = resolve(import.meta.dir, '../../src');
const { done: omittedDone, ...missingDone } = PART_CHANNEL;
// @ts-expect-error The channel map must reject an omitted stream variant.
const incompleteChannelMap: Record<StreamPart['type'], StreamChannel> = missingDone;
void omittedDone;
void incompleteChannelMap;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('stream union ownership', () => {
  it('has exactly one stream-part union definition in core source', () => {
    const definitions = sourceFiles(sourceRoot).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      return /export\s+type\s+\w*StreamPart\s*=/.test(source)
        ? [relative(sourceRoot, path).replaceAll('\\', '/')]
        : [];
    });

    expect(definitions).toEqual(['types/stream.ts']);
  });
});
