import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

const repositoryRoot = resolve(import.meta.dir, '../../../..');
const packagesRoot = resolve(repositoryRoot, 'packages');
const hooksTypePath = resolve(packagesRoot, 'core/src/types/hooks.ts');
const coreIndexPath = resolve(packagesRoot, 'core/src/index.ts');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(filePath);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [filePath] : [];
  });
}

function hookMethods(): string[] {
  const source = readFileSync(hooksTypePath, 'utf8');
  const sourceFile = ts.createSourceFile(hooksTypePath, source, ts.ScriptTarget.Latest, true);
  const hooks = sourceFile.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === 'Hooks',
  );
  if (!hooks) throw new Error(`Hooks interface not found in ${hooksTypePath}`);
  return hooks.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || !member.name) return [];
    if (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) return [member.name.text];
    return [];
  });
}

test('every exported Hooks method has a source invocation site', () => {
  const coreIndex = readFileSync(coreIndexPath, 'utf8');
  expect(coreIndex).toContain("export type { Hooks } from './types/hooks.js';");

  const methods = hookMethods();
  expect(methods.length).toBeGreaterThan(0);
  const sources = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const sourceRoot = resolve(packagesRoot, entry.name, 'src');
      try {
        return sourceFiles(sourceRoot).map((filePath) => readFileSync(filePath, 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    });

  const unwired = methods.filter((method) => {
    const invocation = new RegExp(`(?:\\.|\\?\\.)${method}(?:\\?\\.)?\\s*\\(`);
    return !sources.some((source) => invocation.test(source));
  });

  expect(unwired).toEqual([]);
});
