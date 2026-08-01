import ts from 'typescript';
import type { BuildDiagnostic, BuildTarget } from './types.js';

const NODE_BUILTINS = /^(?:node:|fs$|path$|child_process$|worker_threads$|cluster$|net$|tls$|http2?$)/;

function exportedNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) names.add('default');
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) names.add(element.name.text);
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) names.add('default');
    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isVariableStatement(statement)
    ) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
        }
      } else if (statement.name) {
        names.add(statement.name.text);
      }
    }
  }
  return names;
}

export function analyzeModule(options: {
  sourceText: string;
  path: string;
  target: BuildTarget;
  requiredExports: readonly string[];
  allowedExports?: readonly string[];
}): { exports: Set<string>; diagnostics: BuildDiagnostic[] } {
  const source = ts.createSourceFile(
    options.path,
    options.sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  const diagnostics: BuildDiagnostic[] = parseDiagnostics.map((diagnostic: ts.Diagnostic) => ({
    severity: 'error',
    code: 'MODULE_EXPORT_INVALID',
    path: options.path,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  }));
  const exports = exportedNames(source);
  for (const required of options.requiredExports) {
    if (!exports.has(required)) {
      diagnostics.push({
        severity: 'error',
        code: 'MODULE_EXPORT_INVALID',
        path: options.path,
        message: `module must export ${required}`,
      });
    }
  }
  if (options.allowedExports) {
    const allowed = new Set(options.allowedExports);
    for (const name of exports) {
      if (!allowed.has(name)) {
        diagnostics.push({
          severity: 'error',
          code: 'MODULE_EXPORT_INVALID',
          path: options.path,
          message: `unsupported export ${name}`,
        });
      }
    }
  }
  if (options.target === 'cloudflare') {
    for (const statement of source.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        NODE_BUILTINS.test(statement.moduleSpecifier.text)
      ) {
        diagnostics.push({
          severity: 'error',
          code: 'TARGET_INCOMPATIBLE',
          path: options.path,
          message: `Cloudflare capability cannot import ${statement.moduleSpecifier.text}`,
        });
      }
    }
  }
  return { exports, diagnostics };
}
