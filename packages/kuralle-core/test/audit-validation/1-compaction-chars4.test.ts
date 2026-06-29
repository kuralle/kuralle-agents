// FINDING 1: Compaction sizing uses chars/4 heuristic; TokenAccumulator is exported but never constructed | anchor src/runtime/ContextBudget.ts:65, src/runtime/TokenAccumulator.ts | why this proves it
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { estimateTokenCount } from '../../src/runtime/ContextBudget.js';

function walkTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...walkTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

function findTokenAccumulatorConstructorSites(srcRoot: string): string[] {
  const pattern = /new\s+TokenAccumulator\s*\(/g;
  const sites: string[] = [];
  for (const file of walkTsFiles(srcRoot)) {
    const content = readFileSync(file, 'utf8');
    if (pattern.test(content)) {
      sites.push(file);
    }
  }
  return sites;
}

describe('F1: compaction uses chars/4, TokenAccumulator unused', () => {
  it('estimateTokenCount uses Math.ceil(length / 4)', () => {
    const samples = ['', 'a', 'abcd', 'abcde', 'hello world', 'x'.repeat(100)];
    for (const text of samples) {
      const expected = text.length === 0 ? 0 : Math.ceil(text.length / 4);
      expect(estimateTokenCount(text)).toBe(expected);
    }
  });

  it('TokenAccumulator constructor appears nowhere in src outside its own file', () => {
    const srcRoot = join(import.meta.dirname, '../../src');
    const sites = findTokenAccumulatorConstructorSites(srcRoot);
    expect(sites).toEqual([]);
  });
});